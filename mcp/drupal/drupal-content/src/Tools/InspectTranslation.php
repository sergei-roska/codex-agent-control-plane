<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectTranslation {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name (required when entity type uses bundles).")]
        ?string $bundle = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $escapedEntityType = addslashes($entity_type_id);
            $escapedBundle = $bundle ? addslashes($bundle) : '';

            $php = <<<PHP
\$id = '$escapedEntityType';
\$b = '$escapedBundle';
if (!\\Drupal::moduleHandler()->moduleExists('content_translation')) {
    return ['translatable' => false, 'module_enabled' => false];
}
\$manager = \\Drupal::service('content_translation.manager');
return [
    'translatable' => \$manager->isEnabled(\$id, \$b),
    'module_enabled' => true
];
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok("Translation status for " . $entity_type_id . ".", [$res], [], [
                'tool' => 'inspect_translation'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_translation'
            ]);
        }
    }
}
