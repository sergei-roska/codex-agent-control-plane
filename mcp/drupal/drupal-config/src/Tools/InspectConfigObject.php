<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Adapter\AdapterException;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

class InspectConfigObject {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the configuration object (e.g., 'system.site').")]
        string $config_name,
        #[Schema(description: "Storage source to read from: 'active', 'sync', or 'both'.")]
        string $source = 'active',
        #[Schema(description: "Set to true to include runtime overrides from settings.php (active storage only).")]
        bool $include_overrides = true,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $results = ['config_name' => $config_name];
            $warning = null;
            
            if ($source === 'active' || $source === 'both') {
                try {
                    $php = <<<PHP
\$name = \$params['config_name'];
\$config = \\Drupal::config(\$name);
if (\$config->isNew()) return null;
\$results = [
    'name' => \$name,
    'data' => \$config->getRawData(),
];
if (\$params['include_overrides']) {
    \$results['overrides'] = \$config->get();
}
return \$results;
PHP;
                    $activeData = $this->adapter->evaluate($php, [
                        'config_name' => $config_name,
                        'include_overrides' => $include_overrides
                    ]);
                    $results['active'] = $activeData;
                } catch (\Exception $e) {
                    $warning = "Active storage unavailable: " . $e->getMessage();
                    $results['active'] = null;
                }
            }
            
            if ($source === 'sync' || $source === 'both') {
                $syncDir = $this->findSyncDir();
                if ($syncDir && file_exists($syncDir . '/' . $config_name . '.yml')) {
                    try {
                        $results['sync'] = Yaml::parseFile($syncDir . '/' . $config_name . '.yml');
                    } catch (\Exception $e) {
                        $results['sync'] = null;
                    }
                } else {
                    $results['sync'] = null;
                }
            }
            
            $summary = "Inspected " . $config_name . " from " . $source . ".";
            if ($warning) {
                $summary .= " (Warning: " . $warning . ")";
            }
            
            return Envelope::ok($summary, [$results], [], [
                'tool' => 'inspect_config_object'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('PARSE_ERROR', $e->getMessage(), 'Verify active and sync storages', [
                'tool' => 'inspect_config_object'
            ]);
        }
    }

    private function findSyncDir(): ?string {
        $locations = [
            'config/sync',
            '../config/sync',
            'sites/default/files/config_sync',
        ];
        
        $docroot = $this->adapter->getDrupalRoot();
        $projectRoot = $this->adapter->getProjectRoot();
        
        foreach ($locations as $loc) {
            $dir = $docroot . '/' . ltrim($loc, '/');
            if (is_dir($dir)) return realpath($dir);
            $dir = $projectRoot . '/' . ltrim($loc, '/');
            if (is_dir($dir)) return realpath($dir);
        }
        return null;
    }
}
