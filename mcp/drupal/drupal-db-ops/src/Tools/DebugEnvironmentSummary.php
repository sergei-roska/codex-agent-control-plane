<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: reads connection driver introspection data from
 * PDO and key_value state for maintenance mode. Reads Drupal version from
 * the `system` table (D10+: core.extension config row).
 * No Drupal container required.
 */
class DebugEnvironmentSummary {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include PHP, database server, host, and client versions.")]
        ?bool $include_runtime_versions = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $dbInfo  = $this->adapter->getDbInfo();
            $kvTable = $this->adapter->table('key_value');

            // Read maintenance mode from key_value state
            $maintStmt = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'system.maintenance_mode' LIMIT 1");
            $maintStmt->execute();
            $maintRow = $maintStmt->fetch();
            $maintenanceMode = $maintRow ? (@unserialize((string) $maintRow->value) ? 'ON' : 'OFF') : 'OFF';

            // Try to read Drupal version from config table
            $drupalVersion = 'unknown';
            try {
                $cfgTable  = $this->adapter->table('config');
                $verStmt   = $pdo->prepare("SELECT data FROM $cfgTable WHERE name = 'system.site' LIMIT 1");
                $verStmt->execute();
                $verRow = $verStmt->fetch();
                if ($verRow) {
                    $siteConfig = @unserialize((string) $verRow->data);
                    // Drupal core version is not stored in config — try core_extension
                }

                // Try reading from key_value install profile as a proxy
                $installStmt = $pdo->prepare("SELECT value FROM $kvTable WHERE collection = 'state' AND name = 'install_time' LIMIT 1");
                $installStmt->execute();
                // Version not stored in DB natively, read from core/lib/Drupal.php if available
                $drupalPhp = $this->adapter->getDrupalRoot() . '/core/lib/Drupal.php';
                if (file_exists($drupalPhp)) {
                    $content = file_get_contents($drupalPhp);
                    if (preg_match("/const\s+VERSION\s*=\s*'([^']+)'/", $content, $m)) {
                        $drupalVersion = $m[1];
                    }
                }
            } catch (\Exception $e) {
                // Non-fatal — version stays 'unknown'
            }

            $data = [
                'drupal_version'   => $drupalVersion,
                'maintenance_mode' => $maintenanceMode,
            ];

            if ($include_runtime_versions) {
                $data['php_version']   = PHP_VERSION;
                $data['db_driver']     = $dbInfo['driver'] ?? 'unknown';
                $data['db_host']       = $dbInfo['host'] ?? 'unknown';
                $data['db_name']       = $dbInfo['database'] ?? 'unknown';
                $data['db_port']       = $dbInfo['port'] ?? 'default';
                $data['pdo_server_version'] = $pdo->getAttribute(\PDO::ATTR_SERVER_VERSION);
            }

            return Envelope::ok(
                "Drupal $drupalVersion | Maintenance: $maintenanceMode",
                [$data],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_environment_summary']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_environment_summary'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_environment_summary'
            ]);
        }
    }
}
