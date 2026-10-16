<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class ReadSyncConfig {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional exact name or prefix (e.g., 'system.site', 'node.type.') of the configuration files to filter by.")]
        ?string $config_name = null,
        #[Schema(description: "Optional case-insensitive substring filter for configuration filenames.")]
        ?string $pattern = null,
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
            $files = $this->findSyncFiles();
            $results = [];
            
            foreach ($files as $file) {
                $path = $file->getRealPath();
                $name = basename($path, '.yml');
                
                if ($config_name && !str_starts_with($name, $config_name)) {
                    continue;
                }
                
                if ($pattern && stripos($name, $pattern) === false) {
                    continue;
                }
                
                if ($query && stripos($name, $query) === false) {
                    continue;
                }
                
                try {
                    $yml = $this->adapter->parseYaml($path);
                    
                    if ($exclude_noise && is_array($yml)) {
                        unset($yml['uuid'], $yml['_core']);
                    }
                    
                    $results[] = [
                        'name' => $name,
                        'file_path' => str_replace($this->adapter->getProjectRoot(), '', $path),
                        'data' => $yml
                    ];
                } catch (\Exception $e) {
                    // Skip unparseable
                }
            }
            
            $totalCount = count($results);
            
            // Default sort by name
            $sortField = $sort ?: 'name';
            usort($results, function($a, $b) use ($sortField, $sort_direction) {
                $valA = $a[$sortField] ?? '';
                $valB = $b[$sortField] ?? '';
                $cmp = strcmp($valA, $valB);
                return ($sort_direction === 'DESC') ? -$cmp : $cmp;
            });
            
            // Paginate
            $offsetVal = $offset ?: 0;
            if ($offsetVal > 0) {
                $results = array_slice($results, $offsetVal);
            }
            $limitVal = $limit ?: 50;
            if ($limitVal > 0) {
                $results = array_slice($results, 0, $limitVal);
            }
            
            $data = $summary_only ? [] : $results;
            
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
            
            return Envelope::ok(
                "Read " . count($data) . " active synchronization config objects.",
                $data,
                [
                    'returned' => count($data),
                    'total' => $totalCount,
                    'truncated' => $truncated
                ],
                [
                    'tool' => 'read_sync_config'
                ]
            );
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'read_sync_config'
            ]);
        }
    }

    private function findSyncFiles(): array {
        $locations = [
            'config/sync',
            '../config/sync',
            'sites/default/files/config_sync',
        ];
        
        foreach ($locations as $loc) {
            $files = $this->adapter->findFiles($loc, '*.yml');
            if (!empty($files)) {
                return $files;
            }
        }
        
        return $this->adapter->findFiles('sync', '*.yml');
    }
}
