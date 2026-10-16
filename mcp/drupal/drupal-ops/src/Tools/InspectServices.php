<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectServices {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Maximum number of services to return")]
        ?int $limit = 50,
        #[Schema(description: "Offset for pagination")]
        ?int $offset = null,
        #[Schema(description: "Filter services by ID substring or retrieve exact service by full ID")]
        ?string $query = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($limit !== null) $params['limit'] = $limit;
            if ($offset !== null) $params['offset'] = $offset;
            if ($query !== null) $params['query'] = $query;

            $php = <<<'PHP'
$container = \Drupal::getContainer();
$query_str = $params['query'] ?? '';
if ($query_str && $container->has($query_str)) {
    $ids = [$query_str];
} else {
    $ids = $container->getServiceIds();
    if ($query_str) $ids = array_filter($ids, fn($id) => strpos($id, $query_str) !== false);
}
$results = [];
foreach (array_values($ids) as $id) {
    $class = 'unknown';
    if ($container->has($id)) { try { $class = get_class($container->get($id)); } catch (\Exception $e) {} }
    $results[] = ['id' => $id, 'class' => $class];
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

            return Envelope::ok(
                "Found $total service(s).",
                $items,
                ['returned' => count($items), 'total' => $total],
                ['tool' => 'inspect_services']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_services'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_services'
            ]);
        }
    }
}
