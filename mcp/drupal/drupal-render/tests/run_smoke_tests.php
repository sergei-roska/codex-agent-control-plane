<?php

require_once __DIR__ . '/../vendor/autoload.php';

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Tools\InspectThemeState;
use DrupalMcp\Render\Tools\InspectTemplateSuggestions;
use DrupalMcp\Render\Tools\TraceTemplateResolution;
use DrupalMcp\Render\Tools\FindPreprocessChain;
use DrupalMcp\Render\Tools\InspectRenderArray;
use DrupalMcp\Render\Tools\InspectLibraryAttachments;
use DrupalMcp\Render\Tools\InspectBlocksAndRegions;
use DrupalMcp\Render\Tools\InspectSdcComponents;
use DrupalMcp\Render\Tools\SummarizeRenderPath;
use DrupalMcp\Render\Tools\InspectThemes;

// Define Mock Adapter inline for smoke testing without a live Drupal site.
class MockDrushAdapter extends DrushAdapter {
    public function __construct() {
        // Skip parent constructor - no directory check needed
    }

    public function getProjectRoot(): string {
        return '/mock/project/root';
    }

    public function getDrupalRoot(): string {
        return '/mock/project/root/web';
    }

    public function evaluate(string $phpCode, array $params = []): array {
        // InspectThemeState: detects getActiveTheme()
        if (strpos($phpCode, 'getActiveTheme()') !== false) {
            return [
                'active_theme' => 'olivero',
                'admin_theme' => 'claro',
                'base_theme_chain' => [],
                'path' => 'themes/olivero',
                'region_count' => 2,
                'regions' => ['content' => 'Content', 'sidebar' => 'Sidebar'],
            ];
        }

        // InspectTemplateSuggestions: detects theme_suggestions_
        if (strpos($phpCode, 'theme_suggestions_') !== false) {
            return [
                'theme_hook' => 'node',
                'suggestions' => ['node--article', 'node'],
                'chosen_priority' => 'The last element in suggestions array usually wins in Drupal.',
            ];
        }

        // SummarizeRenderPath: detects library_count AND preprocess_count
        if (strpos($phpCode, 'library_count') !== false && strpos($phpCode, 'preprocess_count') !== false) {
            return [
                'target' => 'node:1',
                'theme_hook' => 'node',
                'template' => 'node',
                'template_path' => 'core/themes/olivero/templates',
                'preprocess_count' => 3,
                'library_count' => 1,
                'libraries' => ['core/drupal'],
            ];
        }

        // TraceTemplateResolution / FindPreprocessChain: detects theme.registry AND preprocess functions
        if (strpos($phpCode, 'theme.registry') !== false && strpos($phpCode, 'preprocess functions') !== false) {
            return [
                'theme_hook' => 'node',
                'template_name' => 'node',
                'template_path' => 'core/themes/olivero/templates',
                'type' => 'module',
                'preprocess_functions' => ['template_preprocess_node'],
            ];
        }

        // InspectRenderArray: detects render_array_preview
        if (strpos($phpCode, 'render_array_preview') !== false) {
            return [
                'summary' => ['theme_hook' => 'node', 'keys' => ['#theme', '#node']],
                'render_array_preview' => ['#theme' => 'node'],
            ];
        }

        // InspectLibraryAttachments: detects drupalSettings_keys
        if (strpos($phpCode, 'drupalSettings_keys') !== false) {
            return [
                'libraries' => ['core/drupal'],
                'drupalSettings_keys' => [],
            ];
        }

        // InspectBlocksAndRegions: detects loadByProperties AND getRegion
        if (strpos($phpCode, 'loadByProperties') !== false && strpos($phpCode, 'getRegion') !== false) {
            return [
                ['id' => 'olivero_site_branding', 'label' => 'Site branding', 'region' => 'header', 'plugin_id' => 'system_branding_block', 'weight' => -10, 'status' => true],
            ];
        }

        // InspectSdcComponents: detects plugin.manager.sdc
        if (strpos($phpCode, 'plugin.manager.sdc') !== false) {
            return [
                ['id' => 'core:button', 'extension' => 'core', 'path' => 'core/components/button', 'has_schema' => true],
            ];
        }

        // InspectThemes: detects listInfo
        if (strpos($phpCode, 'listInfo') !== false) {
            return [
                'items' => [
                    ['machine_name' => 'olivero', 'name' => 'Olivero', 'is_default' => true, 'is_admin' => false, 'status' => 'enabled'],
                ],
                'total' => 1,
            ];
        }

        return [];
    }
}

$adapter = new MockDrushAdapter();
$allPassed = true;

