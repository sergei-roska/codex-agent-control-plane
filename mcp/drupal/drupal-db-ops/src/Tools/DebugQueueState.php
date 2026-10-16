<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: queries the `queue` table directly via PDO.
 * No Drupal container required.
 */
class DebugQueueState {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter to specific queue.")]
        ?string $queue_name = null,
        #[Schema(description: "Include count of active/claimed in-progress items.")]
        ?bool $include_claimed = false,
        #[Schema(description: "Include sample records of failed or stale queue items.")]
        ?bool $include_failed_samples = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo   = $this->adapter->getPdo();
            $table = $this->adapter->table('queue');

            $claimedExpr = $include_claimed
                ? ", SUM(CASE WHEN expire > 0 THEN 1 ELSE 0 END) AS claimed_count"
                : "";

            $sql    = "SELECT name AS queue_name, COUNT(item_id) AS item_count, MIN(created) AS oldest_item_timestamp$claimedExpr FROM $table";
            $params = [];

            if ($queue_name !== null) {
                $sql .= " WHERE name = :queue_name";
                $params[':queue_name'] = $queue_name;
            }

            $sql .= " GROUP BY name ORDER BY item_count DESC";

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();

            $items = [];
            $now   = time();
            foreach ($rows as $row) {
                $oldestAge = $row->oldest_item_timestamp ? ($now - (int) $row->oldest_item_timestamp) : 0;
                $entry = [
                    'queue_name'            => (string) $row->queue_name,
                    'item_count'            => (int)    $row->item_count,
                    'oldest_item_age_seconds' => $oldestAge,
                ];
                if ($include_claimed) {
                    $entry['claimed_count'] = (int) ($row->claimed_count ?? 0);
                }
                $items[] = $entry;
            }

            return Envelope::ok(
                "Found " . count($items) . " queue(s).",
                $items,
                ['returned' => count($items), 'total' => count($items)],
                ['tool' => 'debug_queue_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_queue_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_queue_state'
            ]);
        }
    }
}
