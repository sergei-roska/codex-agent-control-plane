<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class SummarizeRenderPath {
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

$view_mode = 'full';
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

$theme_hook = $build['#theme'] ?? ($build['#type'] ?? 'unknown');
$libraries = $build['#attached']['library'] ?? [];

$registry = \Drupal::service('theme.registry')->get();
$info = isset($registry[$theme_hook]) ? $registry[$theme_hook] : null;
$template_name = $info['template'] ?? '';
$template_path = $info['path'] ?? '';
$preprocess_count = count($info['preprocess functions'] ?? []);

return [
    'target' => $type . ':' . $id,
    'theme_hook' => $theme_hook,
    'template' => $template_name,
    'template_path' => $template_path,
    'preprocess_count' => $preprocess_count,
    'library_count' => count($libraries),
    'libraries' => $libraries,
];
PHP;

            $result = $this->adapter->evaluate($php, [
                'target_type' => $target_type,
                'target_id' => $target_id,
            ]);

            if (isset($result['error'])) {
                return Envelope::error($result['error'], $result['message'], 'Please verify target_type and target_id exist', [
                    'tool' => 'summarize_render_path'
                ]);
            }

            $theme_hook = $result['theme_hook'] ?? 'unknown';
            $template_name = $result['template'] ?? '';
            $library_count = $result['library_count'] ?? 0;

            return Envelope::ok(
                "Render path: {$theme_hook} -> {$template_name} ({$library_count} libs).",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'summarize_render_path']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'summarize_render_path'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'summarize_render_path'
            ]);
        }
    }
}
