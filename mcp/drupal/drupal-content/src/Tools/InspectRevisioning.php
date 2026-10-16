<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectRevisioning {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name (unused; reserved for future scoping).")]
        ?string $bundle = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $escapedEntityType = addslashes($entity_type_id);

            $php = <<<PHP
\$id = '$escapedEntityType';
\$type = \\Drupal::entityTypeManager()->getDefinition(\$id);
return [
    'revisionable' => \$type->isRevisionable(),
    'revision_ui' => \$type->hasHandlerClass('revision'),
];
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok("Revisioning info for " . $entity_type_id . ".", [$res], [], [
                'tool' => 'inspect_revisioning'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_revisioning'
            ]);
        }
    }
}
