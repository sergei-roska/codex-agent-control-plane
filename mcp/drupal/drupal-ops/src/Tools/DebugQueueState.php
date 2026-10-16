<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugQueueState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter results to a specific queue name")]
        ?string $queue_name = null,
        #[Schema(description: "Include count of currently claimed (in-progress) items")]
        ?bool $include_claimed = false,
        #[Schema(description: "Include samples of failed/stale items")]
        ?bool $include_failed_samples = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($queue_name !== null) $params['queue_name'] = $queue_name;
            if ($include_claimed !== null) $params['include_claimed'] = $include_claimed;
            if ($include_failed_samples !== null) $params['include_failed_samples'] = $include_failed_samples;

            $php = <<<'PHP'
$queue_name = $params['queue_name'] ?? null;
$query = \Drupal::database()->select('queue', 'q');
$query->addExpression('q.name', 'queue_name');
$query->addExpression('COUNT(q.item_id)', 'item_count');
$query->addExpression('MIN(q.created)', 'oldest_item_timestamp');
if (!empty($params['include_claimed'])) $query->addExpression('SUM(CASE WHEN q.expire > 0 THEN 1 ELSE 0 END)', 'claimed_count');
if ($queue_name) $query->condition('q.name', $queue_name);
$query->groupBy('q.name');
$results = [];
try {
    $records = $query->execute();
    foreach ($records as $row) {
        $oldest_age = $row->oldest_item_timestamp ? (time() - $row->oldest_item_timestamp) : 0;
        $data = ['queue_name' => (string)$row->queue_name, 'item_count' => (int)$row->item_count, 'oldest_item_age_seconds' => $oldest_age];
        if (!empty($params['include_claimed'])) $data['claimed_count'] = (int)$row->claimed_count;
        $results[] = $data;
    }
} catch (\Exception $e) { return ['error' => 'queue query failed', 'details' => $e->getMessage()]; }
return $results;
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $items = is_array($res) && !isset($res['error']) ? $res : [];

            return Envelope::ok(
                "Found " . count($items) . " queue(s).",
                $items,
                ['returned' => count($items), 'total' => count($items)],
                ['tool' => 'debug_queue_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_queue_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_queue_state'
            ]);
        }
    }
}
