<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindConfigOwner {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the configuration object to find the owner for.")]
        string $config_name,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<PHP
\$name = \$params['config_name'];
\$module_handler = \\Drupal::moduleHandler();
foreach (\$module_handler->getModuleList() as \$module => \$extension) {
  if (file_exists(\$extension->getPath() . '/config/install/' . \$name . '.yml')) {
     return ['name' => \$name, 'owner_type' => 'module', 'owner_name' => \$module, 'install_path' => \$extension->getPath(), 'confidence' => 1.0];
  }
  if (file_exists(\$extension->getPath() . '/config/optional/' . \$name . '.yml')) {
     return ['name' => \$name, 'owner_type' => 'module (optional)', 'owner_name' => \$module, 'install_path' => \$extension->getPath(), 'confidence' => 0.9];
  }
}
return ['name' => \$name, 'owner_type' => 'unknown', 'owner_name' => 'unknown', 'confidence' => 0.1];
PHP;
            
            $result = $this->adapter->evaluate($php, ['config_name' => $config_name]);
            
            return Envelope::ok("Owner detected for " . $config_name . ".", [$result], [], [
                'tool' => 'find_config_owner'
            ]);
        } catch (\Exception $e) {
            $fallbackResult = [
                'name' => $config_name,
                'owner_type' => 'unknown',
                'owner_name' => 'unknown',
                'confidence' => 0,
                'warning' => 'Drush execution failed: ' . $e->getMessage()
            ];
            return Envelope::ok("Owner detection failed (fallback).", [$fallbackResult], [], [
                'tool' => 'find_config_owner'
            ]);
        }
    }
}
