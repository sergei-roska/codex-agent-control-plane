<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectBlocksAndRegions {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?string $region = null, ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$theme = \Drupal::config('system.theme')->get('default');
$region_filter = $params['region'] ?? null;
$blocks = \Drupal::entityTypeManager()->getStorage('block')->loadByProperties(['theme' => $theme]);
$data = [];
foreach ($blocks as $block) {
    if ($region_filter && $block->getRegion() !== $region_filter) continue;
    $data[] = [
        'id' => $block->id(),
        'label' => $block->label(),
        'region' => $block->getRegion(),
        'plugin_id' => $block->getPluginId(),
        'weight' => $block->getWeight(),
        'status' => (bool)$block->status(),
    ];
}
return $data;
PHP;

            $result = $this->adapter->evaluate($php, ['region' => $region]);
            $count = count($result);

            return Envelope::ok(
                "Found {$count} blocks placed in theme regions.",
                $result,
                ['returned' => $count, 'total' => $count],
                ['tool' => 'inspect_blocks_and_regions']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_blocks_and_regions'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_blocks_and_regions'
            ]);
        }
    }
}
