<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectModules {
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
$active_modules = \Drupal::moduleHandler()->getModuleList();
$results = [];
$query_str = $params['query'] ?? '';
foreach ($active_modules as $name => $ext) {
    $info = \Drupal::service('extension.list.module')->getExtensionInfo($name);
    if ($query_str && strpos($name, $query_str) === false && strpos(strtolower($info['name'] ?? ''), strtolower($query_str)) === false) continue;
    $results[] = ['machine_name' => $name, 'name' => (string)($info['name'] ?? $name), 'version' => $info['version'] ?? 'unknown'];
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
                "Found $total enabled module(s).",
                $items,
                ['returned' => count($items), 'total' => $total],
                ['tool' => 'inspect_modules']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_modules'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_modules'
            ]);
        }
    }
}
