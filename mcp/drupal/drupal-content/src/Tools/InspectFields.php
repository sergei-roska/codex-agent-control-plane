<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectFields {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name; omit to get base fields only.")]
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
            $escapedTypeId = addslashes($entity_type_id);
            $escapedBundle = $bundle ? addslashes($bundle) : '';
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$entity_type = '$escapedTypeId';
\$bundle = '$escapedBundle';
\$manager = \\Drupal::service('entity_field.manager');
\$definitions = \$bundle ? \$manager->getFieldDefinitions(\$entity_type, \$bundle) : \$manager->getBaseFieldDefinitions(\$entity_type);
\$results = [];
foreach (\$definitions as \$name => \$f) {
    \$results[] = [
        'field_name' => \$name, 
        'field_type' => \$f->getType(), 
        'label' => (string)\$f->getLabel(),
        'required' => \$f->isRequired(),
        'translatable' => \$f->isTranslatable(),
        'provider' => \$f->getProvider(),
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

            return Envelope::ok("Found " . $total . " fields.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_fields'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_fields'
            ]);
        }
    }
}
