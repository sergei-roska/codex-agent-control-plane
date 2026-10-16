<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

class DiffActiveVsSync {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the configuration object to compare.")]
        string $config_name,
        #[Schema(description: "Set to true to return the raw content difference (JSON representation of active and sync data).")]
        bool $include_patch = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            // Read active config
            $activeData = null;
            try {
                $php = <<<PHP
\$name = \$params['config_name'];
\$config = \\Drupal::config(\$name);
if (\$config->isNew()) return null;
return [
    'name' => \$name,
    'data' => \$config->getRawData(),
];
PHP;
                $activeData = $this->adapter->evaluate($php, ['config_name' => $config_name]);
            } catch (\Exception $e) {
                // Active storage unavailable
            }
            
            // Read sync config
            $syncData = null;
            $syncDir = $this->findSyncDir();
            if ($syncDir && file_exists($syncDir . '/' . $config_name . '.yml')) {
                try {
                    $syncData = Yaml::parseFile($syncDir . '/' . $config_name . '.yml');
                } catch (\Exception $e) {
                    // ignore
                }
            }
            
            if (!$activeData && !$syncData) {
                $result = [
                    'name' => $config_name,
                    'status' => 'missing_both',
                    'changed_keys' => [],
                    'risk_level' => 'low',
                    'method' => 'drush'
                ];
            } elseif (!$activeData) {
                $result = [
                    'name' => $config_name,
                    'status' => 'added',
                    'changed_keys' => array_keys($syncData),
                    'risk_level' => 'low',
                    'method' => 'drush'
                ];
            } elseif (!$syncData) {
                $result = [
                    'name' => $config_name,
                    'status' => 'removed',
                    'changed_keys' => array_keys($activeData['data']),
                    'risk_level' => 'high',
                    'method' => 'drush'
                ];
            } else {
                $activeRaw = $activeData['data'];
                $changedKeys = $this->getChangedKeys($activeRaw, $syncData);
                $status = empty($changedKeys) ? 'identical' : 'changed';
                $risk = $this->assessRisk($config_name, $changedKeys);
                
                $result = [
                    'name' => $config_name,
                    'status' => $status,
                    'changed_keys' => $changedKeys,
                    'risk_level' => $risk,
                    'method' => 'drush'
                ];
                
                if ($include_patch && $status === 'changed') {
                    $result['patch'] = json_encode(['active' => $activeRaw, 'sync' => $syncData], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
                }
            }
            
            return Envelope::ok("Diff for " . $config_name . ". Status: " . $result['status'] . ".", [$result], [], [
                'tool' => 'diff_active_vs_sync'
            ]);
        } catch (\Exception $e) {
            $syncDir = $this->findSyncDir();
            $syncExists = $syncDir && file_exists($syncDir . '/' . $config_name . '.yml');
            
            $fallbackResult = [
                'name' => $config_name,
                'status' => $syncExists ? 'active_unavailable' : 'missing_both',
                'changed_keys' => [],
                'risk_level' => 'medium',
                'warning' => 'Diff unavailable: Drush bootstrap failed. Error: ' . $e->getMessage(),
                'method' => 'filesystem_fallback'
            ];
            
            return Envelope::ok("Error performing diff (fallback).", [$fallbackResult], [], [
                'tool' => 'diff_active_vs_sync'
            ]);
        }
    }

    private function getChangedKeys(array $a, array $b): array {
        $keys = array_unique(array_merge(array_keys($a), array_keys($b)));
        $changed = [];
        foreach ($keys as $k) {
            $valA = isset($a[$k]) ? json_encode($a[$k]) : null;
            $valB = isset($b[$k]) ? json_encode($b[$k]) : null;
            if ($valA !== $valB) {
                $changed[] = $k;
            }
        }
        return $changed;
    }

    private function assessRisk(string $name, array $keys): string {
        if ($name === 'system.site' || $name === 'core.extension') return 'high';
        if (str_starts_with($name, 'field.storage.') || str_starts_with($name, 'node.type.')) return 'high';
        if (in_array('dependencies', $keys)) return 'medium';
        return 'low';
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
