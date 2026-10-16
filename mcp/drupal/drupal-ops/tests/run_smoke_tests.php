<?php

require_once __DIR__ . '/../vendor/autoload.php';

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Tools\DebugWatchdog;
use DrupalMcp\Ops\Tools\DebugQueueState;
use DrupalMcp\Ops\Tools\DebugCronState;
use DrupalMcp\Ops\Tools\DebugCacheState;
use DrupalMcp\Ops\Tools\DebugUpdateState;
use DrupalMcp\Ops\Tools\DebugEnvironmentSummary;
use DrupalMcp\Ops\Tools\DebugStateSystem;
use DrupalMcp\Ops\Tools\DebugRuntimeHealth;
use DrupalMcp\Ops\Tools\DebugFailedOperations;
use DrupalMcp\Ops\Tools\InspectModules;
use DrupalMcp\Ops\Tools\InspectServices;
use DrupalMcp\Ops\Tools\InspectPlugins;
use DrupalMcp\Ops\Tools\InspectRoutes;
use DrupalMcp\Ops\Tools\SearchRuntimeObjects;

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
        // DebugWatchdog: detects watchdog table select
        if (strpos($phpCode, "select('watchdog'") !== false && strpos($phpCode, 'event_id') !== false) {
            return [
                ['event_id' => 1001, 'timestamp' => '2026-06-18T12:00:00+00:00', 'severity' => 3, 'type' => 'php', 'message' => 'Notice: Undefined variable in module.php'],
                ['event_id' => 1000, 'timestamp' => '2026-06-18T11:00:00+00:00', 'severity' => 4, 'type' => 'system', 'message' => 'Cron run completed'],
            ];
        }

        // DebugQueueState: detects queue table groupBy
        if (strpos($phpCode, "select('queue'") !== false && strpos($phpCode, 'item_count') !== false && strpos($phpCode, 'failures') === false) {
            return [
                ['queue_name' => 'system_cron', 'item_count' => 0, 'oldest_item_age_seconds' => 0],
                ['queue_name' => 'media_entity_image', 'item_count' => 3, 'oldest_item_age_seconds' => 600],
            ];
        }

        // DebugCronState: detects cron_last state key
        if (strpos($phpCode, 'system.cron_last') !== false && strpos($phpCode, 'lock') !== false && strpos($phpCode, 'failures') === false) {
            return ['last_run' => '2026-06-18T12:00:00+00:00', 'status' => 'OK', 'is_running' => false];
        }

        // DebugCacheState: detects cache bin table existence check
        if (strpos($phpCode, "cache_") !== false && strpos($phpCode, 'tableExists') !== false) {
            return [
                ['bin' => 'default', 'status' => 'EXISTS'],
                ['bin' => 'render', 'status' => 'EXISTS'],
                ['bin' => 'config', 'status' => 'EXISTS'],
            ];
        }

        // DebugUpdateState: detects update_hook_registry
        if (strpos($phpCode, 'update.update_hook_registry') !== false && strpos($phpCode, 'health_status') === false && strpos($phpCode, 'total_failures') === false) {
            return ['pending_schema_updates' => [], 'pending_entity_updates' => false];
        }

        // DebugEnvironmentSummary: detects Drupal::VERSION and maintenance_mode but no alerts
        if (strpos($phpCode, 'Drupal::VERSION') !== false && strpos($phpCode, 'health_status') === false && strpos($phpCode, 'total_failures') === false) {
            return ['drupal_version' => '10.3.0', 'maintenance_mode' => 'OFF'];
        }

        // DebugStateSystem: detects key_value state query
        if (strpos($phpCode, 'key_value') !== false || (strpos($phpCode, 'valid_keys') !== false && strpos($phpCode, '\Drupal::state()') !== false)) {
            return ['system.cron_last' => 1718712000, 'system.maintenance_mode' => false];
        }

        // DebugRuntimeHealth: detects health_status key
        if (strpos($phpCode, 'health_status') !== false && strpos($phpCode, 'total_failures') === false) {
            return ['health_status' => 'OK', 'alerts' => []];
        }

        // DebugFailedOperations: detects total_failures
        if (strpos($phpCode, 'total_failures') !== false) {
            return ['total_failures' => 0, 'failures' => []];
        }

        // InspectModules: detects getModuleList
        if (strpos($phpCode, 'getModuleList') !== false && strpos($phpCode, 'getServiceIds') === false && strpos($phpCode, 'plugin.manager') === false && strpos($phpCode, 'getAllRoutes') === false && strpos($phpCode, 'health_status') === false && strpos($phpCode, 'total_failures') === false) {
            return [
                'items' => [['machine_name' => 'node', 'name' => 'Node', 'version' => '10.3.0']],
                'total' => 1
            ];
        }

        // InspectServices: detects getServiceIds
        if (strpos($phpCode, 'getServiceIds') !== false) {
            return [
                'items' => [['id' => 'router', 'class' => 'Symfony\Component\Routing\Router']],
                'total' => 1
            ];
        }

        // InspectPlugins: detects plugin.manager
        if (strpos($phpCode, 'plugin.manager') !== false) {
            return [
                'items' => [['plugin_type' => 'block', 'plugin_id' => 'system_menu_block', 'label' => 'Menu', 'class' => 'Drupal\system\Plugin\Block\SystemMenuBlock']],
                'total' => 1
            ];
        }

        // SearchRuntimeObjects: detects entity_types array key AND getDefinitions (must come before InspectRoutes)
        if (strpos($phpCode, "'entity_types'") !== false && strpos($phpCode, 'getDefinitions') !== false) {
            return [
                'entity_types' => [['id' => 'node', 'label' => 'Content']],
                'modules' => ['node'],
                'routes' => [['route_name' => 'node.add_page', 'path' => '/node/add']]
            ];
        }

        // InspectRoutes: detects getAllRoutes
        if (strpos($phpCode, 'getAllRoutes') !== false) {
            return [
                'items' => [['route_name' => 'user.login', 'path' => '/user/login', 'controller' => 'Drupal\user\Controller\UserAuthenticationController::login', 'requirements' => []]],
                'total' => 1
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
    'debug_watchdog' => function() use ($adapter) {
        $tool = new DebugWatchdog($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_watchdog');
        if (count($res['data']) < 1 || $res['data'][0]['event_id'] !== 1001) {
            throw new \Exception("Failed to find expected watchdog entry.");
        }
        echo "  [PASS] debug_watchdog works.\n";
    },

    'debug_queue_state' => function() use ($adapter) {
        $tool = new DebugQueueState($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_queue_state');
        if (count($res['data']) < 1 || $res['data'][0]['queue_name'] !== 'system_cron') {
            throw new \Exception("Failed to find expected queue data.");
        }
        echo "  [PASS] debug_queue_state works.\n";
    },

    'debug_cron_state' => function() use ($adapter) {
        $tool = new DebugCronState($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_cron_state');
        if (count($res['data']) < 1 || $res['data'][0]['status'] !== 'OK') {
            throw new \Exception("Failed to find expected cron status.");
        }
        echo "  [PASS] debug_cron_state works.\n";
    },

    'debug_cache_state' => function() use ($adapter) {
        $tool = new DebugCacheState($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_cache_state');
        if (count($res['data']) < 1 || $res['data'][0]['bin'] !== 'default') {
            throw new \Exception("Failed to find expected cache bin data.");
        }
        echo "  [PASS] debug_cache_state works.\n";
    },

    'debug_update_state' => function() use ($adapter) {
        $tool = new DebugUpdateState($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_update_state');
        if (count($res['data']) < 1 || $res['data'][0]['pending_schema_updates'] !== []) {
            throw new \Exception("Failed to find expected update state data.");
        }
        echo "  [PASS] debug_update_state works.\n";
    },

    'debug_environment_summary' => function() use ($adapter) {
        $tool = new DebugEnvironmentSummary($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_environment_summary');
        if (count($res['data']) < 1 || $res['data'][0]['drupal_version'] !== '10.3.0') {
            throw new \Exception("Failed to find expected environment data.");
        }
        echo "  [PASS] debug_environment_summary works.\n";
    },

    'debug_state_system' => function() use ($adapter) {
        $tool = new DebugStateSystem($adapter);
        $res = $tool->execute(['system.cron_last']);
        assertEnvelope($res, 'debug_state_system');
        if (count($res['data']) < 1) {
            throw new \Exception("Failed to find expected state system data.");
        }
        echo "  [PASS] debug_state_system works.\n";
    },

    'debug_runtime_health' => function() use ($adapter) {
        $tool = new DebugRuntimeHealth($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_runtime_health');
        if (count($res['data']) < 1 || $res['data'][0]['health_status'] !== 'OK') {
            throw new \Exception("Failed to find expected runtime health data.");
        }
        echo "  [PASS] debug_runtime_health works.\n";
    },

    'debug_failed_operations' => function() use ($adapter) {
        $tool = new DebugFailedOperations($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'debug_failed_operations');
        if (count($res['data']) < 1 || $res['data'][0]['total_failures'] !== 0) {
            throw new \Exception("Failed to find expected failed operations data.");
        }
        echo "  [PASS] debug_failed_operations works.\n";
    },

    'inspect_modules' => function() use ($adapter) {
        $tool = new InspectModules($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_modules');
        if (count($res['data']) < 1 || $res['data'][0]['machine_name'] !== 'node') {
            throw new \Exception("Failed to find expected module data.");
        }
        echo "  [PASS] inspect_modules works.\n";
    },

    'inspect_services' => function() use ($adapter) {
        $tool = new InspectServices($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_services');
        if (count($res['data']) < 1 || $res['data'][0]['id'] !== 'router') {
            throw new \Exception("Failed to find expected service data.");
        }
        echo "  [PASS] inspect_services works.\n";
    },

    'inspect_plugins' => function() use ($adapter) {
        $tool = new InspectPlugins($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_plugins');
        if (count($res['data']) < 1 || $res['data'][0]['plugin_id'] !== 'system_menu_block') {
            throw new \Exception("Failed to find expected plugin data.");
        }
        echo "  [PASS] inspect_plugins works.\n";
    },

    'inspect_routes' => function() use ($adapter) {
        $tool = new InspectRoutes($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_routes');
        if (count($res['data']) < 1 || $res['data'][0]['route_name'] !== 'user.login') {
            throw new \Exception("Failed to find expected route data.");
        }
        echo "  [PASS] inspect_routes works.\n";
    },

    'search_runtime_objects' => function() use ($adapter) {
        $tool = new SearchRuntimeObjects($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'search_runtime_objects');
        if (count($res['data']) < 1 || $res['data'][0]['entity_types'][0]['id'] !== 'node') {
            throw new \Exception("Failed to find expected search results.");
        }
        echo "  [PASS] search_runtime_objects works.\n";
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
    echo "\nALL OPS SMOKE TESTS PASSED SUCCESSFULLY!\n";
    exit(0);
} else {
    echo "\nSOME OPS SMOKE TESTS FAILED!\n";
    exit(1);
}
