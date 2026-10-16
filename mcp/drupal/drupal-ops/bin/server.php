<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
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
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up -> MCP client workspace roots). An unresolvable
// root surfaces as a clean ENV_NOT_READY tool error instead of killing the
// server at startup.
$adapter = new DrushAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-ops', '0.1.0')
    ->setContainer($container);

// Register Tools

$debugWatchdog = new DebugWatchdog($adapter);
$container->set(DebugWatchdog::class, $debugWatchdog);
$builder->addTool(
    handler: [DebugWatchdog::class, 'execute'],
    name: 'debug_watchdog',
    description: 'Query Drupal watchdog (dblog) entries by severity, type, message text, time range, request ID, or user. Use to trace specific errors or audit recent activity.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'wid'        => ['type' => 'integer', 'description' => 'Fetch a single entry by watchdog ID.'],
            'severity'   => ['type' => 'string', 'description' => 'Numeric severity filter: 0=Emergency, 3=Error, 4=Warning, 7=Debug.'],
            'type'       => ['type' => 'string', 'description' => 'Log channel/type (e.g. php, cron, system).'],
            'query'      => ['type' => 'string', 'description' => 'Substring to match against message text.'],
            'since'      => ['type' => 'string', 'description' => 'Start of time window. Accepts ISO datetime or relative (e.g. -1 hour, -24 hours).'],
            'until'      => ['type' => 'string', 'description' => 'End of time window. Same format as since.'],
            'request_id' => ['type' => 'string', 'description' => 'Filter to entries from a specific request ID.'],
            'uid'        => ['type' => 'integer', 'description' => 'Filter to entries from a specific user ID.'],
            'limit'      => ['type' => 'integer', 'default' => 50, 'description' => 'Max entries to return.'],
        ]
    ]
);

$debugQueueState = new DebugQueueState($adapter);
$container->set(DebugQueueState::class, $debugQueueState);
$builder->addTool(
    handler: [DebugQueueState::class, 'execute'],
    name: 'debug_queue_state',
    description: 'Inspect Drupal queue backends: item counts, age, and claimed-item counts. Use to detect backlogs or stuck workers.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'queue_name'             => ['type' => 'string', 'description' => 'Limit results to this queue name.'],
            'include_claimed'        => ['type' => 'boolean', 'default' => false, 'description' => 'Add count of items currently claimed (in-progress).'],
            'include_failed_samples' => ['type' => 'boolean', 'default' => false, 'description' => 'Add sample items that are stale or appear failed.'],
        ]
    ]
);

$debugCronState = new DebugCronState($adapter);
$container->set(DebugCronState::class, $debugCronState);
$builder->addTool(
    handler: [DebugCronState::class, 'execute'],
    name: 'debug_cron_state',
    description: 'Return cron last-run time, staleness status, and lock state. Use when cron-dependent features (mail, indexing, purge) appear delayed.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_recent_runs' => ['type' => 'boolean', 'default' => false, 'description' => 'Include recent cron run log entries from watchdog.'],
        ]
    ]
);

$debugCacheState = new DebugCacheState($adapter);
$container->set(DebugCacheState::class, $debugCacheState);
$builder->addTool(
    handler: [DebugCacheState::class, 'execute'],
    name: 'debug_cache_state',
    description: 'Inspect Drupal cache bins: existence, entry counts, and stale-entry ratios. Use to diagnose stale-content or cache-backend misconfiguration.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'bin'                   => ['type' => 'string', 'description' => 'Limit to a specific cache bin (e.g. default, render, config).'],
            'include_size_estimate' => ['type' => 'boolean', 'default' => false, 'description' => 'Add entry and stale-entry counts (requires DB queries; slower).'],
            'include_stale_samples' => ['type' => 'boolean', 'default' => false, 'description' => 'Add sample stale/invalidated entries for inspection.'],
        ]
    ]
);

$debugUpdateState = new DebugUpdateState($adapter);
$container->set(DebugUpdateState::class, $debugUpdateState);
$builder->addTool(
    handler: [DebugUpdateState::class, 'execute'],
    name: 'debug_update_state',
    description: 'Detect pending schema and entity-definition updates. Use pre- or post-deployment to confirm whether drush updb is needed.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_pending' => ['type' => 'boolean', 'default' => false, 'description' => 'List pending update hook details per module.'],
            'include_failed'  => ['type' => 'boolean', 'default' => false, 'description' => 'List update hooks that previously failed.'],
        ]
    ]
);

$debugEnvironmentSummary = new DebugEnvironmentSummary($adapter);
$container->set(DebugEnvironmentSummary::class, $debugEnvironmentSummary);
$builder->addTool(
    handler: [DebugEnvironmentSummary::class, 'execute'],
    name: 'debug_environment_summary',
    description: 'Return Drupal version, maintenance mode, PHP version, and DB driver. Use for quick site-environment orientation at the start of a session.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_runtime_versions' => ['type' => 'boolean', 'default' => false, 'description' => 'Add PHP version, DB driver, and cache backend details.'],
        ]
    ]
);