function assertEnvelope(array $envelope, string $toolName): void {
    if (!isset($envelope['ok'])) {
        throw new \Exception("[$toolName] Envelope missing 'ok' key.");
    }
    if ($envelope['ok'] !== true) {
        throw new \Exception("[$toolName] Expected ok=true, got ok=false. Errors: " . json_encode($envelope['errors'] ?? []));
    }
    if (!isset($envelope['summary'])) {
        throw new \Exception("[$toolName] Envelope missing 'summary' key.");
    }
    if (!is_array($envelope['data'])) {
        throw new \Exception("[$toolName] Envelope 'data' is not an array.");
    }
    if (!is_array($envelope['counts'])) {
        throw new \Exception("[$toolName] Envelope 'counts' is not an array.");
    }
    if (!is_array($envelope['meta'])) {
        throw new \Exception("[$toolName] Envelope 'meta' is not an array.");
    }
    if ($envelope['meta']['tool'] !== $toolName) {
        throw new \Exception("[$toolName] Expected meta.tool='$toolName', got '{$envelope['meta']['tool']}'");
    }
}

$tests = [
    'inspect_theme_state' => function() use ($adapter) {
        $tool = new InspectThemeState($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_theme_state');
        if (count($res['data']) < 1 || $res['data'][0]['active_theme'] !== 'olivero') {
            throw new \Exception("Failed to find expected active theme.");
        }
        echo "  [PASS] inspect_theme_state works.\n";
    },

    'inspect_template_suggestions' => function() use ($adapter) {
        $tool = new InspectTemplateSuggestions($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_template_suggestions');
        if (count($res['data']) < 1 || count($res['data'][0]['suggestions']) < 1) {
            throw new \Exception("Failed to find expected template suggestions.");
        }
        echo "  [PASS] inspect_template_suggestions works.\n";
    },

    'trace_template_resolution' => function() use ($adapter) {
        $tool = new TraceTemplateResolution($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'trace_template_resolution');
        if (count($res['data']) < 1 || $res['data'][0]['template_name'] !== 'node') {
            throw new \Exception("Failed to find expected template resolution data.");
        }
        echo "  [PASS] trace_template_resolution works.\n";
    },

    'find_preprocess_chain' => function() use ($adapter) {
        $tool = new FindPreprocessChain($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'find_preprocess_chain');
        if (count($res['data']) < 1 || count($res['data'][0]['preprocess_functions']) < 1) {
            throw new \Exception("Failed to find expected preprocess chain.");
        }
        echo "  [PASS] find_preprocess_chain works.\n";
    },

    'inspect_render_array' => function() use ($adapter) {
        $tool = new InspectRenderArray($adapter);
        $res = $tool->execute('node', '1');
        assertEnvelope($res, 'inspect_render_array');
        if (count($res['data']) < 1 || $res['data'][0]['summary']['theme_hook'] !== 'node') {
            throw new \Exception("Failed to find expected render array data.");
        }
        echo "  [PASS] inspect_render_array works.\n";
    },

    'inspect_library_attachments' => function() use ($adapter) {
        $tool = new InspectLibraryAttachments($adapter);
        $res = $tool->execute('node', '1');
        assertEnvelope($res, 'inspect_library_attachments');
        if (count($res['data']) < 1 || count($res['data'][0]['libraries']) < 1) {
            throw new \Exception("Failed to find expected library attachments.");
        }
        echo "  [PASS] inspect_library_attachments works.\n";
    },

    'inspect_blocks_and_regions' => function() use ($adapter) {
        $tool = new InspectBlocksAndRegions($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_blocks_and_regions');
        if (count($res['data']) < 1 || $res['data'][0]['id'] !== 'olivero_site_branding') {
            throw new \Exception("Failed to find expected blocks data.");
        }
        echo "  [PASS] inspect_blocks_and_regions works.\n";
    },

    'inspect_sdc_components' => function() use ($adapter) {
        $tool = new InspectSdcComponents($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_sdc_components');
        if (count($res['data']) < 1 || $res['data'][0]['id'] !== 'core:button') {
            throw new \Exception("Failed to find expected SDC component data.");
        }
        echo "  [PASS] inspect_sdc_components works.\n";
    },

    'summarize_render_path' => function() use ($adapter) {
        $tool = new SummarizeRenderPath($adapter);
        $res = $tool->execute('node', '1');
        assertEnvelope($res, 'summarize_render_path');
        if (count($res['data']) < 1 || $res['data'][0]['theme_hook'] !== 'node') {
            throw new \Exception("Failed to find expected render path summary.");
        }
        echo "  [PASS] summarize_render_path works.\n";
    },

    'inspect_themes' => function() use ($adapter) {
        $tool = new InspectThemes($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_themes');
        if (count($res['data']) < 1 || $res['data'][0]['machine_name'] !== 'olivero') {
            throw new \Exception("Failed to find expected theme data.");
        }
        echo "  [PASS] inspect_themes works.\n";
    },
];

foreach ($tests as $name => $testFn) {
    echo "Running smoke test: $name ...\n";
    try {
        $testFn();
    } catch (\Exception $e) {
        echo "  [FAIL] $name failed: " . $e->getMessage() . "\n";
        $allPassed = false;
    }
}

if ($allPassed) {
    echo "\nALL RENDER SMOKE TESTS PASSED SUCCESSFULLY!\n";
    exit(0);
} else {
    echo "\nSOME RENDER SMOKE TESTS FAILED!\n";
    exit(1);
}
