<?php

require_once __DIR__ . '/../vendor/autoload.php';

use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Tools\InspectContentTypes;
use DrupalMcp\Content\Tools\InspectMediaTypes;
use DrupalMcp\Content\Tools\InspectTaxonomyModels;
use DrupalMcp\Content\Tools\InspectFieldUsage;
use DrupalMcp\Content\Tools\InspectReferenceGraph;
use DrupalMcp\Content\Tools\SummarizeEditorialModel;
use DrupalMcp\Content\Tools\InspectDisplayModes;
use DrupalMcp\Content\Tools\InspectRevisioning;
use DrupalMcp\Content\Tools\InspectTranslation;
use DrupalMcp\Content\Tools\InspectModeration;
use DrupalMcp\Content\Tools\InspectEntityTypes;
use DrupalMcp\Content\Tools\InspectBundles;
use DrupalMcp\Content\Tools\InspectFields;
use DrupalMcp\Content\Tools\InspectMenus;
use DrupalMcp\Content\Tools\InspectVocabularies;
use DrupalMcp\Content\Tools\InspectPermissions;
use DrupalMcp\SharedArgs\SharedArgsSchema;

// Project root resolution is lazy: the server always starts, and the root is
// auto-detected on the first tool call (PROJECT_ROOT env -> --project-root ->
// install path -> CWD walk-up -> MCP client workspace roots). An unresolvable
// root surfaces as a clean ENV_NOT_READY tool error instead of killing the
// server at startup.
$adapter = new DrushAdapter(null, null, $argv ?? null, __DIR__);

$container = new \Mcp\Capability\Registry\Container();

$builder = Server::builder()
    ->setServerInfo('drupal-content', '0.1.0')
    ->setContainer($container);

// Register Tools

$inspectContentTypes = new InspectContentTypes($adapter);
$container->set(InspectContentTypes::class, $inspectContentTypes);
$builder->addTool(
    handler: [InspectContentTypes::class, 'execute'],
    name: 'inspect_content_types',
    description: 'List node bundles (content types) with label, revision support, and workflow assignment.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'bundle' => ['type' => 'string', 'description' => 'Node bundle machine name (e.g. article, page).']
        ])
    ]
);

$inspectMediaTypes = new InspectMediaTypes($adapter);
$container->set(InspectMediaTypes::class, $inspectMediaTypes);
$builder->addTool(
    handler: [InspectMediaTypes::class, 'execute'],
    name: 'inspect_media_types',
    description: 'List media bundles with source plugin ID and translation status.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'bundle' => ['type' => 'string', 'description' => 'Media bundle machine name.']
        ])
    ]
);

$inspectTaxonomyModels = new InspectTaxonomyModels($adapter);
$container->set(InspectTaxonomyModels::class, $inspectTaxonomyModels);
$builder->addTool(
    handler: [InspectTaxonomyModels::class, 'execute'],
    name: 'inspect_taxonomy_models',
    description: 'List taxonomy vocabularies with IDs and labels.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'vocabulary' => ['type' => 'string', 'description' => 'Vocabulary machine name to filter by.']
        ])
    ]
);

$inspectFieldUsage = new InspectFieldUsage($adapter);
$container->set(InspectFieldUsage::class, $inspectFieldUsage);
$builder->addTool(
    handler: [InspectFieldUsage::class, 'execute'],
    name: 'inspect_field_usage',
    description: 'List fields on an entity type. Without bundle returns the field map across all bundles; with bundle returns fields for that bundle only.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'entity_type_id' => ['type' => 'string', 'description' => 'Entity type machine name (e.g. node, media, taxonomy_term).'],
            'bundle' => ['type' => 'string', 'description' => 'Bundle machine name to scope field lookup.']
        ])
    ]
);

$inspectReferenceGraph = new InspectReferenceGraph($adapter);
$container->set(InspectReferenceGraph::class, $inspectReferenceGraph);
$builder->addTool(
    handler: [InspectReferenceGraph::class, 'execute'],
    name: 'inspect_reference_graph',
    description: 'List entity_reference, entity_reference_revisions, image, and file fields showing source bundle → target entity type and allowed target bundles.'
);

