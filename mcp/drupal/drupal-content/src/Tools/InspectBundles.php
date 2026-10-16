<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectBundles {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Entity type machine name (e.g. node, taxonomy_term).")]
        string $entity_type_id,
        // Shared Args
        ?int $limit = 50,
        ?int $offset = null,
        ?string $sort = null,
        ?string $sort_direction = 'ASC',
        ?string $query = null,
        ?string $verbosity = 'minimal',
        ?bool $summary_only = false,
        ?bool $exclude_noise = true,
        ?int $max_chars = 10000,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $escapedTypeId = addslashes($entity_type_id);
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$info = \\Drupal::service('entity_type.bundle.info')->getBundleInfo('$escapedTypeId');
\$results = [];
foreach (\$info as \$bundle => \$data) {
    \$results[] = ['bundle' => \$bundle, 'label' => (string)\$data['label']];
}
\$total = count(\$results);
\$items = array_slice(\$results, $offsetVal, $limitVal);
return ['items' => \$items, 'total' => \$total];
PHP;

            $res = $this->adapter->evaluate($php);
            $items = $res['items'] ?? [];
            $total = $res['total'] ?? 0;

            if ($summary_only) {
                $items = [];
            }

            return Envelope::ok("Found " . $total . " bundles for entity type \"" . $entity_type_id . "\".", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_bundles'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_bundles'
            ]);
        }
    }
}
