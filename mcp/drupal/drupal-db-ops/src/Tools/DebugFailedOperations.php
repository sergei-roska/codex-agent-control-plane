<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only cross-domain failure scanner. Scans watchdog (errors), queue backlogs,
 * and cron state entirely via PDO. No Drupal container required.
 *
 * NOTE: Schema/entity update detection in this context is limited to DB schema
 * version reads from key_value (no UpdateRegistry service available).
 */
class DebugFailedOperations {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter logs since datetime (e.g., -24 hours, 2026-01-01).")]
        ?string $since = null,
        #[Schema(description: "Max watchdog severity level to report (0=Emergency to 3=Error).")]
        ?int $severity_threshold = 3,
        #[Schema(description: "Specific domains to scan: watchdog, queues, cron.")]
        ?array $domains = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $domains = $domains ?? ['watchdog', 'queues', 'cron'];
            $sinceTs = ($since !== null) ? strtotime($since) : null;
            $sevThreshold = $severity_threshold ?? 3;

            $failures = [];

            // --- Watchdog errors ---
            if (in_array('watchdog', $domains, true)) {
                $wdTable = $this->adapter->table('watchdog');
                try {
                    $sql    = "SELECT wid, type, message, variables, severity, timestamp FROM $wdTable WHERE severity <= :sev";
                    $params = [':sev' => $sevThreshold];
                    if ($sinceTs !== false && $sinceTs !== null) {
                        $sql .= " AND timestamp >= :since";
                        $params[':since'] = $sinceTs;
                    }
                    $sql .= " ORDER BY wid DESC LIMIT 20";

                    $stmt = $pdo->prepare($sql);
                    $stmt->execute($params);
                    foreach ($stmt->fetchAll() as $row) {
                        $vars = @unserialize((string) $row->variables);
                        $msg  = Envelope::safeTranslate((string) $row->message, $vars);
                        $failures[] = [
                            'domain'    => 'watchdog',
                            'timestamp' => date('Y-m-d\TH:i:sP', (int) $row->timestamp),
                            'message'   => $msg,
                            'type'      => (string) $row->type,
                            'severity'  => (int) $row->severity,
                        ];
                    }
                } catch (\Exception $e) {
                    $failures[] = ['domain' => 'watchdog', 'error' => $e->getMessage()];
                }
            }

            // --- Queue backlog (items older than 24 h) ---
            if (in_array('queues', $domains, true)) {
                $qTable = $this->adapter->table('queue');
                try {
                    $stmt = $pdo->query("SELECT name, COUNT(item_id) AS cnt, MIN(created) AS oldest FROM $qTable GROUP BY name");
                    foreach ($stmt->fetchAll() as $row) {
                        $age = $row->oldest ? ($time = time()) - (int) $row->oldest : 0;
                        if ($age > 86400) {
                            $failures[] = [
                                'domain'  => 'queues',
                                'message' => "Queue {$row->name} has {$row->cnt} item(s) older than 24 hours.",
                                'queue'   => $row->name,
                                'count'   => (int) $row->cnt,
                            ];
                        }
                    }
                } catch (\Exception $e) {
                    $failures[] = ['domain' => 'queues', 'error' => $e->getMessage()];
                }
            }

            // --- Cron staleness ---
            if (in_array('cron', $domains, true)) {
                $kvTable = $this->adapter->table('key_value');
                try {
                    $stmt = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'system.cron_last' LIMIT 1");
                    $stmt->execute();
                    $row     = $stmt->fetch();
                    $lastRun = $row ? @unserialize((string) $row->value) : null;
                    $cronStatus = !$lastRun ? 'NEVER_RUN' : ((time() - (int) $lastRun > 86400) ? 'STALE_OVER_24H' : 'OK');
                    if ($cronStatus !== 'OK') {
                        $failures[] = [
                            'domain'   => 'cron',
                            'message'  => "Cron status: $cronStatus",
                            'last_run' => $lastRun ? date('Y-m-d\TH:i:sP', (int) $lastRun) : null,
                        ];
                    }
                } catch (\Exception $e) {
                    $failures[] = ['domain' => 'cron', 'error' => $e->getMessage()];
                }
            }

            $total = count($failures);
            return Envelope::ok(
                "Found $total failure(s) across scanned domains.",
                [['total_failures' => $total, 'failures' => $failures]],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_failed_operations']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_failed_operations'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_failed_operations'
            ]);
        }
    }
}
