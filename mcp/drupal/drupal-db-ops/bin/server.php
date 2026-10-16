<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Tools\DebugWatchdog;
use DrupalMcp\DbOps\Tools\DebugQueueState;
use DrupalMcp\DbOps\Tools\DebugCronState;
use DrupalMcp\DbOps\Tools\DebugCacheState;
use DrupalMcp\DbOps\Tools\DebugUpdateState;
use DrupalMcp\DbOps\Tools\DebugEnvironmentSummary;
use DrupalMcp\DbOps\Tools\DebugStateSystem;
use DrupalMcp\DbOps\Tools\DebugRuntimeHealth;
use DrupalMcp\DbOps\Tools\DebugFailedOperations;
use DrupalMcp\DbOps\Tools\InspectConfigObject;
use DrupalMcp\DbOps\Tools\DiffActiveVsSync;
use DrupalMcp\DbOps\Tools\DetectConfigDrift;
use DrupalMcp\DbOps\Tools\AnalyzeConfigImpact;
use DrupalMcp\DbOps\Tools\SummarizeDeploymentRisk;
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up -> MCP client workspace roots). An unresolvable
// root surfaces as a clean ENV_NOT_READY tool error instead of killing the
// server at startup.
$adapter = new PdoAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-db-ops', '0.1.0')
    ->setContainer($container);

// ============================================================
// Debug / operations tools (SQL-only equivalents of drupal-ops)
// ============================================================

$debugWatchdog = new DebugWatchdog($adapter);
$container->set(DebugWatchdog::class, $debugWatchdog);
$builder->addTool(
    handler: [DebugWatchdog::class, 'execute'],
    name: 'debug_watchdog',
    description: 'Query Drupal watchdog logs via SQL. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'wid'      => ['type' => 'integer', 'description' => 'Specific log entry ID (WID).'],
            'severity' => ['type' => 'string',  'description' => 'Filter by severity (0=Emergency..7=Debug).'],
            'type'     => ['type' => 'string',  'description' => 'Filter by log type/channel.'],
            'query'    => ['type' => 'string',  'description' => 'Substring search for message text.'],
            'since'    => ['type' => 'string',  'description' => 'Filter entries since datetime (e.g., -1 hour, 2026-01-01).'],
            'until'    => ['type' => 'string',  'description' => 'Filter entries until datetime.'],
            'uid'      => ['type' => 'integer', 'description' => 'Filter by user ID.'],
            'limit'    => ['type' => 'integer', 'default' => 50, 'description' => 'Max entries to return.'],
        ]
    ]
);

$debugQueueState = new DebugQueueState($adapter);
$container->set(DebugQueueState::class, $debugQueueState);
$builder->addTool(
    handler: [DebugQueueState::class, 'execute'],
    name: 'debug_queue_state',
    description: 'Inspect Drupal queue sizes and items via SQL. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'queue_name'             => ['type' => 'string',  'description' => 'Filter to specific queue.'],
            'include_claimed'        => ['type' => 'boolean', 'default' => false, 'description' => 'Include count of active/claimed in-progress items.'],
            'include_failed_samples' => ['type' => 'boolean', 'default' => false, 'description' => 'Include sample records of failed or stale queue items.'],
        ]
    ]
);

$debugCronState = new DebugCronState($adapter);
$container->set(DebugCronState::class, $debugCronState);
$builder->addTool(
    handler: [DebugCronState::class, 'execute'],
    name: 'debug_cron_state',
    description: 'Read Drupal cron execution timestamps and lock status via SQL. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_recent_runs' => ['type' => 'boolean', 'default' => false, 'description' => 'Include watchdog logs for recent cron runs.'],
        ]
    ]
);

$debugCacheState = new DebugCacheState($adapter);
$container->set(DebugCacheState::class, $debugCacheState);
$builder->addTool(
    handler: [DebugCacheState::class, 'execute'],
    name: 'debug_cache_state',
    description: 'List cache tables, entry counts, and stale items via SQL. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'bin'                   => ['type' => 'string',  'description' => 'Filter to specific cache bin (e.g., default, render, config).'],
            'include_size_estimate' => ['type' => 'boolean', 'default' => false, 'description' => 'Include estimated entry counts and stale record metrics.'],
            'include_stale_samples' => ['type' => 'boolean', 'default' => false, 'description' => 'Include sample stale cache keys (CIDs).'],
        ]
    ]
);

$debugUpdateState = new DebugUpdateState($adapter);
$container->set(DebugUpdateState::class, $debugUpdateState);
$builder->addTool(
    handler: [DebugUpdateState::class, 'execute'],
    name: 'debug_update_state',
    description: 'Query active module schema versions and scan filesystem for pending database updates. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_pending' => ['type' => 'boolean', 'default' => false, 'description' => 'Scan files to detect pending database update hooks.'],
            'include_failed'  => ['type' => 'boolean', 'default' => false, 'description' => 'Include detection of update failures.'],
        ]
    ]
);

