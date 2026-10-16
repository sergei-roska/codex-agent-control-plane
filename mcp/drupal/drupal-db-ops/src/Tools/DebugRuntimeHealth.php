<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only health check aggregator. Composes results from individual SQL
 * reads without invoking any other Tool classes to avoid double-connection
 * overhead. No Drupal container required.
 */
class DebugRuntimeHealth {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include status details per domain (env, updates, cron).")]
        ?bool $include_domains = false,
        #[Schema(description: "Include suggested actions for warnings/errors.")]
        ?bool $include_recommendations = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $dbInfo  = $this->adapter->getDbInfo();
            $kvTable = $this->adapter->table('key_value');

            // --- Environment ---
            $maintenanceMode = 'OFF';
            $stmt = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'system.maintenance_mode' LIMIT 1");
            $stmt->execute();
            $row = $stmt->fetch();
            if ($row) {
                $maintenanceMode = @unserialize((string) $row->value) ? 'ON' : 'OFF';
            }

            $drupalVersion = 'unknown';
            $drupalPhp = $this->adapter->getDrupalRoot() . '/core/lib/Drupal.php';
            if (file_exists($drupalPhp)) {
                $content = file_get_contents($drupalPhp);
                if (preg_match("/const\s+VERSION\s*=\s*'([^']+)'/", $content, $m)) {
                    $drupalVersion = $m[1];
                }
            }

            $envData = [
                'drupal_version'   => $drupalVersion,
                'maintenance_mode' => $maintenanceMode,
                'php_version'      => PHP_VERSION,
                'db_driver'        => $dbInfo['driver'] ?? 'unknown',
            ];

            // --- Cron ---
            $lastRun  = null;
            $cronStmt = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'system.cron_last' LIMIT 1");
            $cronStmt->execute();
            $cronRow = $cronStmt->fetch();
            if ($cronRow) {
                $lastRun = @unserialize((string) $cronRow->value);
            }
            $now        = time();
            $cronStatus = !$lastRun ? 'NEVER_RUN' : (($now - (int) $lastRun > 86400) ? 'STALE_OVER_24H' : 'OK');
            $cronData   = [
                'last_run' => $lastRun ? date('Y-m-d\TH:i:sP', (int) $lastRun) : null,
                'status'   => $cronStatus,
            ];

            // --- Updates ---
            $schemaStmt = $pdo->prepare("SELECT COUNT(*) FROM $kvTable WHERE collection = 'system.schema'");
            $schemaStmt->execute();
            $installedCount = (int) $schemaStmt->fetchColumn();

            $updatesData = [
                'installed_modules'       => $installedCount,
                'pending_schema_updates'  => 'unknown (use debug_update_state with include_pending=true)',
                'pending_entity_updates'  => 'unknown (requires container)',
            ];

            // --- Assemble alerts ---
            $alerts          = [];
            $recommendations = [];

            if ($maintenanceMode === 'ON') {
                $alerts[]          = 'Site is in Maintenance Mode';
                $recommendations[] = 'Take site out of maintenance mode when debugging is complete.';
            }
            if ($cronStatus !== 'OK') {
                $alerts[]          = "Cron status: $cronStatus";
                $recommendations[] = 'Ensure system cron is triggering Drupal cron regularly.';
            }

            $result = [
                'health_status' => empty($alerts) ? 'OK' : 'WARNING',
                'alerts'        => $alerts,
            ];

            if ($include_domains) {
                $result['domains'] = [
                    'env'     => $envData,
                    'updates' => $updatesData,
                    'cron'    => $cronData,
                ];
            }
            if ($include_recommendations) {
                $result['next_steps'] = $recommendations;
            }

            $alertCount = count($alerts);
            return Envelope::ok(
                "Runtime health: " . $result['health_status'] . ($alertCount ? " — $alertCount alert(s)" : ''),
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_runtime_health']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_runtime_health'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_runtime_health'
            ]);
        }
    }
}
