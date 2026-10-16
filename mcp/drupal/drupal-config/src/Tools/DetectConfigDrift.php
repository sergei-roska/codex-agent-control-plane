<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DetectConfigDrift {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter results to configuration objects starting with this prefix.")]
        ?string $prefix = null,
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
            $php = <<<PHP
\$prefix = \$params['prefix'] ?? '';
\$sync = \\Drupal::service('config.storage.sync');
\$active = \\Drupal::service('config.storage');

\$comparer = new \\Drupal\\Core\\Config\\StorageComparer(\$sync, \$active);
\$comparer->createChangelist();
\$changelist = \$comparer->getChangelist();

\$results = [];
foreach (\$changelist as \$op => \$items) {
  foreach (\$items as \$name) {
    if (\$prefix && strpos(\$name, \$prefix) !== 0) continue;
    \$results[] = ['name' => \$name, 'operation' => \$op];
  }
}
return ['items' => \$results, 'drift_count' => count(\$results), 'ignored_count' => 0];
PHP;
            
            $result = $this->adapter->evaluate($php, ['prefix' => $prefix]);
            
            $items = $result['items'] ?? [];
            
            // Filter query
            if ($query) {
                $items = array_filter($items, function($item) use ($query) {
                    return stripos($item['name'], $query) !== false;
                });
            }
            
            $totalCount = count($items);
            
            // Sort
            $sortField = $sort ?: 'name';
            usort($items, function($a, $b) use ($sortField, $sort_direction) {
                $valA = $a[$sortField] ?? '';
                $valB = $b[$sortField] ?? '';
                $cmp = strcmp($valA, $valB);
                return ($sort_direction === 'DESC') ? -$cmp : $cmp;
            });
            
            // Paginate
            $offsetVal = $offset ?: 0;
            if ($offsetVal > 0) {
                $items = array_slice($items, $offsetVal);
            }
            $limitVal = $limit ?: 50;
            if ($limitVal > 0) {
                $items = array_slice($items, 0, $limitVal);
            }
            
            $data = $summary_only ? [] : array_values($items);
            
            // Truncation check
            $truncated = false;
            if (!$summary_only) {
                $json = json_encode($data);
                if (strlen($json) > $max_chars) {
                    $truncated = true;
                    while (count($data) > 1 && strlen(json_encode($data)) > $max_chars) {
                        array_pop($data);
                    }
                    if (strlen(json_encode($data)) > $max_chars) {
                        $jsonStr = json_encode($data);
                        $data = [substr($jsonStr, 0, $max_chars) . '... [TRUNCATED]'];
                    }
                }
            }
            
            $summary = "Found " . $totalCount . " drifting config objects.";
            
            return Envelope::ok(
                $summary,
                $data,
                [
                    'returned' => count($data),
                    'total' => $totalCount,
                    'truncated' => $truncated
                ],
                [
                    'tool' => 'detect_config_drift'
                ]
            );
        } catch (\Exception $e) {
            $fallbackResult = [
                'drift_count' => null,
                'items' => [],
                'ignored_count' => 0,
                'warning' => 'Drift detection failed: ' . $e->getMessage()
            ];
            
            return Envelope::ok("Drift detection unavailable (fallback).", [$fallbackResult], [], [
                'tool' => 'detect_config_drift'
            ]);
        }
    }
}
