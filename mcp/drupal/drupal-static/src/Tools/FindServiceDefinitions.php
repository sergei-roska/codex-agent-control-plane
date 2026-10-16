<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindServiceDefinitions {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional exact service ID (e.g. 'database', 'current_user') to look up.")]
        ?string $service_id = null,
        #[Schema(description: "Optional case-insensitive class name substring (e.g. 'Connection', 'AccessCheck') to filter services by class.")]
        ?string $class_name = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $files = $this->adapter->findFiles('/', '*.services.yml');
            
            $results = [];
            foreach ($files as $file) {
                $path = $file->getRealPath();
                $relativePath = str_replace($this->adapter->getProjectRoot(), '', $path);
                $module = basename($path, '.services.yml');
                
                try {
                    $yml = $this->adapter->parseYaml($path);
                    if (isset($yml['services']) && is_array($yml['services'])) {
                        foreach ($yml['services'] as $id => $def) {
                            if ($id === '_defaults' || !is_array($def)) {
                                continue;
                            }
                            
                            $class = $def['class'] ?? '';
                            $tags = [];
                            if (isset($def['tags']) && is_array($def['tags'])) {
                                foreach ($def['tags'] as $tag) {
                                    if (is_array($tag) && isset($tag['name'])) {
                                        $tags[] = $tag['name'];
                                    } elseif (is_string($tag)) {
                                        $tags[] = $tag;
                                    }
                                }
                            }
                            
                            if ($service_id && $id !== $service_id) {
                                continue;
                            }
                            
                            if ($class_name && (empty($class) || stripos($class, $class_name) === false)) {
                                continue;
                            }
                            
                            $results[] = [
                                'service_id' => $id,
                                'class' => $class,
                                'file_path' => $relativePath,
                                'tags' => $tags,
                                'module' => $module,
                                'confidence' => 1.0,
                            ];
                        }
                    }
                } catch (\Exception $e) {
                    // Skip unparseable
                }
            }
            
            return Envelope::ok("Found " . count($results) . " service definitions.", $results, [], [
                'tool' => 'find_service_definitions'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_service_definitions'
            ]);
        }
    }
}
