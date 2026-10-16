<?php

require_once __DIR__ . '/../../vendor/autoload.php';

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Tools\InspectConfigObject;
use DrupalMcp\Config\Tools\TraceConfigDependencies;
use DrupalMcp\Config\Tools\FindConfigOwner;
use DrupalMcp\Config\Tools\AnalyzeConfigImpact;
use DrupalMcp\Config\Tools\InspectConfigSplitState;
use DrupalMcp\Config\Tools\InspectRecipeState;
use DrupalMcp\Config\Tools\SummarizeDeploymentRisk;
use DrupalMcp\Config\Tools\DebugStateSystem;
use DrupalMcp\Config\Tools\DiffActiveVsSync;
use DrupalMcp\Config\Tools\DetectConfigDrift;

// Prepend mock bin directory to PATH so our mock lando runs
$binDir = realpath(__DIR__ . '/../fixtures/bin');
putenv("PATH=" . $binDir . ":" . getenv("PATH"));

$projectRoot = realpath(__DIR__ . '/../fixtures');
echo "Running smoke tests against PROJECT_ROOT: $projectRoot\n\n";

try {
    $adapter = new DrushAdapter($projectRoot);
} catch (\Exception $e) {
    echo "[FAIL] Failed to construct DrushAdapter: " . $e->getMessage() . "\n";
    exit(1);
}

$tests = [
    'inspect_config_object' => function(DrushAdapter $adapter) {
        $tool = new InspectConfigObject($adapter);
        $res = $tool->execute('system.site', 'both');
        assertOk($res);
        assertEqual($res['data'][0]['active']['name'], 'system.site');
        assertEqual($res['data'][0]['sync']['name'], 'Mock Drupal Site (Sync)');
        return true;
    },
    'trace_config_dependencies' => function(DrushAdapter $adapter) {
        $tool = new TraceConfigDependencies($adapter);
        $res = $tool->execute('system.site');
        assertOk($res);
        assertContains($res['data'][0]['required_by'], 'user.settings');
        return true;
    },
    'find_config_owner' => function(DrushAdapter $adapter) {
        $tool = new FindConfigOwner($adapter);
        $res = $tool->execute('system.site');
        assertOk($res);
        assertEqual($res['data'][0]['owner_type'], 'unknown');
        return true;
    },
    'diff_active_vs_sync' => function(DrushAdapter $adapter) {
        $tool = new DiffActiveVsSync($adapter);
        $res = $tool->execute('system.site');
        assertOk($res);
        assertEqual($res['data'][0]['status'], 'changed');
        return true;
    },
    'detect_config_drift' => function(DrushAdapter $adapter) {
        $tool = new DetectConfigDrift($adapter);
        $res = $tool->execute();
        assertOk($res);
        return true;
    },
    'analyze_config_impact' => function(DrushAdapter $adapter) {
        $tool = new AnalyzeConfigImpact($adapter);
        $res = $tool->execute('system.site');
        assertOk($res);
        assertEqual($res['data'][0]['risk_level'], 'high');
        return true;
    },
    'inspect_config_split_state' => function(DrushAdapter $adapter) {
        $tool = new InspectConfigSplitState($adapter);
        $res = $tool->execute();
        assertOk($res);
        assertEqual($res['data'][0]['name'], 'dev');
        assertEqual($res['data'][0]['status'], true);
        return true;
    },
    'inspect_recipe_state' => function(DrushAdapter $adapter) {
        $tool = new InspectRecipeState($adapter);
        $res = $tool->execute('test_recipe');
        assertOk($res);
        assertEqual($res['data'][0]['recipe_name'], 'test_recipe');
        return true;
    },
    'summarize_deployment_risk' => function(DrushAdapter $adapter) {
        $tool = new SummarizeDeploymentRisk($adapter);
        $res = $tool->execute();
        assertOk($res);
        return true;
    },
    'debug_state_system' => function(DrushAdapter $adapter) {
        $tool = new DebugStateSystem($adapter);
        $res = $tool->execute(['system.cron_last'], 'system.');
        assertOk($res);
        assertEqual($res['data'][0]['system.cron_last'], 12345678);
        return true;
    }
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
