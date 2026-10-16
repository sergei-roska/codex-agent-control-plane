<?php

require_once __DIR__ . '/../../vendor/autoload.php';

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

$projectRoot = realpath(__DIR__ . '/../fixtures/drupal');
echo "Running smoke tests against PROJECT_ROOT: $projectRoot\n\n";

try {
    $adapter = new FileAdapter($projectRoot);
} catch (\Exception $e) {
    echo "[FAIL] Failed to construct FileAdapter: " . $e->getMessage() . "\n";
    exit(1);
}

$tests = [
    'list_custom_modules' => function(FileAdapter $adapter) {
        $tool = new ListCustomModules($adapter);
        $res = $tool->execute();
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['machine_name'], 'test_module');
        assertEqual($res['data'][0]['package'], 'Custom');
        return true;
    },
    'find_hook_implementations' => function(FileAdapter $adapter) {
        $tool = new FindHookImplementations($adapter);
        $res = $tool->execute('node_insert');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['symbol'], 'test_module_node_insert');
        assertEqual($res['data'][0]['module'], 'test_module');
        return true;
    },
    'find_service_definitions' => function(FileAdapter $adapter) {
        $tool = new FindServiceDefinitions($adapter);
        $res = $tool->execute(class_name: 'TestService');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['service_id'], 'test_module.test_service');
        return true;
    },
    'find_event_subscribers' => function(FileAdapter $adapter) {
        $tool = new FindEventSubscribers($adapter);
        $res = $tool->execute();
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['class'], 'TestSubscriber');
        assertContains($res['data'][0]['events'], 'Symfony\Component\HttpKernel\KernelEvents::REQUEST');
        assertContains($res['data'][0]['events'], 'custom_event_name');
        return true;
    },
    'find_plugin_classes' => function(FileAdapter $adapter) {
        $tool = new FindPluginClasses($adapter);
        $res = $tool->execute(plugin_type: 'Block');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['plugin_id'], 'test_block_id');
        assertEqual($res['data'][0]['class'], 'TestBlock');
        return true;
    },
    'find_form_classes' => function(FileAdapter $adapter) {
        $tool = new FindFormClasses($adapter);
        $res = $tool->execute('TestForm');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['class'], 'TestForm');
        assertContains($res['data'][0]['route_names'], 'test_module.test_form_route');
        return true;
    },
    'find_controller_handlers' => function(FileAdapter $adapter) {
        $tool = new FindControllerHandlers($adapter);
        $res = $tool->execute(route_name: 'test_module.test_route');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['controller'], 'Drupal\test_module\Controller\TestController');
        assertEqual($res['data'][0]['method'], 'hello');
        return true;
    },
    'find_preprocess_functions' => function(FileAdapter $adapter) {
        $tool = new FindPreprocessFunctions($adapter);
        $res = $tool->execute(hook: 'node');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['function_name'], 'test_module_preprocess_node');
        assertEqual($res['data'][0]['owner'], 'test_module');
        return true;
    },
    'find_drush_commands' => function(FileAdapter $adapter) {
        $tool = new FindDrushCommands($adapter);
        $res = $tool->execute(command_name: 'test_run_command');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['class'], 'TestCommands');
        return true;
    },
    'trace_runtime_to_code' => function(FileAdapter $adapter) {
        $tool = new TraceRuntimeToCode($adapter);
        $res = $tool->execute('service', 'test_module.test_service');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['service_id'], 'test_module.test_service');
        return true;
    },
    'summarize_code_inventory' => function(FileAdapter $adapter) {
        $tool = new SummarizeCodeInventory($adapter);
        $res = $tool->execute();
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['custom_modules'], 1);
        assertContains($res['data'][0]['custom_list'], 'test_module');
        return true;
    },
    'read_sync_config' => function(FileAdapter $adapter) {
        $tool = new ReadSyncConfig($adapter);
        $res = $tool->execute(config_name: 'system.site');
        assertOk($res);
        assertCount($res['data'], 1);
        assertEqual($res['data'][0]['name'], 'system.site');
        assertEqual($res['data'][0]['data']['name'], 'Mock Drupal Site');
        return true;
    },
];

$passed = 0;
$failed = 0;

foreach ($tests as $name => $test) {
    try {
        echo "Running test '$name'... ";
        if ($test($adapter)) {
            echo "PASSED\n";
            $passed++;
        }
    } catch (\Exception $e) {
        echo "FAILED\n";
        echo "  Error: " . $e->getMessage() . "\n";
        $failed++;
    }
}

echo "\nSummary: $passed passed, $failed failed.\n";
if ($failed > 0) {
    exit(1);
}
exit(0);

// Helper assertions
function assertOk(array $envelope) {
    if (!isset($envelope['ok']) || !$envelope['ok']) {
        throw new \Exception("Response is not OK: " . json_encode($envelope));
    }
}

function assertCount(array $arr, int $expected) {
    if (count($arr) !== $expected) {
        throw new \Exception("Expected count $expected, got " . count($arr));
    }
}

function assertEqual($actual, $expected) {
    if ($actual !== $expected) {
        throw new \Exception("Expected " . var_export($expected, true) . ", got " . var_export($actual, true));
    }
}

function assertContains(array $arr, $item) {
    if (!in_array($item, $arr)) {
        throw new \Exception("Expected array to contain " . var_export($item, true) . ", array: " . json_encode($arr));
    }
}