$debugStateSystem = new DebugStateSystem($adapter);
$container->set(DebugStateSystem::class, $debugStateSystem);
$builder->addTool(
    handler: [DebugStateSystem::class, 'execute'],
    name: 'debug_state_system',
    description: 'Read raw Drupal state store values by exact key, prefix, or preset profile. Use to inspect runtime flags such as maintenance mode, cron timestamps, or install state.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'keys'              => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Exact state keys to fetch (e.g. ["system.cron_last"]).'],
            'prefix'            => ['type' => 'string', 'description' => 'Fetch all keys whose name starts with this string.'],
            'allowlist_profile' => ['type' => 'string', 'description' => 'Preset key group to fetch: cron, maintenance, or update.'],
        ]
    ]
);

$debugRuntimeHealth = new DebugRuntimeHealth($adapter);
$container->set(DebugRuntimeHealth::class, $debugRuntimeHealth);
$builder->addTool(
    handler: [DebugRuntimeHealth::class, 'execute'],
    name: 'debug_runtime_health',
    description: 'Aggregate health check across cron, pending updates, and maintenance mode. Returns OK or WARNING with alert list. Use as first-call triage when site state is unknown.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'include_domains'         => ['type' => 'boolean', 'default' => false, 'description' => 'Add per-domain breakdown: env, updates, cron.'],
            'include_recommendations' => ['type' => 'boolean', 'default' => false, 'description' => 'Add remediation steps for each alert.'],
        ]
    ]
);

$debugFailedOperations = new DebugFailedOperations($adapter);
$container->set(DebugFailedOperations::class, $debugFailedOperations);
$builder->addTool(
    handler: [DebugFailedOperations::class, 'execute'],
    name: 'debug_failed_operations',
    description: 'Cross-domain failure scan: watchdog errors, stale queues, pending updates, cron staleness. Use for post-deployment triage or incident investigation.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'since'              => ['type' => 'string', 'description' => 'Scan failures after this time. ISO datetime or relative (e.g. -24 hours, 2026-01-01).'],
            'severity_threshold' => ['type' => 'integer', 'default' => 3, 'description' => 'Include watchdog entries at or below this level (0=Emergency, 3=Error, 7=Debug).'],
            'domains'            => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Domains to include. Omit for all. Values: watchdog, queues, updates, cron.'],
        ]
    ]
);

$inspectModules = new InspectModules($adapter);
$container->set(InspectModules::class, $inspectModules);
$builder->addTool(
    handler: [InspectModules::class, 'execute'],
    name: 'inspect_modules',
    description: 'List enabled Drupal modules with machine name, human name, and version. Use to confirm what is installed or resolve a module\'s machine name.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$inspectServices = new InspectServices($adapter);
$container->set(InspectServices::class, $inspectServices);
$builder->addTool(
    handler: [InspectServices::class, 'execute'],
    name: 'inspect_services',
    description: 'List Drupal service container entries with IDs and class names. Use to find a service ID for injection or verify a service is registered.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'limit'  => ['type' => 'integer', 'default' => 50, 'description' => 'Max services to return.'],
            'offset' => ['type' => 'integer', 'description' => 'Pagination offset.'],
            'query'  => ['type' => 'string', 'description' => 'Filter by service ID substring, or pass the full ID for an exact lookup.'],
        ]
    ]
);

$inspectPlugins = new InspectPlugins($adapter);
$container->set(InspectPlugins::class, $inspectPlugins);
$builder->addTool(
    handler: [InspectPlugins::class, 'execute'],
    name: 'inspect_plugins',
    description: 'List Drupal plugin instances by type (block, filter, condition, queue worker). Use to discover plugin IDs available for configuration or custom code.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$inspectRoutes = new InspectRoutes($adapter);
$container->set(InspectRoutes::class, $inspectRoutes);
$builder->addTool(
    handler: [InspectRoutes::class, 'execute'],
    name: 'inspect_routes',
    description: 'List or look up Drupal routes by name or path. Use to find a route name for access control, or to identify the controller behind a URL.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'limit'  => ['type' => 'integer', 'default' => 50, 'description' => 'Max routes to return.'],
            'offset' => ['type' => 'integer', 'description' => 'Pagination offset.'],
            'query'  => ['type' => 'string', 'description' => 'Route name substring, path substring, or exact path (prefix with / for exact match).'],
        ]
    ]
);

$searchRuntimeObjects = new SearchRuntimeObjects($adapter);
$container->set(SearchRuntimeObjects::class, $searchRuntimeObjects);
$builder->addTool(
    handler: [SearchRuntimeObjects::class, 'execute'],
    name: 'search_runtime_objects',
    description: 'Cross-search entity types, modules, and routes by keyword. Use when unsure which registry an object belongs to.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'query' => ['type' => 'string', 'description' => 'Keyword to match across entity types, modules, and routes. Leave empty to return a broad sample from all registries.'],
        ]
    ]
);

$server = $builder->build();
$server->run(new StdioTransport());
