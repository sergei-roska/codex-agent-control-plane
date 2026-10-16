<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectRoutes {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Maximum number of routes to return")]
        ?int $limit = 50,
        #[Schema(description: "Offset for pagination")]
        ?int $offset = null,
        #[Schema(description: "Filter by route name substring, path substring, or exact path (starting with /)")]
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
$query_str = $params['query'] ?? '';
$results = [];
if ($query_str && $query_str[0] === '/') {
    try {
        $router = \Drupal::hasService('router.no_access_checks') ? \Drupal::service('router.no_access_checks') : \Drupal::service('router.route_provider');
        if (method_exists($router, 'match')) {
            $match = $router->match($query_str);
            if ($match && isset($match['_route'])) {
                $routeName = $match['_route'];
                $routeObj = $match['_route_object'] ?? \Drupal::service('router.route_provider')->getRouteByName($routeName);
                $results[] = ['route_name' => $routeName, 'path' => $routeObj->getPath(), 'controller' => $routeObj->getDefault('_controller') ?? $routeObj->getDefault('_form') ?? 'unknown', 'requirements' => $routeObj->getRequirements()];
            }
        }
    } catch (\Exception $e) {}
}
if (empty($results)) {
    $routes = \Drupal::service('router.route_provider')->getAllRoutes();
    $count = 0;
    foreach ($routes as $name => $route) {
        if ($query_str && strpos($name, $query_str) === false && strpos($route->getPath(), $query_str) === false) continue;
        $results[] = ['route_name' => $name, 'path' => $route->getPath(), 'controller' => $route->getDefault('_controller') ?? $route->getDefault('_form') ?? 'unknown', 'requirements' => $route->getRequirements()];
        if (++$count >= 500) break;
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

            return Envelope::ok(
                "Found $total route(s).",
                $items,
                ['returned' => count($items), 'total' => $total],
                ['tool' => 'inspect_routes']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_routes'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_routes'
            ]);
        }
    }
}
