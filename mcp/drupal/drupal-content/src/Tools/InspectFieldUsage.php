<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectFieldUsage {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media, taxonomy_term).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name to scope field lookup.")]
        ?string $bundle = null,
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
            $escapedEntityType = addslashes($entity_type_id);
            $escapedBundle = $bundle ? addslashes($bundle) : '';
            $escapedQuery = $query ? addslashes($query) : '';
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$entity_type = '$escapedEntityType';
\$bundle_filter = '$escapedBundle';
\$query = strtolower('$escapedQuery');
\$manager = \\Drupal::service('entity_field.manager');

\$results = [];
if (\$bundle_filter) {
    \$definitions = \$manager->getFieldDefinitions(\$entity_type, \$bundle_filter);
    foreach (\$definitions as \$name => \$f) {
        if (\$query && strpos(strtolower(\$name), \$query) === false && strpos(strtolower(\$f->getLabel()), \$query) === false) continue;
        \$results[] = [
            'name' => \$name,
            'type' => \$f->getType(),
            'label' => (string)\$f->getLabel(),
            'bundle' => \$bundle_filter,
        ];
    }
} else {
    \$all_maps = \$manager->getFieldMap();
    \$field_map = \$all_maps[\$entity_type] ?? [];
    foreach (\$field_map as \$field_name => \$info) {
        if (\$query && strpos(strtolower(\$field_name), \$query) === false) continue;
        
        \$first_bundle = reset(\$info['bundles']);
        \$definitions = \$manager->getFieldDefinitions(\$entity_type, \$first_bundle);
        if (!isset(\$definitions[\$field_name])) continue;
        
        \$f = \$definitions[\$field_name];
        if (\$query && strpos(strtolower(\$f->getLabel()), \$query) === false && strpos(strtolower(\$field_name), \$query) === false) continue;

        \$results[] = [
            'name' => \$field_name,
            'type' => \$f->getType(),
            'label' => (string)\$f->getLabel(),
            'bundles' => array_values(\$info['bundles']),
        ];
    }
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

            return Envelope::ok("Field usage for " . $entity_type_id . ".", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_field_usage'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_field_usage'
            ]);
        }
    }
}
