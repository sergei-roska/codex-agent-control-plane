<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

/**
 * SQL-only config drift detector. Compares all names in the `config` table
 * (active) against .yml files in config/sync directory.
 * No Drupal container required.
 *
 * Detects: added (in sync, not active), removed (in active, not sync),
 * changed (both present but different), identical.
 */
class DetectConfigDrift {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter config names by prefix (e.g., node.type.).")]
        ?string $prefix = null,
        // Shared Args
        ?int $limit = 50,
        ?int $offset = null,
        ?string $sort = null,
        ?string $sort_direction = 'ASC',
        ?string $query = null,
        ?string $verbosity = 'minimal',
        ?bool $summary_only = false,
        ?bool $exclude_noise = true,
        ?int $max_chars = 10000,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo      = $this->adapter->getPdo();
            $cfgTable = $this->adapter->table('config');
            $syncDir  = $this->adapter->findSyncDir();

            // Build set of active config names from DB
            $stmt = $pdo->query("SELECT name FROM $cfgTable");
            $activeNames = [];
            foreach ($stmt->fetchAll() as $row) {
                $activeNames[(string) $row->name] = true;
            }

            // Build set of sync config names from filesystem
            $syncNames = [];
            if ($syncDir && is_dir($syncDir)) {
                foreach (glob($syncDir . '/*.yml') ?: [] as $file) {
                    $name = basename($file, '.yml');
                    $syncNames[$name] = true;
                }
            }

            // All names combined
            $allNames = array_unique(array_merge(array_keys($activeNames), array_keys($syncNames)));

            $items = [];
            foreach ($allNames as $name) {
                // Apply prefix filter
                if ($prefix && strpos($name, $prefix) !== 0) {
                    continue;
                }

                $inActive = isset($activeNames[$name]);
                $inSync   = isset($syncNames[$name]);

                if ($inActive && !$inSync) {
                    $items[] = ['name' => $name, 'operation' => 'create'];
                } elseif (!$inActive && $inSync) {
                    $items[] = ['name' => $name, 'operation' => 'delete'];
                } elseif ($inActive && $inSync) {
                    // Compare content
                    $activeData = $this->readActiveData($pdo, $cfgTable, $name);
                    $syncData   = $this->readSyncData($syncDir, $name);
                    if (json_encode($activeData) !== json_encode($syncData)) {
                        $items[] = ['name' => $name, 'operation' => 'update'];
                    }
                    // 'identical' items are not drifting — omit them
                }
            }

            // Apply query filter
            if ($query) {
                $items = array_values(array_filter($items, fn($i) => stripos($i['name'], $query) !== false));
            }

            $totalCount = count($items);

            // Sort
            $sortField = $sort ?: 'name';
            usort($items, function ($a, $b) use ($sortField, $sort_direction) {
                $cmp = strcmp($a[$sortField] ?? '', $b[$sortField] ?? '');
                return ($sort_direction === 'DESC') ? -$cmp : $cmp;
            });

            // Paginate
            $offsetVal = $offset ?: 0;
            $items     = array_slice($items, $offsetVal);
            $limitVal  = $limit ?: 50;
            $items     = array_slice($items, 0, $limitVal);

            $data      = $summary_only ? [] : array_values($items);
            $truncated = false;

            if (!$summary_only && $max_chars) {
                $json = json_encode($data);
                if (strlen($json) > $max_chars) {
                    $truncated = true;
                    while (count($data) > 1 && strlen(json_encode($data)) > $max_chars) {
                        array_pop($data);
                    }
                }
            }

            return Envelope::ok(
                "Found $totalCount drifting config object(s).",
                $data,
                ['returned' => count($data), 'total' => $totalCount, 'truncated' => $truncated],
                ['tool' => 'detect_config_drift']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'detect_config_drift'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'detect_config_drift'
            ]);
        }
    }

    private function readActiveData(\PDO $pdo, string $table, string $name): array {
        $stmt = $pdo->prepare("SELECT data FROM $table WHERE name = :name LIMIT 1");
        $stmt->execute([':name' => $name]);
        $row = $stmt->fetch();
        if (!$row) return [];
        $data = @unserialize((string) $row->data);
        return is_array($data) ? $data : [];
    }

    private function readSyncData(?string $syncDir, string $name): array {
        if (!$syncDir) return [];
        $file = $syncDir . '/' . $name . '.yml';
        if (!file_exists($file)) return [];
        try {
            $data = Yaml::parseFile($file);
            return is_array($data) ? $data : [];
        } catch (\Exception $e) {
            return [];
        }
    }
}
