<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * mirrored from drupal-db-ops for availability in config context; canonical SQL impl lives in drupal-db-ops.
 */
class DebugStateSystem {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Array of specific allowed state keys to retrieve.")]
        ?array $keys = null,
        #[Schema(description: "Retrieve keys starting with this prefix (must match allowed patterns).")]
        ?string $prefix = null,
        #[Schema(description: "Retrieve keys grouped by profile: 'cron', 'maintenance', or 'update'.")]
        ?string $allowlist_profile = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $allowlist = [
                'system.cron_last',
                'system.maintenance_mode',
                'node.type_settings',
                'install_profile',
                'install_time',
                'update_last_check',
                'update_last_email_notification'
            ];

            $profiles = [
                'cron' => ['system.cron_last'],
                'maintenance' => ['system.maintenance_mode'],
                'update' => ['update_last_check', 'update_last_email_notification']
            ];

            $targetKeys = $keys ?: [];
            
            if ($allowlist_profile && isset($profiles[$allowlist_profile])) {
                $targetKeys = array_merge($targetKeys, $profiles[$allowlist_profile]);
            }
            
            // Filter valid keys
            $validKeys = array_values(array_filter($targetKeys, function($k) use ($allowlist) {
                return in_array($k, $allowlist) || str_starts_with($k, 'system.');
            }));
            
            if (empty($validKeys) && !$prefix && !$allowlist_profile) {
                return Envelope::ok("No valid state keys provided or allowed.", [], [], [
                    'tool' => 'debug_state_system'
                ]);
            }
            
            $php = <<<PHP
\$valid_keys = \$params['validKeys'] ?? [];
\$prefix = \$params['prefix'] ?? null;
\$allowlist = \$params['allowlist'] ?? [];

\$results = [];
\$state = \\Drupal::state();

foreach (\$valid_keys as \$key) {
  \$val = \$state->get(\$key);
  \$results[\$key] = is_object(\$val) ? clone \$val : \$val;
}

if (\$prefix) {
  \$query = \\Drupal::database()->select('key_value', 'kv')
    ->fields('kv', ['name', 'value'])
    ->condition('collection', 'state')
    ->condition('name', \\Drupal::database()->escapeLike(\$prefix) . '%', 'LIKE')
    ->execute();
    
  foreach (\$query as \$row) {
    if (in_array(\$row->name, \$allowlist) || strpos(\$row->name, 'system.') === 0) {
      \$results[\$row->name] = @unserialize(\$row->value);
    }
  }
}
return \$results;
PHP;
            
            $results = $this->adapter->evaluate($php, [
                'validKeys' => $validKeys,
                'prefix' => $prefix,
                'allowlist' => $allowlist
            ]);
            
            $summary = (isset($results['error'])) ? 'Access denied or no valid keys.' : 'Retrieved state keys.';
            
            return Envelope::ok($summary, [$results], [], [
                'tool' => 'debug_state_system'
            ]);
        } catch (\Exception $e) {
            return Envelope::ok("State System: offline. Error: " . $e->getMessage(), [], [], [
                'tool' => 'debug_state_system'
            ]);
        }
    }
}
