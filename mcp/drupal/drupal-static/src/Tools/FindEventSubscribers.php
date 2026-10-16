<?php

namespace DrupalMcp\Static\Tools;

use DrupalMcp\Static\Adapter\FileAdapter;
use DrupalMcp\Static\Adapter\AdapterException;
use DrupalMcp\Static\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class FindEventSubscribers {
    private FileAdapter $adapter;

    public function __construct(FileAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Optional case-insensitive substring of a Symfony event name (e.g. 'kernel.request', 'config.save') to filter subscribers.")]
        ?string $event_name = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $symbols = $this->adapter->scanSymbols();
            $results = [];
            
            foreach ($symbols as $s) {
                if ($s['type'] === 'event_subscriber') {
                    $absPath = $s['absolute_path'];
                    $events = $this->adapter->extractEventsFromSubscriber($absPath);
                    
                    if ($event_name) {
                        $matched = false;
                        foreach ($events as $event) {
                            if (stripos($event, $event_name) !== false) {
                                $matched = true;
                                break;
                            }
                        }
                        if (!$matched) {
                            continue;
                        }
                    }
                    
                    $results[] = [
                        'class' => $s['name'],
                        'events' => empty($events) ? ['unknown (static analysis limitation)'] : $events,
                        'file_path' => $s['file'],
                        'module' => $this->getModuleFromPath($s['file']),
                        'confidence' => 0.8,
                    ];
                }
            }
            
            return Envelope::ok("Found " . count($results) . " event subscribers.", $results, [], [
                'tool' => 'find_event_subscribers'
            ]);
        } catch (AdapterException $e) {
            return Envelope::error('ENV_NOT_READY', $e->getMessage(), 'Check PROJECT_ROOT', [
                'tool' => 'find_event_subscribers'
            ]);
        }
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
