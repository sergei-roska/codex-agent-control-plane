<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugRuntimeHealth {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include domain-level breakdown (env, updates, cron)")]
        ?bool $include_domains = false,
        #[Schema(description: "Include actionable recommendations for any alerts")]
        ?bool $include_recommendations = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($include_domains !== null) $params['include_domains'] = $include_domains;
            if ($include_recommendations !== null) $params['include_recommendations'] = $include_recommendations;

            $php = <<<'PHP'
$env_data = ['drupal_version' => \Drupal::VERSION, 'maintenance_mode' => \Drupal::state()->get('system.maintenance_mode') ? 'ON' : 'OFF', 'php_version' => PHP_VERSION, 'db_driver' => \Drupal::database()->driver()];
$last_run = \Drupal::state()->get('system.cron_last');
$now = time();
$cron_status = !$last_run ? 'NEVER_RUN' : ($now - $last_run > 86400 ? 'STALE_OVER_24H' : 'OK');
$cron_data = ['last_run' => $last_run ? date('Y-m-d\TH:i:sP', $last_run) : null, 'status' => $cron_status];
$pending_schema = [];
try {
    $registry = \Drupal::service('update.update_hook_registry');
    foreach (array_keys(\Drupal::moduleHandler()->getModuleList()) as $m) {
        $available = $registry->getAvailableUpdates($m);
        if (empty($available)) continue;
        $installed = $registry->getInstalledVersion($m);
        if ($installed === -1) continue;
        $pend = array_values(array_filter($available, fn($v) => $v > $installed));
        if (!empty($pend)) $pending_schema[$m] = $pend;
    }
} catch (\Exception $e) {}
$entity_updates = false;
if (class_exists('\Drupal\Core\Entity\EntityDefinitionUpdateManager')) {
    $entity_updates = !empty(\Drupal::entityDefinitionUpdateManager()->getChangeSummary());
}
$updates_data = ['pending_schema_updates' => $pending_schema, 'pending_entity_updates' => $entity_updates];
$alerts = [];
$recommendations = [];
if ($env_data['maintenance_mode'] === 'ON') { $alerts[] = 'Site is in Maintenance Mode'; $recommendations[] = 'Take site out of maintenance mode when debugging is complete.'; }
if (!empty($pending_schema)) { $alerts[] = 'Pending DB schema updates'; $recommendations[] = 'Run drush updb to apply pending database updates.'; }
if ($entity_updates) { $alerts[] = 'Pending entity updates'; $recommendations[] = 'Apply entity updates via update hook.'; }
if ($cron_status !== 'OK') { $alerts[] = 'Cron status: ' . $cron_status; $recommendations[] = 'Ensure system cron is triggering Drupal cron regularly.'; }
$result = ['health_status' => empty($alerts) ? 'OK' : 'WARNING', 'alerts' => $alerts];
if (!empty($params['include_domains'])) $result['domains'] = ['env' => $env_data, 'updates' => $updates_data, 'cron' => $cron_data];
if (!empty($params['include_recommendations'])) $result['next_steps'] = $recommendations;
return $result;
PHP;

            $res = $this->adapter->evaluate($php, $params);

            return Envelope::ok(
                "Runtime health: " . ($res['health_status'] ?? 'unknown') . (empty($res['alerts']) ? '' : " — " . count($res['alerts']) . " alert(s)"),
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_runtime_health']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_runtime_health'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_runtime_health'
            ]);
        }
    }
}
