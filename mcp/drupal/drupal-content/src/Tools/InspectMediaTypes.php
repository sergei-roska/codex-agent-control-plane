<?php

namespace DrupalMcp\Content\Tools;

use DrupalMcp\Content\Adapter\DrushAdapter;
use DrupalMcp\Content\Adapter\AdapterException;
use DrupalMcp\Content\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectMediaTypes {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Media bundle machine name.")]
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
if (!\\Drupal::moduleHandler()->moduleExists('media')) {
    return ['items' => [], 'total' => 0];
}
\$types = \\Drupal::entityTypeManager()->getStorage('media_type')->loadMultiple();
\$results = [];
foreach (\$types as \$id => \$type) {
    if (\$bundle && \$bundle !== \$id) continue;
    \$results[] = [
        'bundle' => \$id,
        'label' => (string)\$type->label(),
        'source_plugin' => \$type->getSource()->getPluginId(),
        'translatable' => \\Drupal::moduleHandler()->moduleExists('content_translation') && \\Drupal::service('content_translation.manager')->isEnabled('media', \$id),
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

            return Envelope::ok("Found " . $total . " media types.", $items, [
                'returned' => count($items),
                'total' => $total,
            ], [
                'tool' => 'inspect_media_types'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_media_types'
            ]);
        }
    }
}
