<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindFormClasses {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Short class name (e.g., 'SystemMaintenanceForm') or fully qualified namespace of the Drupal form class to locate.")]
        string $class_name,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($symbols as $s) {
                if ($s['type'] === 'form') {
                    // Match short name or fully qualified class name
                    if ($s['name'] === $class_name || str_ends_with($class_name, '\\' . $s['name'])) {
                        $usedRoutes = $this->getRoutesUsingForm($s['name']);
                        
                        $results[] = [
                            'class' => $s['name'],
                            'form_base' => $s['extends'] ?: 'FormBase (Static Assumption)',
                            'file_path' => $s['file'],
                            'route_names' => $usedRoutes,
                            'confidence' => 0.9,
                        ];
                    }
                }
            }
            
            return Envelope::ok("Located " . count($results) . " form classes matching " . $class_name . ".", $results, [], [
                'tool' => 'find_form_classes'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_form_classes'
            ]);
        }
    }

    private function getRoutesUsingForm(string $shortClassName): array {
        $files = $this->adapter->findFiles('/', '*.routing.yml');
        $routes = [];
        foreach ($files as $file) {
            try {
                $yml = $this->adapter->parseYaml($file->getRealPath());
                if (is_array($yml)) {
                    foreach ($yml as $routeName => $def) {
                        if (!is_array($def)) continue;
                        $controller = $def['defaults']['_controller'] ?? $def['defaults']['_form'] ?? '';
                        if ($controller && strpos($controller, $shortClassName) !== false) {
                            $routes[] = $routeName;
                        }
                    }
                }
            } catch (\Exception $e) {
                // ignore
            }
        }
        return $routes;
    }
}
