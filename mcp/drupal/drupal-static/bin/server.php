<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
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
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up). An unresolvable root surfaces as a clean
// ENV_NOT_READY tool error instead of killing the server at startup.
$adapter = new FileAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-static', '0.1.0')
    ->setContainer($container);

// Register Tools
$listCustomModules = new ListCustomModules($adapter);
$container->set(ListCustomModules::class, $listCustomModules);
$builder->addTool(
    handler: [ListCustomModules::class, 'execute'],
    name: 'list_custom_modules',
    description: 'List installed custom modules and their paths by scanning the directory structure.'
);

$findHookImplementations = new FindHookImplementations($adapter);
$container->set(FindHookImplementations::class, $findHookImplementations);
$builder->addTool(
    handler: [FindHookImplementations::class, 'execute'],
    name: 'find_hook_implementations',
    description: 'Locate where a specific Drupal hook is implemented across all custom/contrib modules.'
);

$findServiceDefinitions = new FindServiceDefinitions($adapter);
$container->set(FindServiceDefinitions::class, $findServiceDefinitions);
$builder->addTool(
    handler: [FindServiceDefinitions::class, 'execute'],
    name: 'find_service_definitions',
    description: 'Map service IDs and PHP classes defined in *.services.yml files.'
);

$findEventSubscribers = new FindEventSubscribers($adapter);
$container->set(FindEventSubscribers::class, $findEventSubscribers);
$builder->addTool(
    handler: [FindEventSubscribers::class, 'execute'],
    name: 'find_event_subscribers',
    description: 'Identify Symfony event subscribers configured in service files or classes.'
);

$findPluginClasses = new FindPluginClasses($adapter);
$container->set(FindPluginClasses::class, $findPluginClasses);
$builder->addTool(
    handler: [FindPluginClasses::class, 'execute'],
    name: 'find_plugin_classes',
    description: 'Search for classes annotated or registered as plugins of a specific type.'
);

$findFormClasses = new FindFormClasses($adapter);
$container->set(FindFormClasses::class, $findFormClasses);
$builder->addTool(
    handler: [FindFormClasses::class, 'execute'],
    name: 'find_form_classes',
    description: 'Map form class names to their PHP file paths.'
);

$findControllerHandlers = new FindControllerHandlers($adapter);
$container->set(FindControllerHandlers::class, $findControllerHandlers);
$builder->addTool(
    handler: [FindControllerHandlers::class, 'execute'],
    name: 'find_controller_handlers',
    description: 'Map route definitions inside *.routing.yml files to their controller classes and methods.'
);

$findPreprocessFunctions = new FindPreprocessFunctions($adapter);
$container->set(FindPreprocessFunctions::class, $findPreprocessFunctions);
$builder->addTool(
    handler: [FindPreprocessFunctions::class, 'execute'],
    name: 'find_preprocess_functions',
    description: 'Identify theme preprocess functions in .theme and .module files.'
);

$findDrushCommands = new FindDrushCommands($adapter);
$container->set(FindDrushCommands::class, $findDrushCommands);
$builder->addTool(
    handler: [FindDrushCommands::class, 'execute'],
    name: 'find_drush_commands',
    description: 'Scan codebase for classes defining custom Drush commands.'
);

$traceRuntimeToCode = new TraceRuntimeToCode($adapter);
$container->set(TraceRuntimeToCode::class, $traceRuntimeToCode);
$builder->addTool(
    handler: [TraceRuntimeToCode::class, 'execute'],
    name: 'trace_runtime_to_code',
    description: 'Unified entry point to resolve a runtime symbol back to its static file location.'
);

$summarizeCodeInventory = new SummarizeCodeInventory($adapter);
$container->set(SummarizeCodeInventory::class, $summarizeCodeInventory);
$builder->addTool(
    handler: [SummarizeCodeInventory::class, 'execute'],
    name: 'summarize_code_inventory',
    description: 'Generates a narrative overview summarizing custom modules, total routes, and services discovered.'
);

$readSyncConfig = new ReadSyncConfig($adapter);
$container->set(ReadSyncConfig::class, $readSyncConfig);
$builder->addTool(
    handler: [ReadSyncConfig::class, 'execute'],
    name: 'read_sync_config',
    description: 'Reads config/sync/*.yml files statically from disk. Represents the target state in Git vs the active DB state.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'config_name' => ['type' => 'string', 'description' => 'Optional exact name or prefix (e.g., "system.site", "node.type.") of the configuration files to filter by.'],
            'pattern' => ['type' => 'string', 'description' => 'Optional case-insensitive substring filter for configuration filenames.']
        ])
    ]
);

$server = $builder->build();
$server->run(new StdioTransport());
