<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectReferenceGraph {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name; omit to scan all bundles.")]
        ?string $bundle = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $escapedEntityType = addslashes($entity_type_id);
            $escapedBundle = $bundle ? addslashes($bundle) : '';

            $php = <<<PHP
\$entity_type = '$escapedEntityType';
\$bundle = '$escapedBundle';
\$manager = \\Drupal::service('entity_field.manager');
\$results = [];
\$bundles = \$bundle ? [\$bundle] : array_keys(\\Drupal::service('entity_type.bundle.info')->getBundleInfo(\$entity_type));

foreach (\$bundles as \$b) {
    \$fields = \$manager->getFieldDefinitions(\$entity_type, \$b);
    foreach (\$fields as \$name => \$f) {
        \$type = \$f->getType();
        if (\$type === 'entity_reference' || \$type === 'entity_reference_revisions' || \$type === 'image' || \$type === 'file') {
            \$settings = \$f->getSettings();
            \$target_type = \$settings['target_type'] ?? (\$type === 'image' || \$type === 'file' ? 'file' : 'unknown');
            \$target_bundles = \$settings['handler_settings']['target_bundles'] ?? null;
            \$results[] = [
                'bundle' => \$b,
                'field' => \$name,
                'type' => \$type,
                'target_type' => \$target_type,
                'target_bundles' => \$target_bundles ? array_values(\$target_bundles) : 'all',
            ];
        }
    }
}
return ['items' => \$results];
PHP;

            $res = $this->adapter->evaluate($php);
            $items = $res['items'] ?? [];

            return Envelope::ok("Reference graph for " . $entity_type_id . ".", $items, [], [
                'tool' => 'inspect_reference_graph'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_reference_graph'
            ]);
        }
    }
}
