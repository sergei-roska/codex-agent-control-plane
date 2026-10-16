<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindPluginClasses {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional case-insensitive substring of the plugin folder or namespace (e.g., 'Block', 'FieldFormatter', 'QueueWorker').")]
        ?string $plugin_type = null,
        #[Schema(description: "Optional case-insensitive substring of the plugin ID (declared via annotations/attributes, e.g., 'user_login_block') to find.")]
        ?string $plugin_id = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($symbols as $s) {
                if ($s['type'] === 'plugin') {
                    $type = $this->getPluginTypeFromPath($s['file']);
                    
                    if ($plugin_type && stripos($type, $plugin_type) === false) {
                        continue;
                    }
                    
                    $id = $this->adapter->extractPluginId($s['absolute_path']);
                    
                    if ($plugin_id && stripos($id, $plugin_id) === false) {
                        continue;
                    }
                    
                    $results[] = [
                        'plugin_type' => $type,
                        'plugin_id' => $id,
                        'class' => $s['name'],
                        'file_path' => $s['file'],
                        'module' => $this->getModuleFromPath($s['file']),
                        'confidence' => 0.8,
                    ];
                }
            }
            
            return Envelope::ok("Found " . count($results) . " plugin classes.", $results, [], [
                'tool' => 'find_plugin_classes'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_plugin_classes'
            ]);
        }
    }

    private function getPluginTypeFromPath(string $path): string {
        $parts = explode('/', str_replace('\\', '/', $path));
        $idx = array_search('Plugin', $parts);
        if ($idx !== false && isset($parts[$idx + 1])) {
            return $parts[$idx + 1];
        }
        return 'unknown';
    }

    private function getModuleFromPath(string $path): string {
        $parts = explode('/', str_replace('\\', '/', $path));
        $idx = array_search('modules', $parts);
        if ($idx !== false && isset($parts[$idx + 2])) {
            return $parts[$idx + 2];
        }
        foreach ($parts as $part) {
            if ($part && !in_array($part, ['src', 'modules', 'custom', 'contrib', 'Plugin'])) {
                return $part;
            }
        }
        return 'unknown';
    }
}
