<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class SummarizeEditorialModel {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media, taxonomy_term).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name; omit for entity-wide summary.")]
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

\$info = \\Drupal::service('entity_type.bundle.info')->getBundleInfo(\$entity_type);
\$bundles_count = count(\$info);

\$manager = \\Drupal::service('entity_field.manager');
\$results_graph = [];
\$bundles = \$bundle ? [\$bundle] : array_keys(\$info);

foreach (\$bundles as \$b) {
    \$fields = \$manager->getFieldDefinitions(\$entity_type, \$b);
    foreach (\$fields as \$name => \$f) {
        \$type = \$f->getType();
        if (\$type === 'entity_reference' || \$type === 'entity_reference_revisions' || \$type === 'image' || \$type === 'file') {
            \$settings = \$f->getSettings();
            \$target_type = \$settings['target_type'] ?? (\$type === 'image' || \$type === 'file' ? 'file' : 'unknown');
            \$target_bundles = \$settings['handler_settings']['target_bundles'] ?? null;
            \$results_graph[] = [
                'bundle' => \$b,
                'field' => \$name,
                'type' => \$type,
                'target_type' => \$target_type,
                'target_bundles' => \$target_bundles ? array_values(\$target_bundles) : 'all',
            ];
        }
    }
}

\$moderation = ['moderated' => false];
\$target_bundle = \$bundle ?: (count(\$bundles) > 0 ? \$bundles[0] : null);
if (\$target_bundle && \\Drupal::moduleHandler()->moduleExists('content_moderation')) {
    \$workflows = \\Drupal::entityTypeManager()->getStorage('workflow')->loadMultiple();
    foreach (\$workflows as \$w) {
        \$config = \$w->getTypePlugin()->getConfiguration();
        if (isset(\$config['entity_types'][\$entity_type]) && in_array(\$target_bundle, \$config['entity_types'][\$entity_type])) {
            \$moderation = [
                'moderated' => true,
                'workflow' => \$w->id(),
                'states' => array_keys(\$config['states'] ?? []),
            ];
            break;
        }
    }
}

return [
    'domain' => \$entity_type,
    'bundle' => \$bundle ?: 'all',
    'bundles_count' => \$bundles_count,
    'reference_edges' => count(\$results_graph),
    'moderation' => \$moderation,
    'top_references' => array_slice(\$results_graph, 0, 10),
];
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok("Editorial model summary for " . $entity_type_id . ".", [$res], [], [
                'tool' => 'summarize_editorial_model'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'summarize_editorial_model'
            ]);
        }
    }
}
