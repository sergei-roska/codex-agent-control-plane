<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: checks existence of cache_* tables via
 * information_schema (MySQL) or pg_tables (PostgreSQL).
 * No Drupal container required.
 */
class DebugCacheState {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter to specific cache bin (e.g., default, render, config).")]
        ?string $bin = null,
        #[Schema(description: "Include estimated entry counts and stale record metrics.")]
        ?bool $include_size_estimate = false,
        #[Schema(description: "Include sample stale cache keys (CIDs).")]
        ?bool $include_stale_samples = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $prefix  = $this->adapter->getDbInfo()['prefix'] ?? '';
            if (is_array($prefix)) {
                $prefix = $prefix['default'] ?? '';
            }

            $driver = strtolower($this->adapter->getDbInfo()['driver'] ?? 'mysql');

            // Discover existing cache_* tables
            $binCandidates = $bin
                ? [$bin]
                : ['default', 'render', 'config', 'discovery', 'data', 'dynamic_page_cache', 'page', 'bootstrap'];

            $stats = [];
            foreach ($binCandidates as $b) {
                $tableName = $prefix . 'cache_' . $b;

                $exists = $this->tableExists($pdo, $tableName, $driver);
                if (!$exists) {
                    continue;
                }

                $stat = ['bin' => $b, 'table' => $tableName, 'status' => 'EXISTS'];

                if ($include_size_estimate) {
                    $countStmt = $pdo->query("SELECT COUNT(*) FROM $tableName");
                    $stat['entry_count'] = (int) $countStmt->fetchColumn();

                    $staleStmt = $pdo->prepare("SELECT COUNT(*) FROM $tableName WHERE expire <> 0 AND expire < :now");
                    $staleStmt->execute([':now' => time()]);
                    $stat['stale_count'] = (int) $staleStmt->fetchColumn();

                    if ($stat['entry_count'] > 0) {
                        $stat['invalidation_ratio'] = round($stat['stale_count'] / $stat['entry_count'], 4);
                    }

                    if ($include_stale_samples && $stat['stale_count'] > 0) {
                        $sampStmt = $pdo->prepare("SELECT cid FROM $tableName WHERE expire <> 0 AND expire < :now LIMIT 5");
                        $sampStmt->execute([':now' => time()]);
                        $stat['stale_samples'] = array_column($sampStmt->fetchAll(\PDO::FETCH_ASSOC), 'cid');
                    }
                }

                $stats[] = $stat;
            }

            return Envelope::ok(
                "Found " . count($stats) . " cache bin(s).",
                $stats,
                ['returned' => count($stats), 'total' => count($stats)],
                ['tool' => 'debug_cache_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_cache_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_cache_state'
            ]);
        }
    }

    private function tableExists(\PDO $pdo, string $table, string $driver): bool {
        try {
            if ($driver === 'pgsql') {
                $stmt = $pdo->prepare("SELECT 1 FROM pg_tables WHERE tablename = :t LIMIT 1");
                $stmt->execute([':t' => $table]);
            } else {
                $stmt = $pdo->prepare("SHOW TABLES LIKE :t");
                $stmt->execute([':t' => $table]);
            }
            return (bool) $stmt->fetch();
        } catch (\Exception $e) {
            return false;
        }
    }
}
