<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Server\RequestContext;

class SummarizeCodeInventory {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $listCustom = new ListCustomModules($this->adapter);
            $findServices = new FindServiceDefinitions($this->adapter);
            $findRoutes = new FindControllerHandlers($this->adapter);
            
            $customRes = $listCustom->execute();
            $customMods = $customRes['ok'] ? $customRes['data'] : [];
            
            $serviceRes = $findServices->execute();
            $services = $serviceRes['ok'] ? $serviceRes['data'] : [];
            
            $routesRes = $findRoutes->execute();
            $routes = $routesRes['ok'] ? $routesRes['data'] : [];
            
            $data = [
                'custom_modules' => count($customMods),
                'custom_list' => array_column($customMods, 'machine_name'),
                'total_services_found' => count($services),
                'total_routes_found' => count($routes),
                'drupal_version' => 'Unknown (Static Analysis)',
                'method' => 'filesystem_fallback'
            ];
            
            return Envelope::ok("Codebase Inventory: " . count($customMods) . " custom modules detected.", [$data], [], [
                'tool' => 'summarize_code_inventory'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'summarize_code_inventory'
            ]);
        }
    }
}
