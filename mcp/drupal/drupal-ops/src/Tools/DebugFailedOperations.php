<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugFailedOperations {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Return failures since this datetime (e.g. -24 hours, 2026-01-01)")]
        ?string $since = null,
        #[Schema(description: "Watchdog severity threshold (0=Emergency..3=Error). Entries at or below this level are included.")]
        ?int $severity_threshold = 3,
        #[Schema(description: "Domains to scan: watchdog, queues, updates, cron")]
        ?array $domains = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($since !== null) $params['since'] = $since;
            if ($severity_threshold !== null) $params['severity_threshold'] = $severity_threshold;
            if ($domains !== null) $params['domains'] = $domains;

            $php = <<<'PHP'
$domains = $params['domains'] ?? ['watchdog', 'queues', 'updates', 'cron'];
$severity_threshold = $params['severity_threshold'] ?? 3;
$since_ts = !empty($params['since']) ? strtotime($params['since']) : null;
$failures = [];
if (in_array('watchdog', $domains)) {
    $q = \Drupal::database()->select('watchdog', 'w')->fields('w', ['wid', 'type', 'message', 'variables', 'severity', 'timestamp']);
    $q->condition('severity', $severity_threshold, '<=');
    if ($since_ts) $q->condition('timestamp', $since_ts, '>=');
    $q->orderBy('wid', 'DESC')->range(0, 20);
    try {
        foreach ($q->execute() as $row) {
            $vars = @unserialize($row->variables);
            $msg = is_array($vars) ? strip_tags(strtr($row->message, $vars)) : $row->message;
            $failures[] = ['domain' => 'watchdog', 'timestamp' => date('Y-m-d\TH:i:sP', $row->timestamp), 'message' => $msg, 'type' => $row->type];
        }
    } catch (\Exception $e) {}
}
if (in_array('updates', $domains)) {
    try {
        $registry = \Drupal::service('update.update_hook_registry');
        $pending = [];
        foreach (array_keys(\Drupal::moduleHandler()->getModuleList()) as $m) {
            $available = $registry->getAvailableUpdates($m);
            if (empty($available)) continue;
            $installed = $registry->getInstalledVersion($m);
            if ($installed === -1) continue;
            $pend = array_values(array_filter($available, fn($v) => $v > $installed));
            if (!empty($pend)) $pending[$m] = $pend;
        }
        if (!empty($pending)) $failures[] = ['domain' => 'updates', 'message' => 'Pending schema updates detected.', 'details' => $pending];
        if (class_exists('\Drupal\Core\Entity\EntityDefinitionUpdateManager') && !empty(\Drupal::entityDefinitionUpdateManager()->getChangeSummary())) {
            $failures[] = ['domain' => 'updates', 'message' => 'Pending entity updates detected.'];
        }
    } catch (\Exception $e) {}
}
if (in_array('cron', $domains)) {
    $last_run = \Drupal::state()->get('system.cron_last');
    $cron_status = !$last_run ? 'NEVER_RUN' : (time() - $last_run > 86400 ? 'STALE_OVER_24H' : 'OK');
    if ($cron_status !== 'OK') $failures[] = ['domain' => 'cron', 'message' => 'Cron status: ' . $cron_status, 'last_run' => $last_run ? date('Y-m-d\TH:i:sP', $last_run) : null];
}
if (in_array('queues', $domains)) {
    try {
        $q = \Drupal::database()->select('queue', 'q');
        $q->addExpression('q.name', 'queue_name');
        $q->addExpression('COUNT(q.item_id)', 'item_count');
        $q->addExpression('MIN(q.created)', 'oldest_item_timestamp');
        $q->groupBy('q.name');
        foreach ($q->execute() as $row) {
            if ($row->oldest_item_timestamp && (time() - $row->oldest_item_timestamp) > 86400) {
                $failures[] = ['domain' => 'queues', 'message' => 'Queue ' . $row->queue_name . ' has items older than 24 hours.'];
            }
        }
    } catch (\Exception $e) {}
}
return ['total_failures' => count($failures), 'failures' => $failures];
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $totalFailures = $res['total_failures'] ?? 0;

            return Envelope::ok(
                "Found $totalFailures failure(s) across scanned domains.",
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_failed_operations']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_failed_operations'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_failed_operations'
            ]);
        }
    }
}