$debugEnvironmentSummary = new DebugEnvironmentSummary($adapter);
$container->set(DebugEnvironmentSummary::class, $debugEnvironmentSummary);
$builder->addTool(
    handler: [DebugEnvironmentSummary::class, 'execute'],
    name: 'debug_environment_summary',
    description: 'Get Drupal version, maintenance mode status, and database details via SQL. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_runtime_versions' => ['type' => 'boolean', 'default' => false, 'description' => 'Include PHP, database server, host, and client versions.'],
        ]
    ]
);

$debugStateSystem = new DebugStateSystem($adapter);
$container->set(DebugStateSystem::class, $debugStateSystem);
$builder->addTool(
    handler: [DebugStateSystem::class, 'execute'],
    name: 'debug_state_system',
    description: 'Read Drupal State system variables from key_value table. Mirrored for availability in drupal-db-ops; canonical SQL implementation. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'keys'              => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Specific state keys to retrieve.'],
            'prefix'            => ['type' => 'string', 'description' => 'Filter state keys by prefix.'],
            'allowlist_profile' => ['type' => 'string', 'description' => 'Filter by key profile: cron, maintenance, or update.'],
        ]
    ]
);

$debugRuntimeHealth = new DebugRuntimeHealth($adapter);
$container->set(DebugRuntimeHealth::class, $debugRuntimeHealth);
$builder->addTool(
    handler: [DebugRuntimeHealth::class, 'execute'],
    name: 'debug_runtime_health',
    description: 'Analyze health status (maintenance mode, cron, db) using SQL data. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_domains'         => ['type' => 'boolean', 'default' => false, 'description' => 'Include status details per domain (env, updates, cron).'],
            'include_recommendations' => ['type' => 'boolean', 'default' => false, 'description' => 'Include suggested actions for warnings/errors.'],
        ]
    ]
);

$debugFailedOperations = new DebugFailedOperations($adapter);
$container->set(DebugFailedOperations::class, $debugFailedOperations);
$builder->addTool(
    handler: [DebugFailedOperations::class, 'execute'],
    name: 'debug_failed_operations',
    description: 'Scan database (watchdog, queue, updates) for system failures. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'since'              => ['type' => 'string',  'description' => 'Filter logs since datetime (e.g., -24 hours, 2026-01-01).'],
            'severity_threshold' => ['type' => 'integer', 'default' => 3, 'description' => 'Max watchdog severity level to report (0=Emergency to 3=Error).'],
            'domains'            => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Specific domains to scan: watchdog, queues, cron.'],
        ]
    ]
);

// ============================================================
// Config tools (SQL-only equivalents of drupal-config subset)
// ============================================================

$inspectConfigObject = new InspectConfigObject($adapter);
$container->set(InspectConfigObject::class, $inspectConfigObject);
$builder->addTool(
    handler: [InspectConfigObject::class, 'execute'],
    name: 'inspect_config_object',
    description: 'Retrieve Drupal active config from DB or sync directory files. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'config_name' => ['type' => 'string', 'description' => 'Name of the config object (e.g., system.site).'],
            'source'      => ['type' => 'string', 'default' => 'active', 'description' => 'Source storage: active (DB), sync (files), or both.'],
        ],
        'required' => ['config_name'],
    ]
);

$diffActiveVsSync = new DiffActiveVsSync($adapter);
$container->set(DiffActiveVsSync::class, $diffActiveVsSync);
$builder->addTool(
    handler: [DiffActiveVsSync::class, 'execute'],
    name: 'diff_active_vs_sync',
    description: 'Diff active DB config against sync directory files. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'config_name'   => ['type' => 'string',  'description' => 'Name of the config object to compare.'],
            'include_patch' => ['type' => 'boolean', 'default' => false, 'description' => 'Include raw data representation of both sides.'],
        ],
        'required' => ['config_name'],
    ]
);

$detectConfigDrift = new DetectConfigDrift($adapter);
$container->set(DetectConfigDrift::class, $detectConfigDrift);
$builder->addTool(
    handler: [DetectConfigDrift::class, 'execute'],
    name: 'detect_config_drift',
    description: 'Compare active database config table against sync directory files to find drift. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'prefix' => ['type' => 'string', 'description' => 'Filter config names by prefix (e.g., node.type.).'],
        ])
    ]
);

$analyzeConfigImpact = new AnalyzeConfigImpact($adapter);
$container->set(AnalyzeConfigImpact::class, $analyzeConfigImpact);
$builder->addTool(
    handler: [AnalyzeConfigImpact::class, 'execute'],
    name: 'analyze_config_impact',
    description: 'Evaluate deployment risk and impact of config changes via SQL diff. No Drupal container required.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'config_name' => ['type' => 'string', 'description' => 'Name of the config object to analyze.'],
        ],
        'required' => ['config_name'],
    ]
);

$summarizeDeploymentRisk = new SummarizeDeploymentRisk($adapter);
$container->set(SummarizeDeploymentRisk::class, $summarizeDeploymentRisk);
$builder->addTool(
    handler: [SummarizeDeploymentRisk::class, 'execute'],
    name: 'summarize_deployment_risk',
    description: 'Summarize overall risk based on configuration drift. No Drupal container required.'
);

$server = $builder->build();
$server->run(new StdioTransport());
