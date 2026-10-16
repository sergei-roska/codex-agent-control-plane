<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
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
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up -> MCP client workspace roots). An unresolvable
// root surfaces as a clean ENV_NOT_READY tool error instead of killing the
// server at startup.
$adapter = new DrushAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-config', '0.1.0')
    ->setContainer($container);

// Register Tools
$inspectConfigObject = new InspectConfigObject($adapter);
$container->set(InspectConfigObject::class, $inspectConfigObject);
$builder->addTool(
    handler: [InspectConfigObject::class, 'execute'],
    name: 'inspect_config_object',
    description: 'Read a specific configuration object from active storage, sync directory, or both.'
);

$traceConfigDependencies = new TraceConfigDependencies($adapter);
$container->set(TraceConfigDependencies::class, $traceConfigDependencies);
$builder->addTool(
    handler: [TraceConfigDependencies::class, 'execute'],
    name: 'trace_config_dependencies',
    description: 'Trace dependencies (what it requires) and dependents (what requires it) for a configuration object.'
);

$findConfigOwner = new FindConfigOwner($adapter);
$container->set(FindConfigOwner::class, $findConfigOwner);
$builder->addTool(
    handler: [FindConfigOwner::class, 'execute'],
    name: 'find_config_owner',
    description: 'Identify which module or theme provides the default/installation configuration file for a given config object.'
);

$analyzeConfigImpact = new AnalyzeConfigImpact($adapter);
$container->set(AnalyzeConfigImpact::class, $analyzeConfigImpact);
$builder->addTool(
    handler: [AnalyzeConfigImpact::class, 'execute'],
    name: 'analyze_config_impact',
    description: 'Analyze deployment risks, affected domains, and dependents for a configuration object before importing changes.'
);

$inspectConfigSplitState = new InspectConfigSplitState($adapter);
$container->set(InspectConfigSplitState::class, $inspectConfigSplitState);
$builder->addTool(
    handler: [InspectConfigSplitState::class, 'execute'],
    name: 'inspect_config_split_state',
    description: 'List config splits (config_split entities) with their status (active/inactive) and split configuration files.'
);

$inspectRecipeState = new InspectRecipeState($adapter);
$container->set(InspectRecipeState::class, $inspectRecipeState);
$builder->addTool(
    handler: [InspectRecipeState::class, 'execute'],
    name: 'inspect_recipe_state',
    description: 'Check status, managed configurations, and drift state of applied Drupal Recipes.'
);

$summarizeDeploymentRisk = new SummarizeDeploymentRisk($adapter);
$container->set(SummarizeDeploymentRisk::class, $summarizeDeploymentRisk);
$builder->addTool(
    handler: [SummarizeDeploymentRisk::class, 'execute'],
    name: 'summarize_deployment_risk',
    description: 'Generate a risk report of unexported configuration changes (drifts) and active splits before deployment.'
);

$debugStateSystem = new DebugStateSystem($adapter);
$container->set(DebugStateSystem::class, $debugStateSystem);
$builder->addTool(
    handler: [DebugStateSystem::class, 'execute'],
    name: 'debug_state_system',
    description: 'Read key-value data from the Drupal State system for specific allowed keys or profiles. Mirrored for availability in config context; canonical SQL impl lives in drupal-db-ops.'
);

$diffActiveVsSync = new DiffActiveVsSync($adapter);
$container->set(DiffActiveVsSync::class, $diffActiveVsSync);
$builder->addTool(
    handler: [DiffActiveVsSync::class, 'execute'],
    name: 'diff_active_vs_sync',
    description: 'Compare active configuration in the database with the configuration file in sync directory.'
);

$detectConfigDrift = new DetectConfigDrift($adapter);
$container->set(DetectConfigDrift::class, $detectConfigDrift);
$builder->addTool(
    handler: [DetectConfigDrift::class, 'execute'],
    name: 'detect_config_drift',
    description: 'Scan and list all configuration objects whose active database state differs from the sync directory files.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'prefix' => ['type' => 'string', 'description' => 'Filter results to configuration objects starting with this prefix.']
        ])
    ]
);

$server = $builder->build();
$server->run(new StdioTransport());
