<?php

require_once __DIR__ . '/../vendor/autoload.php';

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Tools\ListCustomModules;
use DrupalMcp\Static\Tools\FindHookImplementations;
use DrupalMcp\Static\Tools\FindServiceDefinitions;
use DrupalMcp\Static\Tools\FindEventSubscribers;
use DrupalMcp\Static\Tools\FindPluginClasses;
use DrupalMcp\Static\Tools\FindFormClasses;
use DrupalMcp\Static\Tools\FindControllerHandlers;
use DrupalMcp\Static\Tools\FindPreprocessFunctions;
use DrupalMcp\Static\Tools\FindDrushCommands;
use DrupalMcp\Static\Tools\TraceRuntimeToCode;
use DrupalMcp\Static\Tools\SummarizeCodeInventory;
use DrupalMcp\Static\Tools\ReadSyncConfig;

$fixtureDir = __DIR__ . '/fixtures/drupal';
echo "Initializing FileAdapter with fixture root: $fixtureDir\n";

$adapter = new FileAdapter($fixtureDir);
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
    'list_custom_modules' => function() use ($adapter) {
        $tool = new ListCustomModules($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'list_custom_modules');
        
        // Assertions on test data
        $found = false;
        foreach ($res['data'] as $module) {
            if ($module['machine_name'] === 'test_module') {
                $found = true;
                break;
            }
        }
        if (!$found) {
            throw new \Exception("Expected to find test_module in custom modules.");
        }
        echo "  [PASS] Found test_module as custom module.\n";
    },

    'find_hook_implementations' => function() use ($adapter) {
        $tool = new FindHookImplementations($adapter);
        $res = $tool->execute('node_insert');
        assertEnvelope($res, 'find_hook_implementations');
        
        $found = false;
        foreach ($res['data'] as $impl) {
            if ($impl['symbol'] === 'test_module_node_insert') {
                $found = true;
                break;
            }
        }
        if (!$found) {
            throw new \Exception("Expected to find test_module_node_insert hook implementation.");
        }
        echo "  [PASS] Found hook_node_insert implementation in test_module.\n";
    },

    'find_service_definitions' => function() use ($adapter) {
        $tool = new FindServiceDefinitions($adapter);
        $res = $tool->execute('test_module.test_service');
        assertEnvelope($res, 'find_service_definitions');
        
        if (count($res['data']) !== 1 || $res['data'][0]['service_id'] !== 'test_module.test_service') {
            throw new \Exception("Expected to find test_module.test_service service definition.");
        }
        echo "  [PASS] Found test_module.test_service service definition.\n";
    },

    'find_event_subscribers' => function() use ($adapter) {
        $tool = new FindEventSubscribers($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'find_event_subscribers');
        
        $found = false;
        foreach ($res['data'] as $sub) {
            if ($sub['class'] === 'TestSubscriber') {
                $found = true;
                break;
            }
        }
        if (!$found) {
            throw new \Exception("Expected to find TestSubscriber event subscriber.");
        }
        echo "  [PASS] Found TestSubscriber event subscriber.\n";
    },

    'find_plugin_classes' => function() use ($adapter) {
        $tool = new FindPluginClasses($adapter);
        $res = $tool->execute(plugin_type: 'Block', plugin_id: 'test_block_id');
        assertEnvelope($res, 'find_plugin_classes');
        
        if (count($res['data']) !== 1 || $res['data'][0]['plugin_id'] !== 'test_block_id') {
            throw new \Exception("Expected to find test_block_id plugin.");
        }
        echo "  [PASS] Found test_block_id plugin.\n";
    },

    'find_form_classes' => function() use ($adapter) {
        $tool = new FindFormClasses($adapter);
        $res = $tool->execute('TestForm');
        assertEnvelope($res, 'find_form_classes');
        
        if (count($res['data']) !== 1 || $res['data'][0]['class'] !== 'TestForm') {
            throw new \Exception("Expected to find TestForm class.");
        }
        echo "  [PASS] Found TestForm form class.\n";
    },

    'find_controller_handlers' => function() use ($adapter) {
        $tool = new FindControllerHandlers($adapter);
        $res = $tool->execute(route_name: 'test_module.test_route');
        assertEnvelope($res, 'find_controller_handlers');
        
        if (count($res['data']) !== 1 || $res['data'][0]['route_name'] !== 'test_module.test_route') {
            throw new \Exception("Expected to find test_module.test_route controller handler.");
        }
        echo "  [PASS] Found test_module.test_route controller handler.\n";
    },

    'find_preprocess_functions' => function() use ($adapter) {
        $tool = new FindPreprocessFunctions($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'find_preprocess_functions');
        
        $found = false;
        foreach ($res['data'] as $func) {
            if ($func['function_name'] === 'test_module_preprocess_node') {
                $found = true;
                break;
            }
        }
        if (!$found) {
            throw new \Exception("Expected to find test_module_preprocess_node preprocessing function.");
        }
        echo "  [PASS] Found test_module_preprocess_node preprocess function.\n";
    },

    'find_drush_commands' => function() use ($adapter) {
        $tool = new FindDrushCommands($adapter);
        $res = $tool->execute('test_run_command');
        assertEnvelope($res, 'find_drush_commands');
        
        $found = false;
        foreach ($res['data'] as $cmd) {
            if ($cmd['class'] === 'TestCommands' && $cmd['command_name'] === 'test_run_command') {
                $found = true;
                break;
            }
        }
        if (!$found) {
            throw new \Exception("Expected to find test_run_command drush command.");
        }
        echo "  [PASS] Found test_run_command drush command.\n";
    },

    'trace_runtime_to_code' => function() use ($adapter) {
        $tool = new TraceRuntimeToCode($adapter);
        
        // Test route tracing
        $res = $tool->execute('route', 'test_module.test_route');
        assertEnvelope($res, 'trace_runtime_to_code');
        if (count($res['data']) !== 1 || $res['data'][0]['route_name'] !== 'test_module.test_route') {
            throw new \Exception("Expected route trace to return test_module.test_route.");
        }
        
        // Test hook tracing
        $res = $tool->execute('hook', 'node_insert');
        assertEnvelope($res, 'trace_runtime_to_code');
        if (count($res['data']) !== 1 || $res['data'][0]['symbol'] !== 'test_module_node_insert') {
            throw new \Exception("Expected hook trace to return test_module_node_insert.");
        }
        
        echo "  [PASS] TraceRuntimeToCode resolved route and hook successfully.\n";
    },

    'summarize_code_inventory' => function() use ($adapter) {
        $tool = new SummarizeCodeInventory($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'summarize_code_inventory');
        
        if (empty($res['data']) || !in_array('test_module', $res['data'][0]['custom_list'])) {
            throw new \Exception("Expected code inventory custom_list to contain test_module.");
        }
        echo "  [PASS] Code inventory summary is correct.\n";
    },

    'read_sync_config' => function() use ($adapter) {
        $tool = new ReadSyncConfig($adapter);
        $res = $tool->execute('system.site');
        assertEnvelope($res, 'read_sync_config');
        
        if (count($res['data']) !== 1 || $res['data'][0]['name'] !== 'system.site') {
            throw new \Exception("Expected to read system.site sync config.");
        }
        $siteName = $res['data'][0]['data']['name'] ?? '';
        if ($siteName !== 'Mock Drupal Site') {
            throw new \Exception("Expected site name 'Mock Drupal Site', got '$siteName'.");
        }
        echo "  [PASS] Successfully read system.site sync config and values match.\n";
    }
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
    echo "\nALL SMOKE TESTS PASSED SUCCESSFULLY!\n";
    exit(0);
} else {
    echo "\nSOME SMOKE TESTS FAILED!\n";
    exit(1);
}
