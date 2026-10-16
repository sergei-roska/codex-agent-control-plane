<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: reads cron state from `key_value` (collection=state)
 * and `semaphore` tables. No Drupal container required.
 *
 * key_value row: collection='state', name='system.cron_last', value=serialized timestamp
 * semaphore row: name='cron' — present when cron lock is held
 */
class DebugCronState {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include watchdog logs for recent cron runs.")]
        ?bool $include_recent_runs = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo      = $this->adapter->getPdo();
            $kvTable  = $this->adapter->table('key_value');
            $semTable = $this->adapter->table('semaphore');

            // Read last cron run from key_value state collection
            $lastRun  = null;
            $stmt     = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'system.cron_last' LIMIT 1");
            $stmt->execute();
            $row = $stmt->fetch();
            if ($row) {
                $lastRun = @unserialize((string) $row->value);
            }

            $now    = time();
            $status = 'OK';
            if (!$lastRun) {
                $status = 'NEVER_RUN';
            } elseif ($now - (int) $lastRun > 86400) {
                $status = 'STALE_OVER_24H';
            }

            // Check semaphore for active cron lock
            $isRunning = false;
            try {
                $stmt2 = $pdo->prepare("SELECT 1 FROM $semTable WHERE name = 'cron' LIMIT 1");
                $stmt2->execute();
                $isRunning = (bool) $stmt2->fetch();
            } catch (\Exception $e) {
                // semaphore table may not exist in all installations — not fatal
            }

            $data = [
                'last_run'   => $lastRun ? date('Y-m-d\TH:i:sP', (int) $lastRun) : null,
                'status'     => $status,
                'is_running' => $isRunning,
            ];

            // Optionally pull recent cron entries from watchdog
            if ($include_recent_runs) {
                $wdTable = $this->adapter->table('watchdog');
                try {
                    $wdStmt = $pdo->prepare("SELECT wid, message, variables, timestamp FROM $wdTable WHERE type = 'cron' ORDER BY wid DESC LIMIT 10");
                    $wdStmt->execute();
                    $recentRuns = [];
                    foreach ($wdStmt->fetchAll() as $wdRow) {
                        $vars = @unserialize((string) $wdRow->variables);
                        $msg  = Envelope::safeTranslate((string) $wdRow->message, $vars);
                        $recentRuns[] = [
                            'timestamp' => date('Y-m-d\TH:i:sP', (int) $wdRow->timestamp),
                            'message'   => $msg,
                        ];
                    }
                    $data['recent_runs'] = $recentRuns;
                } catch (\Exception $e) {
                    $data['recent_runs'] = [];
                }
            }

            return Envelope::ok(
                "Cron status: $status",
                [$data],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_cron_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_cron_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_cron_state'
            ]);
        }
    }
}
