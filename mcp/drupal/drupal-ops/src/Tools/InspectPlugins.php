<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectPlugins {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        // Shared Args
        ?int $limit = 50,
        ?int $offset = null,
        ?string $query = null,
        ?string $verbosity = null,
        ?bool $summary_only = false,
        ?bool $exclude_noise = false,
        ?int $max_chars = null,
        ?string $sort = null,
        ?string $sort_direction = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($limit !== null) $params['limit'] = $limit;
            if ($offset !== null) $params['offset'] = $offset;
            if ($query !== null) $params['query'] = $query;

            $php = <<<'PHP'
$query_str = $params['query'] ?? '';
$managers = ['block' => 'plugin.manager.block', 'filter' => 'plugin.manager.filter', 'condition' => 'plugin.manager.condition', 'queue' => 'plugin.manager.queue.worker'];
$results = [];
foreach ($managers as $type => $service_id) {
    if (!\Drupal::hasService($service_id)) continue;
    $all = \Drupal::service($service_id)->getDefinitions();
    foreach ($all as $id => $def) {
        if ($query_str && strpos($id, $query_str) === false) continue;
        $results[] = ['plugin_type' => $type, 'plugin_id' => $id, 'label' => (string)($def['admin_label'] ?? $def['label'] ?? $id), 'class' => $def['class'] ?? 'unknown'];
    }
}
$total = count($results);
$limit = (int)($params['limit'] ?? 50);
$offset = (int)($params['offset'] ?? 0);
$items = array_slice($results, $offset, $limit);
return ['items' => $items, 'total' => $total];
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $items = $res['items'] ?? [];
            $total = $res['total'] ?? 0;

            if ($summary_only) {
                $items = [];
            }

            return Envelope::ok(
                "Found $total plugin(s).",
                $items,
                ['returned' => count($items), 'total' => $total],
                ['tool' => 'inspect_plugins']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_plugins'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_plugins'
            ]);
        }
    }
}
