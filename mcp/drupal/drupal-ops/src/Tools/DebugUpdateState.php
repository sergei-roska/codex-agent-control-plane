<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugUpdateState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include details of pending update hooks")]
        ?bool $include_pending = false,
        #[Schema(description: "Include details of failed update hooks")]
        ?bool $include_failed = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($include_pending !== null) $params['include_pending'] = $include_pending;
            if ($include_failed !== null) $params['include_failed'] = $include_failed;

            $php = <<<'PHP'
$data = ['pending_schema_updates' => [], 'pending_entity_updates' => false];
$registry = \Drupal::service('update.update_hook_registry');
$details = [];
foreach (array_keys(\Drupal::moduleHandler()->getModuleList()) as $module) {
    $available = $registry->getAvailableUpdates($module);
    if (empty($available)) continue;
    $installed = $registry->getInstalledVersion($module);
    if ($installed === -1) continue;
    $pending_numbers = array_values(array_filter($available, function($v) use ($installed) { return $v > $installed; }));
    if (!empty($pending_numbers)) {
        $data['pending_schema_updates'][$module] = $pending_numbers;
        $details[$module] = ['pending' => array_fill_keys($pending_numbers, '')];
    }
}
if (class_exists('\Drupal\Core\Entity\EntityDefinitionUpdateManager')) {
    $change_summary = \Drupal::entityDefinitionUpdateManager()->getChangeSummary();
    $data['pending_entity_updates'] = !empty($change_summary);
}
if (!empty($params['include_pending'])) $data['details'] = $details;
return $data;
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $pendingCount = count($res['pending_schema_updates'] ?? []);
            $hasEntityUpdates = !empty($res['pending_entity_updates']);

            $summary = $pendingCount === 0 && !$hasEntityUpdates
                ? "No pending updates."
                : "Pending updates: $pendingCount module(s)" . ($hasEntityUpdates ? ", entity updates required" : "");

            return Envelope::ok(
                $summary,
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_update_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_update_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_update_state'
            ]);
        }
    }
}
