<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectThemes {
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
$handler = \Drupal::service('theme_handler');
$active = \Drupal::config('system.theme')->get('default');
$admin = \Drupal::config('system.theme')->get('admin');
$query_str = $params['query'] ?? '';
$results = [];
foreach ($handler->listInfo() as $name => $info) {
    if ($query_str && strpos($name, $query_str) === false && strpos(strtolower($info->info['name'] ?? ''), strtolower($query_str)) === false) continue;
    $results[] = [
        'machine_name' => $name,
        'name' => (string)($info->info['name'] ?? $name),
        'is_default' => $name === $active,
        'is_admin' => $name === $admin,
        'status' => $info->status ? 'enabled' : 'disabled',
    ];
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
                "Found $total installed theme(s).",
                $items,
                ['returned' => count($items), 'total' => $total],
                ['tool' => 'inspect_themes']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_themes'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_themes'
            ]);
        }
    }
}
