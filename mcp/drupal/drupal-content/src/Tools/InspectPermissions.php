<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectPermissions {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
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
            $escapedQuery = $query ? addslashes($query) : '';
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$all = \\Drupal::service('user.permissions')->getPermissions();
\$results = [];
\$query = '$escapedQuery';
foreach (\$all as \$name => \$info) {
    \$title = isset(\$info['title']) ? (string)\$info['title'] : \$name;
    if (\$query && strpos(\$name, \$query) === false && strpos(strtolower(\$title), strtolower(\$query)) === false) {
        continue;
    }
    \$results[] = [
        'permission' => \$name,
        'title' => \$title,
        'provider' => isset(\$info['provider']) ? \$info['provider'] : 'unknown'
    ];
}
\$total = count(\$results);
\$items = array_slice(\$results, $offsetVal, $limitVal);
return ['items' => \$items, 'total' => \$total];
PHP;

            $res = $this->adapter->evaluate($php);
            $items = $res['items'] ?? [];
            $total = $res['total'] ?? 0;

            if ($summary_only) {
                $items = [];
            }

            return Envelope::ok("Found " . $total . " permissions.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_permissions'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_permissions'
            ]);
        }
    }
}
