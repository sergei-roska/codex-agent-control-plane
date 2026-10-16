<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugCacheState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Filter to a specific cache bin (e.g. default, render, config)")]
        ?string $bin = null,
        #[Schema(description: "Include entry count and stale count estimates (more expensive)")]
        ?bool $include_size_estimate = false,
        #[Schema(description: "Include samples of stale/invalidated entries")]
        ?bool $include_stale_samples = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($bin !== null) $params['bin'] = $bin;
            if ($include_size_estimate !== null) $params['include_size_estimate'] = $include_size_estimate;
            if ($include_stale_samples !== null) $params['include_stale_samples'] = $include_stale_samples;

            $php = <<<'PHP'
$bin_filter = $params['bin'] ?? null;
$include_size = !empty($params['include_size_estimate']);
$bins = $bin_filter ? [$bin_filter] : ['default', 'render', 'config', 'discovery', 'data', 'dynamic_page_cache', 'page'];
$stats = [];
$schema = \Drupal::database()->schema();
foreach ($bins as $b) {
    $table = 'cache_' . $b;
    if ($schema->tableExists($table)) {
        $stat = ['bin' => $b];
        if ($include_size) {
            $stat['entry_count'] = (int)\Drupal::database()->select($table)->countQuery()->execute()->fetchField();
            $invalidated = (int)\Drupal::database()->select($table, 'c')->condition('expire', 0, '!=')->condition('expire', time(), '<')->countQuery()->execute()->fetchField();
            $stat['stale_count'] = $invalidated;
            if ($stat['entry_count'] > 0) $stat['invalidation_ratio'] = round($invalidated / $stat['entry_count'], 4);
        } else { $stat['status'] = 'EXISTS'; }
        $stats[] = $stat;
    }
}
return $stats;
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $items = is_array($res) ? $res : [];

            return Envelope::ok(
                "Found " . count($items) . " cache bin(s).",
                $items,
                ['returned' => count($items), 'total' => count($items)],
                ['tool' => 'debug_cache_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_cache_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_cache_state'
            ]);
        }
    }
}
