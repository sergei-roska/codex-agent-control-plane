<?php

namespace DrupalMcp\Render\Tools;

use DrupalMcp\Render\Adapter\DrushAdapter;
use DrupalMcp\Render\Adapter\AdapterException;
use DrupalMcp\Render\Support\Envelope;
use Mcp\Server\RequestContext;

class InspectSdcComponents {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?string $component_id = null, ?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
if (!\Drupal::hasService('plugin.manager.sdc')) {
    return ['error' => 'SDC module not enabled or not supported in this Drupal version.'];
}
$manager = \Drupal::service('plugin.manager.sdc');
$definitions = $manager->getDefinitions();
$component_id = $params['component_id'] ?? null;
if ($component_id) {
    return isset($definitions[$component_id]) ? [$definitions[$component_id]] : ['error' => 'Component not found: ' . $component_id];
}
$summary = [];
foreach ($definitions as $id => $def) {
    $summary[] = [
        'id' => $id,
        'extension' => $def['provider'] ?? 'unknown',
        'path' => $def['path'] ?? '',
        'has_schema' => isset($def['props']),
    ];
}
return $summary;
PHP;

            $result = $this->adapter->evaluate($php, ['component_id' => $component_id]);

            if ($component_id) {
                $summary = "SDC component {$component_id}.";
                $count = count($result);
            } else {
                $count = count($result);
                $summary = "Found {$count} SDC components.";
            }

            return Envelope::ok(
                $summary,
                $result,
                ['returned' => $count, 'total' => $count],
                ['tool' => 'inspect_sdc_components']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'inspect_sdc_components'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_sdc_components'
            ]);
        }
    }
}
