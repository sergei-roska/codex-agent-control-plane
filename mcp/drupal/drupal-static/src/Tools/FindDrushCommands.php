<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindDrushCommands {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional case-insensitive substring of a Drush command name or alias (e.g. 'cron', 'cr', 'cim') to locate.")]
        ?string $command_name = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($symbols as $s) {
                if ($s['type'] === 'drush_command') {
                    $cmds = $this->adapter->extractDrushCommands($s['absolute_path']);
                    
                    if ($command_name) {
                        $matched = false;
                        foreach ($cmds as $cmd) {
                            if (stripos($cmd, $command_name) !== false) {
                                $results[] = [
                                    'command_name' => $cmd,
                                    'class' => $s['name'],
                                    'file_path' => $s['file'],
                                    'confidence' => 0.7,
                                ];
                                $matched = true;
                            }
                        }
                        if (!$matched && stripos($s['name'], $command_name) !== false) {
                            $results[] = [
                                'command_name' => 'unknown (static analysis limitation)',
                                'class' => $s['name'],
                                'file_path' => $s['file'],
                                'confidence' => 0.5,
                            ];
                        }
                    } else {
                        if (empty($cmds)) {
                            $results[] = [
                                'command_name' => 'unknown (static analysis limitation)',
                                'class' => $s['name'],
                                'file_path' => $s['file'],
                                'confidence' => 0.5,
                            ];
                        } else {
                            foreach ($cmds as $cmd) {
                                $results[] = [
                                    'command_name' => $cmd,
                                    'class' => $s['name'],
                                    'file_path' => $s['file'],
                                    'confidence' => 0.7,
                                ];
                            }
                        }
                    }
                }
            }
            
            return Envelope::ok("Found " . count($results) . " drush command providers.", $results, [], [
                'tool' => 'find_drush_commands'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_drush_commands'
            ]);
        }
    }
}
