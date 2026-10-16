<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectTemplateSuggestions {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(string $theme_hook = '', ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$theme_hook = $params['theme_hook'];
$variables = [];

$get_dummy_entity = function($entity_type) {
    try {
        $storage = \Drupal::entityTypeManager()->getStorage($entity_type);
        $ids = $storage->getQuery()->range(0, 1)->accessCheck(FALSE)->execute();
        if (!empty($ids)) {
            return $storage->load(reset($ids));
        }
        $values = [];
        if ($entity_type === 'node') {
            $values = ['type' => 'page', 'title' => 'Dummy'];
        } elseif ($entity_type === 'taxonomy_term') {
            $values = ['vid' => 'tags', 'name' => 'Dummy'];
        }
        return $storage->create($values);
    } catch (\Throwable $e) {
        return null;
    }
};

if ($theme_hook === 'node') {
    $variables['elements'] = [
        '#node' => $get_dummy_entity('node'),
        '#view_mode' => 'full',
    ];
} elseif ($theme_hook === 'block') {
    $variables['elements'] = [
        '#block' => $get_dummy_entity('block'),
        '#configuration' => [],
        '#plugin_id' => 'dummy',
        '#id' => 'dummy',
        '#base_plugin_id' => 'dummy',
        '#derivative_plugin_id' => 'dummy',
    ];
} elseif ($theme_hook === 'media') {
    $variables['elements'] = [
        '#media' => $get_dummy_entity('media'),
        '#view_mode' => 'full',
    ];
} elseif ($theme_hook === 'taxonomy_term') {
    $variables['elements'] = [
        '#taxonomy_term' => $get_dummy_entity('taxonomy_term'),
        '#view_mode' => 'full',
    ];
} elseif ($theme_hook === 'user') {
    $variables['elements'] = [
        '#user' => $get_dummy_entity('user'),
        '#view_mode' => 'full',
    ];
} elseif ($theme_hook === 'field') {
    $variables['element'] = [
        '#field_name' => 'dummy_field',
        '#entity_type' => 'node',
        '#bundle' => 'page',
        '#object' => $get_dummy_entity('node'),
        '#view_mode' => 'full',
    ];
}

$suggestions = \Drupal::moduleHandler()->invokeAll('theme_suggestions_' . $theme_hook, [$variables]);
\Drupal::moduleHandler()->alter('theme_suggestions_' . $theme_hook, $suggestions, $variables);
return [
    'theme_hook' => $theme_hook,
    'suggestions' => array_reverse($suggestions),
    'chosen_priority' => 'The last element in suggestions array usually wins in Drupal.',
];
PHP;

            $result = $this->adapter->evaluate($php, ['theme_hook' => $theme_hook]);
            $count = count($result['suggestions'] ?? []);

            return Envelope::ok(
                "Found $count suggestions for {$theme_hook}.",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'inspect_template_suggestions']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_template_suggestions'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_template_suggestions'
            ]);
        }
    }
}
