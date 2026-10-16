<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectTaxonomyModels {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Vocabulary machine name to filter by.")]
        ?string $vocabulary = null,
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
            $escapedVocab = $vocabulary ? addslashes($vocabulary) : '';
            $offsetVal = $offset ?: 0;
            $limitVal = $limit ?: 50;

            $php = <<<PHP
\$vocab = '$escapedVocab';
if (!\\Drupal::moduleHandler()->moduleExists('taxonomy')) {
    return ['items' => [], 'total' => 0];
}
\$storage = \\Drupal::entityTypeManager()->getStorage('taxonomy_vocabulary');
\$items = \$vocab ? [\$storage->load(\$vocab)] : \$storage->loadMultiple();
\$results = [];
foreach (\$items as \$v) {
    if (!\$v) continue;
    \$results[] = [
        'vocabulary' => \$v->id(),
        'label' => (string)\$v->label(),
    ];
}
\$total = count(\$results);
\$sliced = array_slice(\$results, $offsetVal, $limitVal);
return ['items' => \$sliced, 'total' => \$total];
PHP;

            $res = $this->adapter->evaluate($php);
            $items = $res['items'] ?? [];
            $total = $res['total'] ?? 0;

            if ($summary_only) {
                $items = [];
            }

            return Envelope::ok("Found " . $total . " vocabularies.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_taxonomy_models'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_taxonomy_models'
            ]);
        }
    }
}
