<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectThemeState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$theme_manager = \Drupal::service('theme.manager');
$active_theme = $theme_manager->getActiveTheme();
$base_themes = [];
foreach ($active_theme->getBaseThemeExtensions() as $ext) {
    $base_themes[] = $ext->getName();
}
return [
    'active_theme' => $active_theme->getName(),
    'admin_theme' => \Drupal::config('system.theme')->get('admin'),
    'base_theme_chain' => $base_themes,
    'path' => $active_theme->getPath(),
    'region_count' => count($active_theme->getRegions()),
    'regions' => $active_theme->getRegions(),
];
PHP;

            $result = $this->adapter->evaluate($php);

            return Envelope::ok(
                "Active theme: {$result['active_theme']}",
                [$result],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'inspect_theme_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_theme_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_theme_state'
            ]);
        }
    }
}
