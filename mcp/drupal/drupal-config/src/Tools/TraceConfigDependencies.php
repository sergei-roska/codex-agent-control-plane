<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Adapter\AdapterException;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

class TraceConfigDependencies {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the configuration object to trace.")]
        string $config_name,
        #[Schema(description: "Maximum depth for traversing transitive dependencies.")]
        int $max_depth = 3,
        #[Schema(description: "Direction of trace: 'requires', 'required_by', or 'both'.", enum: ["requires", "required_by", "both"])]
        string $direction = 'both',
        ?RequestContext $context = null
    ): array {
        if (!in_array($direction, ['requires', 'required_by', 'both'], true)) {
            throw new \InvalidArgumentException("Direction must be one of: requires, required_by, both");
        }

        $this->adapter->setRequestContext($context);

        try {
            $php = <<<PHP
\$name = \$params['config_name'];
\$max_depth = \$params['max_depth'];
\$direction = \$params['direction'] ?? 'both';
\$config = \\Drupal::config(\$name);
if (\$config->isNew()) return ['error' => 'Config not found: ' . \$name];

\$dependencies = \$config->get('dependencies') ?: [];
\$dependents = [];

if (\$direction === 'required_by' || \$direction === 'both') {
    \$all_config = \\Drupal::service('config.storage')->listAll();
    foreach (\$all_config as \$c_name) {
        \$c_data = \\Drupal::service('config.storage')->read(\$c_name);
        \$deps = \$c_data['dependencies'] ?? [];
        foreach (\$deps as \$type => \$list) {
            if (is_array(\$list) && in_array(\$name, \$list)) {
                \$dependents[] = \$c_name;
                break;
            }
        }
    }
}

return [
    'name' => \$name,
    'requires' => \$dependencies,
    'required_by' => array_values(array_unique(\$dependents)),
];
PHP;
            
            try {
                $result = $this->adapter->evaluate($php, [
                    'config_name' => $config_name,
                    'max_depth' => $max_depth,
                    'direction' => $direction,
                ]);
                
                if (isset($result['error'])) {
                    throw new \Exception($result['error']);
                }
                
                $result['method'] = 'drush';
                
                return Envelope::ok("Dependency trace for " . $config_name . ".", [$result], [], [
                    'tool' => 'trace_config_dependencies'
                ]);
            } catch (\Exception $drushError) {
                // Fallback to sync storage files
                $syncDir = $this->findSyncDir();
                if (!$syncDir || !file_exists($syncDir . '/' . $config_name . '.yml')) {
                    throw new \Exception("Config " . $config_name . " not found in sync storage, and Drush failed: " . $drushError->getMessage());
                }
                
                $syncData = Yaml::parseFile($syncDir . '/' . $config_name . '.yml');
                $requires = $syncData['dependencies'] ?? [];
                
                $dependents = [];
                if ($direction === 'required_by' || $direction === 'both') {
                    $files = glob($syncDir . '/*.yml');
                    foreach ($files as $file) {
                        $fName = basename($file, '.yml');
                        if ($fName === $config_name) {
                            continue;
                        }
                        try {
                            $data = Yaml::parseFile($file);
                            $deps = $data['dependencies'] ?? [];
                            foreach ($deps as $type => $list) {
                                if (is_array($list) && in_array($config_name, $list)) {
                                    $dependents[] = $fName;
                                    break;
                                }
                            }
                        } catch (\Exception $e) {
                            // ignore
                        }
                    }
                }
                
                $result = [
                    'name' => $config_name,
                    'requires' => $requires,
                    'required_by' => array_values(array_unique($dependents)),
                    'method' => 'filesystem_fallback',
                    'warning' => 'Drush bootstrap failed: ' . $drushError->getMessage() . '. Results based on sync storage files.'
                ];
                
                return Envelope::ok("Dependency trace for " . $config_name . " (fallback).", [$result], [], [
                    'tool' => 'trace_config_dependencies'
                ]);
            }
        } catch (\Exception $e) {
            return Envelope::error('NOT_FOUND', $e->getMessage(), 'Verify config name and storage', [
                'tool' => 'trace_config_dependencies'
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
