<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindPreprocessFunctions {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional base theme hook name (e.g. 'node', 'page', 'block') to filter preprocess function names.")]
        ?string $hook = null,
        #[Schema(description: "Optional theme or module name prefix (e.g. 'classy', 'my_custom_theme') to limit the search.")]
        ?string $theme = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($symbols as $s) {
                if ($s['type'] === 'preprocess') {
                    if ($hook && stripos($s['name'], '_preprocess_' . $hook) === false) {
                        continue;
                    }
                    if ($theme && !str_starts_with($s['name'], $theme . '_')) {
                        continue;
                    }
                    
                    $parts = explode('_preprocess_', $s['name']);
                    $owner = $parts[0] ?: 'unknown';
                    
                    $results[] = [
                        'function_name' => $s['name'],
                        'file_path' => $s['file'],
                        'line' => $s['line'],
                        'owner' => $owner,
                        'confidence' => 0.9,
                    ];
                }
            }
            
            return Envelope::ok("Found " . count($results) . " matching preprocess functions.", $results, [], [
                'tool' => 'find_preprocess_functions'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_preprocess_functions'
            ]);
        }
    }
}
