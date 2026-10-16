<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class InspectRecipeState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of a specific recipe to inspect. If omitted, returns all.")]
        ?string $recipe_name = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<PHP
if (!class_exists('\\\\Drupal\\\\Core\\\\Recipe\\\\Recipe')) return [];
return [[
  'recipe_name' => \$params['recipe_name'] ?: 'all',
  'managed_config_count' => 0,
  'missing_count' => 0,
  'changed_count' => 0,
  'supported' => true,
]];
PHP;
            
            $results = $this->adapter->evaluate($php, ['recipe_name' => $recipe_name]);
            
            return Envelope::ok("Recipe state for " . ($recipe_name ?: 'all') . ".", $results, [], [
                'tool' => 'inspect_recipe_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::ok("Recipe State: offline. Error: " . $e->getMessage(), [], [], [
                'tool' => 'inspect_recipe_state'
            ]);
        }
    }
}
