<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindControllerHandlers {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional exact Drupal route name (e.g., 'entity.node.canonical') to trace to its controller class and method.")]
        ?string $route_name = null,
        #[Schema(description: "Optional URL path substring (e.g., '/node/{node}') to filter route definitions. Case-insensitive.")]
        ?string $path = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $files = $this->adapter->findFiles('/', '*.routing.yml');
            $routes = [];
            
            foreach ($files as $file) {
                $filePath = $file->getRealPath();
                $relativePath = str_replace($this->adapter->getProjectRoot(), '', $filePath);
                try {
                    $yml = $this->adapter->parseYaml($filePath);
                    if (is_array($yml)) {
                        foreach ($yml as $id => $def) {
                            if (!is_array($def)) continue;
                            
                            $routePath = $def['path'] ?? '';
                            $controller = '';
                            $isForm = false;
                            
                            if (isset($def['defaults'])) {
                                if (isset($def['defaults']['_controller'])) {
                                    $controller = $def['defaults']['_controller'];
                                } elseif (isset($def['defaults']['_form'])) {
                                    $controller = $def['defaults']['_form'];
                                    $isForm = true;
                                }
                            }
                            
                            if ($route_name && $id !== $route_name) {
                                continue;
                            }
                            
                            if ($path && stripos($routePath, $path) === false) {
                                continue;
                            }
                            
                            $routes[] = [
                                'route_name' => $id,
                                'path' => $routePath,
                                'controller' => $controller,
                                'is_form' => $isForm,
                                'file' => $relativePath,
                            ];
                        }
                    }
                } catch (\Exception $e) {
                    // skip
                }
            }
            
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($routes as $r) {
                $method = $r['is_form'] ? 'buildForm' : '';
                $controllerClass = $r['controller'];
                
                if (!$r['is_form'] && strpos($controllerClass, '::') !== false) {
                    $parts = explode('::', $controllerClass);
                    $controllerClass = $parts[0];
                    $method = $parts[1];
                }
                
                if (empty($method)) {
                    $method = '__invoke';
                }
                
                // Find matching class symbol
                $classParts = explode('\\', $controllerClass);
                $shortName = end($classParts);
                
                $fileMatch = null;
                foreach ($symbols as $s) {
                    if (in_array($s['type'], ['controller', 'form']) && $s['name'] === $shortName) {
                        $fileMatch = $s;
                        break;
                    }
                }
                
                $results[] = [
                    'route_name' => $r['route_name'],
                    'path' => $r['path'],
                    'controller' => $controllerClass,
                    'method' => $method,
                    'file_path' => $fileMatch ? $fileMatch['file'] : 'unknown (static lookup failed)',
                    'confidence' => $fileMatch ? 0.9 : 0.4,
                ];
            }
            
            return Envelope::ok("Located " . count($results) . " route-to-controller mappings.", $results, [], [
                'tool' => 'find_controller_handlers'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_controller_handlers'
            ]);
        }
    }
}
