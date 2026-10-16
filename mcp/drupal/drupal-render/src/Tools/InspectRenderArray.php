<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectRenderArray {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(string $target_type = '', string $target_id = '', string $view_mode = 'full', int $max_depth = 3, ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$type = $params['target_type'] ?? '';
$id = $params['target_id'] ?? '';
$view_mode = $params['view_mode'] ?? 'full';
$max_depth = (int)($params['max_depth'] ?? 3);

if (empty($type) || empty($id)) {
    return ['error' => 'MISSING_PARAMETERS', 'message' => 'Both target_type and target_id are required.'];
}

$build = [];

if ($type === 'block') {
    if (class_exists('\Drupal\block\Entity\Block')) {
        $block = \Drupal\block\Entity\Block::load($id);
        if ($block) $build = \Drupal::entityTypeManager()->getViewBuilder('block')->view($block);
    }
} elseif ($type === 'node') {
    if (class_exists('\Drupal\node\Entity\Node')) {
        $node = \Drupal\node\Entity\Node::load($id);
        if ($node) $build = \Drupal::entityTypeManager()->getViewBuilder('node')->view($node, $view_mode);
    }
}

if (empty($build)) {
    return ['error' => 'ENTITY_NOT_FOUND', 'message' => "Could not load or view entity {$type}:{$id}"];
}

$stripNoise = function(&$arr, $depth, $max) use (&$stripNoise) {
    if ($depth > $max) { $arr = '...max depth reached...'; return; }
    if (!is_array($arr)) return;
    unset($arr['#cache']);
    unset($arr['#attached']);
    foreach ($arr as $key => &$val) {
        if (is_array($val)) $stripNoise($val, $depth + 1, $max);
    }
};

$summary = ['theme_hook' => $build['#theme'] ?? ($build['#type'] ?? 'unknown'), 'keys' => array_keys($build)];
$stripNoise($build, 0, $max_depth);
return ['summary' => $summary, 'render_array_preview' => $build];
PHP;

            $result = $this->adapter->evaluate($php, [
                'target_type' => $target_type,
                'target_id' => $target_id,
                'view_mode' => $view_mode,
                'max_depth' => $max_depth,
            ]);

            if (isset($result['error'])) {
                return Envelope::error($result['error'], $result['message'], 'Please verify target_type and target_id exist', [
                    'tool' => 'inspect_render_array'
                ]);
            }

            return Envelope::ok(
                "Render array for {$target_type}:{$target_id}.",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'inspect_render_array']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_render_array'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_render_array'
            ]);
        }
    }
}
