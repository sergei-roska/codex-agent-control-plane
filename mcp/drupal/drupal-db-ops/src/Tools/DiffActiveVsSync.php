<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

/**
 * SQL-only diff: reads a single config object from the `config` table (active)
 * and the corresponding .yml file from config/sync, then compares them.
 * No Drupal container required.
 */
class DiffActiveVsSync {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the config object to compare.")]
        string $config_name,
        #[Schema(description: "Include raw data representation of both sides.")]
        bool $include_patch = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            // Read active from config table
            $activeData = null;
            $inspector  = new InspectConfigObject($this->adapter);
            $activeRow  = $inspector->readFromDb($config_name);
            if ($activeRow) {
                $activeData = $activeRow['data'] ?? [];
            }

            // Read sync from filesystem
            $syncData = $inspector->readFromSync($config_name);

            // Determine status
            if (!$activeData && !$syncData) {
                $status = 'missing_both';
                $changedKeys = [];
                $risk = 'low';
            } elseif (!$activeData) {
                $status = 'added';
                $changedKeys = is_array($syncData) ? array_keys($syncData) : [];
                $risk = 'low';
            } elseif (!$syncData) {
                $status = 'removed';
                $changedKeys = array_keys($activeData);
                $risk = 'high';
            } else {
                $changedKeys = $this->getChangedKeys($activeData, $syncData);
                $status      = empty($changedKeys) ? 'identical' : 'changed';
                $risk        = $this->assessRisk($config_name, $changedKeys);
            }

            $result = [
                'name'         => $config_name,
                'status'       => $status,
                'changed_keys' => $changedKeys,
                'risk_level'   => $risk,
                'method'       => 'pdo',
            ];

            if ($include_patch && $status === 'changed') {
                $result['patch'] = json_encode(['active' => $activeData, 'sync' => $syncData], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
            }

            return Envelope::ok(
                "Diff for $config_name. Status: $status.",
                [$result],
                [],
                ['tool' => 'diff_active_vs_sync']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'diff_active_vs_sync'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'diff_active_vs_sync'
            ]);
        }
    }

    private function getChangedKeys(array $a, array $b): array {
        $keys    = array_unique(array_merge(array_keys($a), array_keys($b)));
        $changed = [];
        foreach ($keys as $k) {
            $valA = isset($a[$k]) ? json_encode($a[$k]) : null;
            $valB = isset($b[$k]) ? json_encode($b[$k]) : null;
            if ($valA !== $valB) {
                $changed[] = $k;
            }
        }
        return $changed;
    }

    private function assessRisk(string $name, array $keys): string {
        if ($name === 'system.site' || $name === 'core.extension') return 'high';
        if (str_starts_with($name, 'field.storage.') || str_starts_with($name, 'node.type.')) return 'high';
        if (in_array('dependencies', $keys, true)) return 'medium';
        return 'low';
    }
}
