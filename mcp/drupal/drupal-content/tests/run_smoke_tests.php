<?php

require_once __DIR__ . '/../vendor/autoload.php';

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

// Define Mock Adapter inline for smoke testing without a live Drupal site.
class MockDrushAdapter extends DrushAdapter {
    public function __construct() {
        // Skip parent constructor checking directory existence
    }

    public function getProjectRoot(): string {
        return '/mock/project/root';
    }

    public function getDrupalRoot(): string {
        return '/mock/project/root/web';
    }

    public function evaluate(string $phpCode): array {
        if (strpos($phpCode, "getBundleInfo('node')") !== false) {
            return [
                'items' => [
                    ['bundle' => 'article', 'label' => 'Article', 'revisionable' => true, 'workflow' => 'editorial'],
                    ['bundle' => 'page', 'label' => 'Basic Page', 'revisionable' => true, 'workflow' => null]
                ],
                'total' => 2
            ];
        }
        if (strpos($phpCode, "getBundleInfo('") !== false) {
            return [
                'items' => [
                    ['bundle' => 'article', 'label' => 'Article']
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "entityTypeManager()->getStorage('media_type')") !== false) {
            return [
                'items' => [
                    ['bundle' => 'image', 'label' => 'Image', 'source_plugin' => 'image', 'translatable' => true]
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "top_references") !== false) {
            return [
                'domain' => 'node',
                'bundle' => 'all',
                'bundles_count' => 2,
                'reference_edges' => 1,
                'moderation' => ['moderated' => true, 'workflow' => 'editorial', 'states' => ['draft', 'published']],
                'top_references' => [
                    ['bundle' => 'article', 'field' => 'field_image', 'type' => 'image', 'target_type' => 'file', 'target_bundles' => 'all']
                ]
            ];
        }
        if (strpos($phpCode, "entityTypeManager()->getStorage('taxonomy_vocabulary')") !== false) {
            if (strpos($phpCode, "vid") !== false) {
                return [
                    'items' => [
                        ['vid' => 'tags', 'name' => 'Tags']
                    ],
                    'total' => 1
                ];
            }
            return [
                'items' => [
                    ['vocabulary' => 'tags', 'label' => 'Tags']
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "entity_field.manager") !== false) {
            if (strpos($phpCode, "target_type") !== false) { // inspect_reference_graph
                return [
                    'items' => [
                        ['bundle' => 'article', 'field' => 'field_image', 'type' => 'entity_reference', 'target_type' => 'node', 'target_bundles' => 'all']
                    ]
                ];
            }
            if (strpos($phpCode, "getFieldMap()") !== false) { // inspect_field_usage
                return [
                    'items' => [
                        ['name' => 'field_image', 'type' => 'image', 'label' => 'Image', 'bundles' => ['article']]
                    ],
                    'total' => 1
                ];
            }
            return [ // inspect_fields
                'items' => [
                    ['field_name' => 'field_image', 'field_type' => 'image', 'label' => 'Image', 'required' => false, 'translatable' => true, 'provider' => 'image']
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "entity_display.repository") !== false) {
            return [
                'view_modes' => ['default', 'teaser'],
                'form_modes' => ['default']
            ];
        }
        if (strpos($phpCode, "isRevisionable()") !== false) {
            return [
                'revisionable' => true,
                'revision_ui' => true
            ];
        }
        if (strpos($phpCode, "content_translation.manager") !== false) {
            return [
                'translatable' => true,
                'module_enabled' => true
            ];
        }
        if (strpos($phpCode, "content_moderation") !== false) {
            return [
                'moderated' => true,
                'workflow' => 'editorial',
                'states' => ['draft', 'published']
            ];
        }
        if (strpos($phpCode, "entityTypeManager()->getDefinitions()") !== false) {
            return [
                'items' => [
                    ['entity_type_id' => 'node', 'label' => 'Content', 'provider' => 'node', 'class' => 'Drupal\node\Entity\Node', 'handlers' => ['storage' => 'Drupal\node\NodeStorage']]
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "entityTypeManager()->getStorage('menu')") !== false) {
            return [
                'items' => [
                    ['id' => 'main', 'label' => 'Main navigation']
                ],
                'total' => 1
            ];
        }
        if (strpos($phpCode, "user.permissions") !== false) {
            return [
                'items' => [
                    ['permission' => 'access content', 'title' => 'Access content', 'provider' => 'node']
                ],
                'total' => 1
            ];
        }

        return ['items' => [], 'total' => 0];
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
    'inspect_content_types' => function() use ($adapter) {
        $tool = new InspectContentTypes($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_content_types');
        if (count($res['data']) < 1 || $res['data'][0]['bundle'] !== 'article') {
            throw new \Exception("Failed to find article content type in results.");
        }
        echo "  [PASS] inspect_content_types works.\n";
    },

    'inspect_media_types' => function() use ($adapter) {
        $tool = new InspectMediaTypes($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_media_types');
        if (count($res['data']) < 1 || $res['data'][0]['bundle'] !== 'image') {
            throw new \Exception("Failed to find image media type in results.");
        }
        echo "  [PASS] inspect_media_types works.\n";
    },

    'inspect_taxonomy_models' => function() use ($adapter) {
        $tool = new InspectTaxonomyModels($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_taxonomy_models');
        if (count($res['data']) < 1 || $res['data'][0]['vocabulary'] !== 'tags') {
            throw new \Exception("Failed to find tags vocabulary in results.");
        }
        echo "  [PASS] inspect_taxonomy_models works.\n";
    },

    'inspect_field_usage' => function() use ($adapter) {
        $tool = new InspectFieldUsage($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_field_usage');
        if (count($res['data']) < 1 || $res['data'][0]['name'] !== 'field_image') {
            throw new \Exception("Failed to find field_image usage.");
        }
        echo "  [PASS] inspect_field_usage works.\n";
    },

    'inspect_reference_graph' => function() use ($adapter) {
        $tool = new InspectReferenceGraph($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_reference_graph');
        if (count($res['data']) < 1 || $res['data'][0]['field'] !== 'field_image') {
            throw new \Exception("Failed to find reference edge in graph.");
        }
        echo "  [PASS] inspect_reference_graph works.\n";
    },

    'summarize_editorial_model' => function() use ($adapter) {
        $tool = new SummarizeEditorialModel($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'summarize_editorial_model');
        if (count($res['data']) < 1 || $res['data'][0]['domain'] !== 'node') {
            throw new \Exception("Failed to summarize editorial model.");
        }
        echo "  [PASS] summarize_editorial_model works.\n";
    },

    'inspect_display_modes' => function() use ($adapter) {
        $tool = new InspectDisplayModes($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_display_modes');
        if (count($res['data']) < 1 || !in_array('teaser', $res['data'][0]['view_modes'])) {
            throw new \Exception("Failed to locate teaser view mode.");
        }
        echo "  [PASS] inspect_display_modes works.\n";
    },

    'inspect_revisioning' => function() use ($adapter) {
        $tool = new InspectRevisioning($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_revisioning');
        if (count($res['data']) < 1 || $res['data'][0]['revisionable'] !== true) {
            throw new \Exception("Failed to locate revisioning status.");
        }
        echo "  [PASS] inspect_revisioning works.\n";
    },

    'inspect_translation' => function() use ($adapter) {
        $tool = new InspectTranslation($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_translation');
        if (count($res['data']) < 1 || $res['data'][0]['translatable'] !== true) {
            throw new \Exception("Failed to locate translation status.");
        }
        echo "  [PASS] inspect_translation works.\n";
    },

    'inspect_moderation' => function() use ($adapter) {
        $tool = new InspectModeration($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_moderation');
        if (count($res['data']) < 1 || $res['data'][0]['moderated'] !== true) {
            throw new \Exception("Failed to locate moderation workflow.");
        }
        echo "  [PASS] inspect_moderation works.\n";
    },

    'inspect_entity_types' => function() use ($adapter) {
        $tool = new InspectEntityTypes($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_entity_types');
        if (count($res['data']) < 1 || $res['data'][0]['entity_type_id'] !== 'node') {
            throw new \Exception("Failed to inspect entity types.");
        }
        echo "  [PASS] inspect_entity_types works.\n";
    },

    'inspect_bundles' => function() use ($adapter) {
        $tool = new InspectBundles($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_bundles');
        if (count($res['data']) < 1 || $res['data'][0]['bundle'] !== 'article') {
            throw new \Exception("Failed to inspect bundles.");
        }
        echo "  [PASS] inspect_bundles works.\n";
    },

    'inspect_fields' => function() use ($adapter) {
        $tool = new InspectFields($adapter);
        $res = $tool->execute('node');
        assertEnvelope($res, 'inspect_fields');
        if (count($res['data']) < 1 || $res['data'][0]['field_name'] !== 'field_image') {
            throw new \Exception("Failed to inspect fields.");
        }
        echo "  [PASS] inspect_fields works.\n";
    },

    'inspect_menus' => function() use ($adapter) {
        $tool = new InspectMenus($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_menus');
        if (count($res['data']) < 1 || $res['data'][0]['id'] !== 'main') {
            throw new \Exception("Failed to inspect menus.");
        }
        echo "  [PASS] inspect_menus works.\n";
    },

    'inspect_vocabularies' => function() use ($adapter) {
        $tool = new InspectVocabularies($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_vocabularies');
        if (count($res['data']) < 1 || $res['data'][0]['vid'] !== 'tags') {
            throw new \Exception("Failed to inspect vocabularies.");
        }
        echo "  [PASS] inspect_vocabularies works.\n";
    },

    'inspect_permissions' => function() use ($adapter) {
        $tool = new InspectPermissions($adapter);
        $res = $tool->execute();
        assertEnvelope($res, 'inspect_permissions');
        if (count($res['data']) < 1 || $res['data'][0]['permission'] !== 'access content') {
            throw new \Exception("Failed to inspect permissions.");
        }
        echo "  [PASS] inspect_permissions works.\n";
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
    echo "\nALL CONTENT SMOKE TESTS PASSED SUCCESSFULLY!\n";
    exit(0);
} else {
    echo "\nSOME CONTENT SMOKE TESTS FAILED!\n";
    exit(1);
}
