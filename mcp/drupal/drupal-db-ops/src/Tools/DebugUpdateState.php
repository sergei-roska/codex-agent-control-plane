<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: reads the `key_value` table collection
 * `system.schema` to determine installed module schema versions and detect
 * pending update hooks by comparing them to declared hook numbers in info files.
 *
 * NOTE: This implementation intentionally does NOT call UpdateRegistry service
 * (which requires \Drupal container). Instead it reads raw key_value rows
 * and compares against hook numbers found in .install files via regex scan.
 * No Drupal container required.
 */
class DebugUpdateState {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Scan files to detect pending database update hooks.")]
        ?bool $include_pending = false,
        #[Schema(description: "Include detection of update failures.")]
        ?bool $include_failed = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $kvTable = $this->adapter->table('key_value');

            // Read installed schema versions: collection='system.schema', name=module, value=schema_version
            $stmt = $pdo->prepare("SELECT name, value FROM $kvTable WHERE collection = 'system.schema'");
            $stmt->execute();
            $rows = $stmt->fetchAll();

            $installedVersions = [];
            foreach ($rows as $row) {
                $val = @unserialize((string) $row->value);
                $installedVersions[(string) $row->name] = is_int($val) ? $val : (int) $val;
            }

            // Also read the modules list to know which are enabled
            $sysTable = $this->adapter->table('key_value');
            $coreExtStmt = $pdo->prepare("SELECT value FROM $sysTable WHERE collection = 'state' AND name = 'system.module.files' LIMIT 1");
            $coreExtStmt->execute();
            $modulesRow = $coreExtStmt->fetch();

            $data = [
                'installed_module_count' => count($installedVersions),
                'pending_schema_updates' => [],
                'pending_entity_updates' => false, // Not detectable without container
            ];

            // Scan .install files in the Drupal root for declared hook_update_N numbers
            $pending = [];
            if ($include_pending) {
                $drupalRoot = $this->adapter->getDrupalRoot();
                $pending = $this->detectPendingUpdates($drupalRoot, $installedVersions);
                $data['pending_schema_updates'] = $pending;
                $data['pending_schema_module_count'] = count($pending);
            } else {
                $data['pending_schema_updates'] = array_keys($installedVersions); // Just module names
                $data['note'] = 'Pass include_pending=true for per-module update hook analysis (filesystem scan).';
            }

            $summary = count($pending) === 0 && $include_pending
                ? "No pending schema updates detected."
                : "Checked " . count($installedVersions) . " module(s) schema versions.";

            return Envelope::ok(
                $summary,
                [$data],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_update_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_update_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_update_state'
            ]);
        }
    }

    /**
     * Scan .install files to find hook_update_N declarations higher than installed version.
     */
    private function detectPendingUpdates(string $drupalRoot, array $installedVersions): array {
        $pending = [];

        foreach ($installedVersions as $module => $installedVersion) {
            // Look for the .install file in common locations
            $candidates = [
                "$drupalRoot/modules/contrib/$module/$module.install",
                "$drupalRoot/modules/custom/$module/$module.install",
                "$drupalRoot/core/modules/$module/$module.install",
                "$drupalRoot/profiles/*/$module/$module.install",
            ];

            foreach ($candidates as $pattern) {
                $files = glob($pattern) ?: [];
                foreach ($files as $file) {
                    if (!is_readable($file)) continue;
                    $content = file_get_contents($file);
                    preg_match_all('/function\s+' . preg_quote($module, '/') . '_update_(\d+)\s*\(/', $content, $matches);
                    if (empty($matches[1])) continue;
                    $hookNumbers = array_map('intval', $matches[1]);
                    $available   = array_filter($hookNumbers, fn($n) => $n > $installedVersion);
                    if (!empty($available)) {
                        $pending[$module] = array_values($available);
                    }
                }
            }
        }

        return $pending;
    }
}
