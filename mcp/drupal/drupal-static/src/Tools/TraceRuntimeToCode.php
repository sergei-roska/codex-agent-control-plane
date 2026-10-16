<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class TraceRuntimeToCode {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "The type of runtime component to trace. Allowed values: 'route', 'service', 'hook', 'preprocess', 'plugin', 'form_class', 'entity_bundle'.")]
        string $domain,
        #[Schema(description: "The name of the symbol to trace (e.g., 'entity.node.canonical' for a route, 'current_user' for a service, 'node_insert' for a hook).")]
        string $identifier,
        #[Schema(description: "Optional secondary context filter (e.g., the theme name when tracing 'preprocess' hook, or plugin type when tracing 'plugin').")]
        ?string $secondary_identifier = null,
        #[Schema(description: "Maximum number of ranked code locations to return.")]
        int $limit = 5,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $candidates = [];
            
            switch ($domain) {
                case 'route':
                    $tool = new FindControllerHandlers($this->adapter);
                    $res = $tool->execute($identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'service':
                    $tool = new FindServiceDefinitions($this->adapter);
                    $res = $tool->execute($identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'hook':
                    $tool = new FindHookImplementations($this->adapter);
                    $res = $tool->execute($identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'preprocess':
                    $tool = new FindPreprocessFunctions($this->adapter);
                    $res = $tool->execute($identifier, $secondary_identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'plugin':
                    $tool = new FindPluginClasses($this->adapter);
                    // plugin_type is secondary_identifier, plugin_id is identifier
                    $res = $tool->execute($secondary_identifier, $identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'form_class':
                    $tool = new FindFormClasses($this->adapter);
                    $res = $tool->execute($identifier);
                    if ($res['ok']) {
                        $candidates = $res['data'];
                    }
                    break;
                case 'entity_bundle':
                    // Not statically traceable directly; returns empty/not found gracefully
                    break;
                default:
                    // Fallback search over multiple domains
                    $resRoutes = (new FindControllerHandlers($this->adapter))->execute($identifier);
                    $resServices = (new FindServiceDefinitions($this->adapter))->execute($identifier);
                    $resHooks = (new FindHookImplementations($this->adapter))->execute($identifier);
                    $resPlugins = (new FindPluginClasses($this->adapter))->execute(null, $identifier);
                    
                    $candidates = array_merge(
                        $resRoutes['ok'] ? $resRoutes['data'] : [],
                        $resServices['ok'] ? $resServices['data'] : [],
                        $resHooks['ok'] ? $resHooks['data'] : [],
                        $resPlugins['ok'] ? $resPlugins['data'] : []
                    );
                    break;
            }
            
            // Map confidence and sort
            usort($candidates, function($a, $b) {
                $confA = $a['confidence'] ?? 0.5;
                $confB = $b['confidence'] ?? 0.5;
                return $confB <=> $confA; // descending
            });
            
            $results = array_slice($candidates, 0, $limit);
            
            return Envelope::ok("Resolved $domain: [$identifier] to " . count($results) . " ranked locations.", $results, [], [
                'tool' => 'trace_runtime_to_code'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'trace_runtime_to_code'
            ]);
        }
    }
}
