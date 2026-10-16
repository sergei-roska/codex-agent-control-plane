<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class SearchRuntimeObjects {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Search term to match across entity types, modules, and routes. Leave empty to return a broad sample from all registries.")]
        string $query = '',
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = ['query' => $query];

            $php = <<<'PHP'
$q = $params['query'] ?? '';
$results = ['entity_types' => [], 'modules' => [], 'routes' => []];
$defs = \Drupal::entityTypeManager()->getDefinitions();
foreach ($defs as $id => $type) {
    if (strpos($id, $q) !== false) $results['entity_types'][] = ['id' => $id, 'label' => (string)$type->getLabel()];
    if (count($results['entity_types']) >= 5) break;
}
$modules = \Drupal::moduleHandler()->getModuleList();
foreach ($modules as $name => $ext) {
    if (strpos($name, $q) !== false) $results['modules'][] = $name;
    if (count($results['modules']) >= 5) break;
}
$routes = \Drupal::service('router.route_provider')->getAllRoutes();
$rcount = 0;
foreach ($routes as $name => $route) {
    if (strpos($name, $q) !== false || strpos($route->getPath(), $q) !== false) { $results['routes'][] = ['route_name' => $name, 'path' => $route->getPath()]; if (++$rcount >= 5) break; }
}
return $results;
PHP;

            $res = $this->adapter->evaluate($php, $params);

            $totalFound = count($res['entity_types'] ?? []) + count($res['modules'] ?? []) + count($res['routes'] ?? []);

            $label = $query !== '' ? "query '$query'" : 'all registries (no filter)';
            return Envelope::ok(
                "Found $totalFound matching runtime objects for $label.",
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'search_runtime_objects']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'search_runtime_objects'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'search_runtime_objects'
            ]);
        }
    }
}
