<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectContentTypes {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Node bundle machine name (e.g. article, page).")]
        ?string $bundle = null,
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
            $escapedBundle = $bundle ? addslashes($bundle) : '';
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$bundle = '$escapedBundle';
\$info = \\Drupal::service('entity_type.bundle.info')->getBundleInfo('node');
\$results = [];
foreach (\$info as \$id => \$data) {
    if (\$bundle && \$bundle !== \$id) continue;
    
    \$workflow = null;
    if (\\Drupal::moduleHandler()->moduleExists('content_moderation')) {
        \$workflows = \\Drupal::entityTypeManager()->getStorage('workflow')->loadMultiple();
        foreach (\$workflows as \$w) {
            \$config = \$w->getTypePlugin()->getConfiguration();
            if (isset(\$config['entity_types']['node']) && in_array(\$id, \$config['entity_types']['node'])) {
                \$workflow = \$w->id();
                break;
            }
        }
    }

    \$results[] = [
        'bundle' => \$id,
        'label' => (string)\$data['label'],
        'revisionable' => true,
        'workflow' => \$workflow,
    ];
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

            return Envelope::ok("Found " . $total . " content types.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_content_types'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_content_types'
            ]);
        }
    }
}
