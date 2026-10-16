<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectConfigSplitState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of a specific split to inspect. If omitted, returns all splits.")]
        ?string $split_name = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<PHP
if (!\\Drupal::moduleHandler()->moduleExists('config_split')) return [];
\$storage = \\Drupal::entityTypeManager()->getStorage('config_split');
\$splits = \$params['split_name'] ? \$storage->loadMultiple([\$params['split_name']]) : \$storage->loadMultiple();
\$results = [];
foreach (\$splits as \$s) {
  \$results[] = [
    'name' => \$s->id(),
    'label' => (string)\$s->label(),
    'status' => \$s->status(),
    'folder' => \$s->get('folder'),
    'complete_list' => \$s->get('complete_list') ?: [],
    'partial_list' => \$s->get('partial_list') ?: [],
    'include_count' => count(\$s->get('complete_list') ?: []),
    'exclude_count' => count(\$s->get('partial_list') ?: []),
  ];
}
return \$results;
PHP;
            
            $results = $this->adapter->evaluate($php, ['split_name' => $split_name]);
            
            return Envelope::ok("Found " . count($results) . " configuration splits.", $results, [], [
                'tool' => 'inspect_config_split_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::ok("Config Split State: offline or module not installed. Error: " . $e->getMessage(), [], [], [
                'tool' => 'inspect_config_split_state'
            ]);
        }
    }
}
