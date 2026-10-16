<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectDisplayModes {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, media, taxonomy_term).")]
        string $entity_type_id,
        #[Schema(description: "Bundle machine name to scope to bundle-specific display modes.")]
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
\$repo = \\Drupal::service('entity_display.repository');
\$view_modes = \$repo->getViewModeOptionsByBundle(\$entity_type, \$bundle);
\$form_modes = \$repo->getFormModeOptionsByBundle(\$entity_type, \$bundle);

return [
    'view_modes' => array_keys(\$view_modes),
    'form_modes' => array_keys(\$form_modes),
];
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok("Display modes for " . $entity_type_id . ".", [$res], [], [
                'tool' => 'inspect_display_modes'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_display_modes'
            ]);
        }
    }
}
