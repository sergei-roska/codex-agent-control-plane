<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectModeration {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name (required — moderation is configured per bundle).")]
        ?string $bundle = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $escapedEntityType = addslashes($entity_type_id);
            $escapedBundle = $bundle ? addslashes($bundle) : '';

            $php = <<<PHP
if (!\\Drupal::moduleHandler()->moduleExists('content_moderation')) {
    return ['moderated' => false];
}
\$id = '$escapedEntityType';
\$b = '$escapedBundle';

\$workflows = \\Drupal::entityTypeManager()->getStorage('workflow')->loadMultiple();
foreach (\$workflows as \$w) {
    \$config = \$w->getTypePlugin()->getConfiguration();
    if (isset(\$config['entity_types'][\$id]) && in_array(\$b, \$config['entity_types'][\$id])) {
        return [
            'moderated' => true,
            'workflow' => \$w->id(),
            'states' => array_keys(\$config['states'] ?? []),
        ];
    }
}
return ['moderated' => false];
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok("Moderation info for " . $entity_type_id . ".", [$res], [], [
                'tool' => 'inspect_moderation'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_moderation'
            ]);
        }
    }
}
