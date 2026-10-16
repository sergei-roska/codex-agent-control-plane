<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectEntityTypes {
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
\$definitions = \\Drupal::entityTypeManager()->getDefinitions();
\$query = '$escapedQuery';

\$results = [];
foreach (\$definitions as \$id => \$type) {
    \$label = (string) \$type->getLabel();
    if (\$query && strpos(\$id, \$query) === false && strpos(strtolower(\$label), strtolower(\$query)) === false) {
        continue;
    }
    
    \$results[] = [
        'entity_type_id' => \$id,
        'label' => \$label,
        'provider' => \$type->getProvider(),
        'class' => \$type->getClass(),
        'handlers' => ['storage' => \$type->getStorageClass()],
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

            return Envelope::ok("Found " . $total . " entity types.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_entity_types'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_entity_types'
            ]);
        }
    }
}
