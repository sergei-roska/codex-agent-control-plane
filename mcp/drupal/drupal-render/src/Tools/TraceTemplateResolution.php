<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class TraceTemplateResolution {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(string $theme_hook = '', ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$theme_hook = $params['theme_hook'];
$registry = \Drupal::service('theme.registry')->get();
$info = isset($registry[$theme_hook]) ? $registry[$theme_hook] : null;
if (!$info) return ['error' => 'Hook not found in registry', 'theme_hook' => $theme_hook];
return [
    'theme_hook' => $theme_hook,
    'template_name' => $info['template'] ?? '',
    'template_path' => $info['path'] ?? '',
    'type' => $info['type'] ?? '',
    'preprocess_functions' => $info['preprocess functions'] ?? [],
];
PHP;

            $result = $this->adapter->evaluate($php, ['theme_hook' => $theme_hook]);
            $template_name = $result['template_name'] ?? '';

            return Envelope::ok(
                "Resolved {$theme_hook} to {$template_name}.",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'trace_template_resolution']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'trace_template_resolution'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'trace_template_resolution'
            ]);
        }
    }
}
