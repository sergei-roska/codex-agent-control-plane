<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindHookImplementations {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "The name of the hook suffix without 'hook_' prefix (e.g., 'node_insert', 'form_alter', 'theme').")]
        string $hook_name,
        #[Schema(description: "Optional machine name of a specific module to limit the search (e.g., 'system').")]
        ?string $module = null,
        #[Schema(description: "Optional limit for the number of matching hook implementations returned.")]
        ?int $limit = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $suffix = '_' . $hook_name;
            
            $results = [];
            foreach ($symbols as $s) {
                if ($s['type'] === 'hook' && str_ends_with($s['name'], $suffix)) {
                    $moduleExtracted = substr($s['name'], 0, -strlen($suffix));
                    
                    if ($module && $moduleExtracted !== $module) {
                        continue;
                    }
                    
                    $results[] = [
                        'symbol' => $s['name'],
                        'file_path' => $s['file'],
                        'line' => $s['line'],
                        'module' => $moduleExtracted,
                        'confidence' => 0.9,
                    ];
                }
            }
            
            if ($limit && $limit > 0) {
                $results = array_slice($results, 0, $limit);
            }
            
            return Envelope::ok("Found " . count($results) . " implementations for hook_" . $hook_name, $results, [], [
                'tool' => 'find_hook_implementations'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_hook_implementations'
            ]);
        }
    }
}
