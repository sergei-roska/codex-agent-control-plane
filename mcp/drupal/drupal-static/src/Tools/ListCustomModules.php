<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class ListCustomModules {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional substring to filter custom modules by machine name or human name. Case-insensitive.")]
        ?string $query = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $files = $this->adapter->findFiles('/modules/custom', '*.info.yml');
            
            $data = [];
            foreach ($files as $file) {
                $path = $file->getRealPath();
                $name = basename($path, '.info.yml');
                
                if ($query && stripos($name, $query) === false) {
                    continue;
                }
                
                try {
                    $info = $this->adapter->parseYaml($path);
                    $data[] = [
                        'machine_name' => $name,
                        'name' => $info['name'] ?? $name,
                        'description' => $info['description'] ?? '',
                        'package' => $info['package'] ?? 'Custom',
                        'path' => str_replace($this->adapter->getProjectRoot(), '', $path)
                    ];
                } catch (\Exception $e) {
                    // Skip unparseable
                }
            }
            
            return Envelope::ok("Found " . count($data) . " custom modules.", $data, [], [
                'tool' => 'list_custom_modules'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'list_custom_modules'
            ]);
        }
    }
}
