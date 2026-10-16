<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectLibraryAttachments {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(string $target_type = '', string $target_id = '', ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$type = $params['target_type'] ?? '';
$id = $params['target_id'] ?? '';
if (empty($type) || empty($id)) {
    return ['error' => 'MISSING_PARAMETERS', 'message' => 'Both target_type and target_id are required.'];
}

$build = [];
if ($type === 'block') {
    if (class_exists('\Drupal\block\Entity\Block')) {
        $entity = \Drupal\block\Entity\Block::load($id);
        if ($entity) $build = \Drupal::entityTypeManager()->getViewBuilder('block')->view($entity);
    }
} elseif ($type === 'node') {
    if (class_exists('\Drupal\node\Entity\Node')) {
        $entity = \Drupal\node\Entity\Node::load($id);
        if ($entity) $build = \Drupal::entityTypeManager()->getViewBuilder('node')->view($entity);
    }
}

if (empty($build)) {
    return ['error' => 'ENTITY_NOT_FOUND', 'message' => "Could not load or view entity {$type}:{$id}"];
}

return [
    'libraries' => $build['#attached']['library'] ?? [],
    'drupalSettings_keys' => isset($build['#attached']['drupalSettings']) ? array_keys($build['#attached']['drupalSettings']) : [],
];
PHP;

            $result = $this->adapter->evaluate($php, [
                'target_type' => $target_type,
                'target_id' => $target_id,
            ]);

            if (isset($result['error'])) {
                return Envelope::error($result['error'], $result['message'], 'Please verify target_type and target_id exist', [
                    'tool' => 'inspect_library_attachments'
                ]);
            }

            $count = count($result['libraries'] ?? []);

            return Envelope::ok(
                "Found {$count} attached libraries for {$target_type}:{$target_id}.",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'inspect_library_attachments']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_library_attachments'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_library_attachments'
            ]);
        }
    }
}
