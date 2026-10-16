<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
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
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up -> MCP client workspace roots). An unresolvable
// root surfaces as a clean ENV_NOT_READY tool error instead of killing the
// server at startup.
$adapter = new DrushAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-render', '0.1.0')
    ->setContainer($container);

// Register Tools

$inspectThemeState = new InspectThemeState($adapter);
$container->set(InspectThemeState::class, $inspectThemeState);
$builder->addTool(
    handler: [InspectThemeState::class, 'execute'],
    name: 'inspect_theme_state',
    description: 'Returns active theme name, admin theme, base-theme inheritance chain, path, and defined regions.',
    inputSchema: [
        'type' => 'object',
        'properties' => new \stdClass()
    ]
);

$inspectTemplateSuggestions = new InspectTemplateSuggestions($adapter);
$container->set(InspectTemplateSuggestions::class, $inspectTemplateSuggestions);
$builder->addTool(
    handler: [InspectTemplateSuggestions::class, 'execute'],
    name: 'inspect_template_suggestions',
    description: 'Lists template filename candidates for a theme hook, highest-specificity last. Use to find the correct filename for a theme override.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'theme_hook' => ['type' => 'string', 'description' => 'Theme hook name, e.g. `node`, `block`, `page`'],
        ]
    ]
);

$traceTemplateResolution = new TraceTemplateResolution($adapter);
$container->set(TraceTemplateResolution::class, $traceTemplateResolution);
$builder->addTool(
    handler: [TraceTemplateResolution::class, 'execute'],
    name: 'trace_template_resolution',
    description: 'Resolves a theme hook to its active template: filename, filesystem path, hook type, and associated preprocess functions.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'theme_hook' => ['type' => 'string', 'description' => 'Theme hook name from the theme registry, e.g. `node`, `page`, `block`'],
        ]
    ]
);

$findPreprocessChain = new FindPreprocessChain($adapter);
$container->set(FindPreprocessChain::class, $findPreprocessChain);
$builder->addTool(
    handler: [FindPreprocessChain::class, 'execute'],
    name: 'find_preprocess_chain',
    description: 'Returns ordered preprocess function list for a theme hook. Use to audit what runs before a template renders.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'theme_hook' => ['type' => 'string', 'description' => 'Theme hook name, e.g. `node`, `block`'],
        ]
    ]
);

$inspectRenderArray = new InspectRenderArray($adapter);
$container->set(InspectRenderArray::class, $inspectRenderArray);
$builder->addTool(
    handler: [InspectRenderArray::class, 'execute'],
    name: 'inspect_render_array',
    description: 'Builds and returns the render array structure for a node or block, truncated at max_depth. #cache and #attached keys are stripped.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'target_type' => ['type' => 'string', 'enum' => ['node', 'block'], 'description' => 'Entity type: `node` or `block`'],
            'target_id'   => ['type' => 'string', 'description' => 'Numeric node ID or block machine name'],
            'view_mode'   => ['type' => 'string', 'description' => 'Render view mode; default `full`', 'default' => 'full'],
            'max_depth'   => ['type' => 'integer', 'description' => 'Array traversal depth limit; default 3', 'default' => 3],
        ]
    ]
);

$inspectLibraryAttachments = new InspectLibraryAttachments($adapter);
$container->set(InspectLibraryAttachments::class, $inspectLibraryAttachments);
$builder->addTool(
    handler: [InspectLibraryAttachments::class, 'execute'],
    name: 'inspect_library_attachments',
    description: 'Returns `#attached` library list and drupalSettings keys from the render array of a node or block.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'target_type' => ['type' => 'string', 'enum' => ['node', 'block'], 'description' => 'Entity type: `node` or `block`'],
            'target_id'   => ['type' => 'string', 'description' => 'Numeric node ID or block machine name'],
        ]
    ]
);

$inspectBlocksAndRegions = new InspectBlocksAndRegions($adapter);
$container->set(InspectBlocksAndRegions::class, $inspectBlocksAndRegions);
$builder->addTool(
    handler: [InspectBlocksAndRegions::class, 'execute'],
    name: 'inspect_blocks_and_regions',
    description: 'Lists blocks placed in the active theme with region, plugin ID, weight, and status. Filter by region machine name to narrow results.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'region' => ['type' => 'string', 'description' => 'Region machine name to filter, e.g. `header`, `sidebar_first`; omit for all regions'],
        ]
    ]
);

$inspectSdcComponents = new InspectSdcComponents($adapter);
$container->set(InspectSdcComponents::class, $inspectSdcComponents);
$builder->addTool(
    handler: [InspectSdcComponents::class, 'execute'],
    name: 'inspect_sdc_components',
    description: 'Lists all registered SDC definitions, or returns full definition for one component. Requires SDC module enabled.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'component_id' => ['type' => 'string', 'description' => 'SDC plugin ID to inspect, e.g. `my_theme:card`; omit to list all'],
        ]
    ]
);

$summarizeRenderPath = new SummarizeRenderPath($adapter);
$container->set(SummarizeRenderPath::class, $summarizeRenderPath);
$builder->addTool(
    handler: [SummarizeRenderPath::class, 'execute'],
    name: 'summarize_render_path',
    description: 'Single-call render path summary for a node or block: theme hook, resolved template, preprocess function count, and attached libraries.',
    inputSchema: [
        'type' => 'object',
        'properties' => [
            'target_type' => ['type' => 'string', 'enum' => ['node', 'block'], 'description' => 'Entity type: `node` or `block`'],
            'target_id'   => ['type' => 'string', 'description' => 'Numeric node ID or block machine name'],
        ]
    ]
);

$inspectThemes = new InspectThemes($adapter);
$container->set(InspectThemes::class, $inspectThemes);
$builder->addTool(
    handler: [InspectThemes::class, 'execute'],
    name: 'inspect_themes',
    description: 'Lists installed themes with machine name, label, default/admin flags, and enabled status.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$server = $builder->build();
$server->run(new StdioTransport());