$summarizeEditorialModel = new SummarizeEditorialModel($adapter);
$container->set(SummarizeEditorialModel::class, $summarizeEditorialModel);
$builder->addTool(
    handler: [SummarizeEditorialModel::class, 'execute'],
    name: 'summarize_editorial_model',
    description: 'Compact overview of an entity type: bundle count, top reference edges, and moderation state. Use before deeper inspection tools.'
);

$inspectDisplayModes = new InspectDisplayModes($adapter);
$container->set(InspectDisplayModes::class, $inspectDisplayModes);
$builder->addTool(
    handler: [InspectDisplayModes::class, 'execute'],
    name: 'inspect_display_modes',
    description: 'List available view modes and form modes for an entity type and bundle.'
);

$inspectRevisioning = new InspectRevisioning($adapter);
$container->set(InspectRevisioning::class, $inspectRevisioning);
$builder->addTool(
    handler: [InspectRevisioning::class, 'execute'],
    name: 'inspect_revisioning',
    description: 'Return whether an entity type is revisionable and has a revision UI handler.'
);

$inspectTranslation = new InspectTranslation($adapter);
$container->set(InspectTranslation::class, $inspectTranslation);
$builder->addTool(
    handler: [InspectTranslation::class, 'execute'],
    name: 'inspect_translation',
    description: 'Return whether content_translation is enabled for an entity type and bundle.'
);

$inspectModeration = new InspectModeration($adapter);
$container->set(InspectModeration::class, $inspectModeration);
$builder->addTool(
    handler: [InspectModeration::class, 'execute'],
    name: 'inspect_moderation',
    description: 'Return the content_moderation workflow assigned to a bundle and its available states.'
);

$inspectEntityTypes = new InspectEntityTypes($adapter);
$container->set(InspectEntityTypes::class, $inspectEntityTypes);
$builder->addTool(
    handler: [InspectEntityTypes::class, 'execute'],
    name: 'inspect_entity_types',
    description: 'List all registered entity types with ID, label, provider module, and storage class. Use to discover valid entity_type_id values.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$inspectBundles = new InspectBundles($adapter);
$container->set(InspectBundles::class, $inspectBundles);
$builder->addTool(
    handler: [InspectBundles::class, 'execute'],
    name: 'inspect_bundles',
    description: 'List bundles for an entity type. Call before inspect_fields to discover valid bundle names.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'entity_type_id' => ['type' => 'string', 'description' => 'Entity type machine name (e.g. node, taxonomy_term).']
        ])
    ]
);

$inspectFields = new InspectFields($adapter);
$container->set(InspectFields::class, $inspectFields);
$builder->addTool(
    handler: [InspectFields::class, 'execute'],
    name: 'inspect_fields',
    description: 'List fields (name, type, label, required, translatable) for an entity type. Omit bundle to get base fields only.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([
            'entity_type_id' => ['type' => 'string', 'description' => 'Entity type machine name (e.g. node, media).'],
            'bundle' => ['type' => 'string', 'description' => 'Bundle machine name; omit to get base fields only.']
        ])
    ]
);

$inspectMenus = new InspectMenus($adapter);
$container->set(InspectMenus::class, $inspectMenus);
$builder->addTool(
    handler: [InspectMenus::class, 'execute'],
    name: 'inspect_menus',
    description: 'List all registered menus with ID and label.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$inspectVocabularies = new InspectVocabularies($adapter);
$container->set(InspectVocabularies::class, $inspectVocabularies);
$builder->addTool(
    handler: [InspectVocabularies::class, 'execute'],
    name: 'inspect_vocabularies',
    description: 'List taxonomy vocabularies with vid and name.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$inspectPermissions = new InspectPermissions($adapter);
$container->set(InspectPermissions::class, $inspectPermissions);
$builder->addTool(
    handler: [InspectPermissions::class, 'execute'],
    name: 'inspect_permissions',
    description: 'List all user permissions with key, human label, and provider module. Supports query filter.',
    inputSchema: [
        'type' => 'object',
        'properties' => SharedArgsSchema::merge([])
    ]
);

$server = $builder->build();
$server->run(new StdioTransport());
