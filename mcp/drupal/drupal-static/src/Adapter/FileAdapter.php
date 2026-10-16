<?php

namespace DrupalMcp\Static\Adapter;

use Symfony\Component\Finder\Finder;
use Symfony\Component\Yaml\Yaml;
use Symfony\Component\Yaml\Exception\ParseException;
use PhpParser\ParserFactory;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\Error;
use DrupalMcp\SharedArgs\ProjectRootResolver;
use DrupalMcp\SharedArgs\LazyProjectRoots;

class FileAdapter {
    use LazyProjectRoots;

    public function __construct(?string $projectRoot = null, ?string $drupalRoot = null, ?array $argv = null, ?string $entryPoint = null) {
        $this->initLazyRoots($projectRoot, $drupalRoot, $argv, $entryPoint);
    }

    private function rootResolutionException(string $message): \Exception {
        return new AdapterException($message);
    }

    public function findFiles(string $in, string $namePattern): array {
        $this->ensureResolved();
        $searchDir = $this->drupalRoot . '/' . ltrim($in, '/');
        if (!is_dir($searchDir)) {
            $searchDir = $this->projectRoot . '/' . ltrim($in, '/');
        }
        if (!is_dir($searchDir)) {
            return [];
        }

        $finder = new Finder();
        $finder->files()
            ->in($searchDir)
            ->name($namePattern)
            ->exclude(['vendor', 'node_modules', 'core', '.git', 'sites/default/files']);
        
        $results = [];
        foreach ($finder as $file) {
            $results[] = $file;
        }
        return $results;
    }

    public function parseYaml(string $filePath): array {
        if (!file_exists($filePath)) {
            throw new AdapterException("File not found: $filePath");
        }
        try {
            $content = Yaml::parseFile($filePath);
            return is_array($content) ? $content : [];
        } catch (ParseException $e) {
            throw new AdapterException("YAML parse error in $filePath: " . $e->getMessage());
        }
    }

    public function parsePhp(string $filePath): ?array {
        if (!file_exists($filePath)) {
            throw new AdapterException("File not found: $filePath");
        }
        $code = file_get_contents($filePath);
        $parser = (new ParserFactory())->createForNewestSupportedVersion();
        
        try {
            $ast = $parser->parse($code);
            $traverser = new NodeTraverser();
            $traverser->addVisitor(new NameResolver());
            $ast = $traverser->traverse($ast);
            return $ast;
        } catch (Error $e) {
            throw new AdapterException("PHP parse error in $filePath: " . $e->getMessage());
        }
    }

    private ?array $symbolsCache = null;

    public function scanSymbols(): array {
        if ($this->symbolsCache !== null) {
            return $this->symbolsCache;
        }

        $this->ensureResolved();
        $finder = new Finder();
        $finder->files()
            ->in($this->drupalRoot)
            ->exclude(['vendor', 'node_modules', 'core', '.git', 'sites/default/files']);
            
        foreach (['*.php', '*.module', '*.inc', '*.install', '*.theme', '*.profile', '*.engine'] as $pattern) {
            $finder->name($pattern);
        }

        $symbols = [];
        foreach ($finder as $file) {
            $path = $file->getRealPath();
            $relativePath = str_replace($this->projectRoot, '', $path);
            
            // Fast pre-filter
            $content = @file_get_contents($path);
            if ($content === false) continue;
            
            if (strpos($content, 'class ') === false && strpos($content, 'function ') === false) {
                continue;
            }
            
            try {
                $ast = $this->parsePhp($path);
                if ($ast) {
                    $this->collectSymbols($ast, $relativePath, $path, $symbols);
                }
            } catch (\Exception $e) {
                // Ignore parse errors, skip file
            }
        }

        $this->symbolsCache = $symbols;
        return $symbols;
    }

    private function collectSymbols(array $nodes, string $relativePath, string $absolutePath, array &$symbols): void {
        foreach ($nodes as $node) {
            if ($node instanceof \PhpParser\Node\Stmt\Function_) {
                $funcName = $node->name->toString();
                $symbols[] = [
                    'name' => $funcName,
                    'type' => (strpos($funcName, '_preprocess_') !== false) ? 'preprocess' : 'hook',
                    'file' => $relativePath,
                    'absolute_path' => $absolutePath,
                    'line' => $node->getStartLine(),
                    'content' => $funcName,
                ];
            } elseif ($node instanceof \PhpParser\Node\Stmt\Class_) {
                if ($node->name === null) continue;
                $className = $node->name->toString();
                $type = null;
                $baseClass = '';
                
                if ($node->extends !== null) {
                    $baseClass = $node->extends->toString();
                    if (in_array($baseClass, ['FormBase', 'ConfirmFormBase', 'ConfigFormBase', 'ContentEntityForm', 'EntityForm']) ||
                        preg_match('/(FormBase|ConfirmFormBase|ConfigFormBase|ContentEntityForm|EntityForm)$/', $baseClass)) {
                        $type = 'form';
                    } elseif ($baseClass === 'ControllerBase' || preg_match('/ControllerBase$/', $baseClass)) {
                        $type = 'controller';
                    } elseif ($baseClass === 'DrushCommands' || preg_match('/DrushCommands$/', $baseClass)) {
                        $type = 'drush_command';
                    }
                }
                
                if ($node->implements !== null) {
                    foreach ($node->implements as $interfaceName) {
                        $intName = $interfaceName->toString();
                        if ($intName === 'EventSubscriberInterface' || preg_match('/EventSubscriberInterface$/', $intName)) {
                            $type = 'event_subscriber';
                            break;
                        }
                    }
                }
                
                if (!$type && (strpos($relativePath, '/Plugin/') !== false || strpos($relativePath, '\\Plugin\\') !== false)) {
                    $type = 'plugin';
                }
                
                if ($type) {
                    $symbols[] = [
                        'name' => $className,
                        'type' => $type,
                        'file' => $relativePath,
                        'absolute_path' => $absolutePath,
                        'line' => $node->getStartLine(),
                        'extends' => $baseClass,
                        'content' => $className,
                    ];
                }
            } elseif ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $this->collectSymbols($node->stmts, $relativePath, $absolutePath, $symbols);
            }
        }
    }

    public function extractEventsFromSubscriber(string $absolutePath): array {
        try {
            $ast = $this->parsePhp($absolutePath);
            if (!$ast) return [];
            return $this->findEventsInAst($ast);
        } catch (\Exception $e) {
            return [];
        }
    }

    private function findEventsInAst(array $nodes): array {
        foreach ($nodes as $node) {
            if ($node instanceof \PhpParser\Node\Stmt\Class_) {
                foreach ($node->stmts as $stmt) {
                    if ($stmt instanceof \PhpParser\Node\Stmt\ClassMethod && $stmt->name->toString() === 'getSubscribedEvents') {
                        if ($stmt->stmts) {
                            foreach ($stmt->stmts as $subStmt) {
                                if ($subStmt instanceof \PhpParser\Node\Stmt\Return_ && $subStmt->expr instanceof \PhpParser\Node\Expr\Array_) {
                                    $events = [];
                                    foreach ($subStmt->expr->items as $item) {
                                        if ($item && $item->key) {
                                            if ($item->key instanceof \PhpParser\Node\Scalar\String_) {
                                                $events[] = $item->key->value;
                                            } elseif ($item->key instanceof \PhpParser\Node\Expr\ClassConstFetch) {
                                                $class = $item->key->class->toString();
                                                $const = $item->key->name->toString();
                                                $events[] = "$class::$const";
                                            }
                                        }
                                    }
                                    return $events;
                                }
                            }
                        }
                    }
                }
            } elseif ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $res = $this->findEventsInAst($node->stmts);
                if (!empty($res)) return $res;
            }
        }
        return [];
    }

    public function extractDrushCommands(string $absolutePath): array {
        try {
            $ast = $this->parsePhp($absolutePath);
            if (!$ast) return [];
            return $this->findDrushCommandsInAst($ast);
        } catch (\Exception $e) {
            return [];
        }
    }

    private function findDrushCommandsInAst(array $nodes): array {
        $commands = [];
        foreach ($nodes as $node) {
            if ($node instanceof \PhpParser\Node\Stmt\Class_) {
                foreach ($node->stmts as $stmt) {
                    if ($stmt instanceof \PhpParser\Node\Stmt\ClassMethod) {
                        $doc = $stmt->getDocComment();
                        if ($doc) {
                            if (preg_match('/@command\s+(\S+)/', $doc->getText(), $matches)) {
                                $commands[] = $matches[1];
                            }
                        }
                        if (!empty($stmt->attrGroups)) {
                            foreach ($stmt->attrGroups as $group) {
                                foreach ($group->attrs as $attr) {
                                    $attrName = $attr->name->toString();
                                    if (strpos($attrName, 'Command') !== false && !empty($attr->args)) {
                                        $arg = $attr->args[0]->value;
                                        if ($arg instanceof \PhpParser\Node\Scalar\String_) {
                                            $commands[] = $arg->value;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } elseif ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $commands = array_merge($commands, $this->findDrushCommandsInAst($node->stmts));
            }
        }
        return $commands;
    }

    public function extractPluginId(string $absolutePath): string {
        try {
            $ast = $this->parsePhp($absolutePath);
            if (!$ast) return 'extracted-via-static';
            return $this->findPluginIdInAst($ast);
        } catch (\Exception $e) {
            return 'extracted-via-static';
        }
    }

    private function findPluginIdInAst(array $nodes): string {
        foreach ($nodes as $node) {
            if ($node instanceof \PhpParser\Node\Stmt\Class_) {
                $doc = $node->getDocComment();
                if ($doc) {
                    if (preg_match('/id\s*=\s*["\']([^"\']+)["\']/', $doc->getText(), $matches)) {
                        return $matches[1];
                    }
                }
                if (!empty($node->attrGroups)) {
                    foreach ($node->attrGroups as $group) {
                        foreach ($group->attrs as $attr) {
                            foreach ($attr->args as $arg) {
                                if ($arg->name && $arg->name->toString() === 'id') {
                                    if ($arg->value instanceof \PhpParser\Node\Scalar\String_) {
                                        return $arg->value->value;
                                    }
                                }
                            }
                        }
                    }
                }
            } elseif ($node instanceof \PhpParser\Node\Stmt\Namespace_) {
                $res = $this->findPluginIdInAst($node->stmts);
                if ($res !== 'extracted-via-static') return $res;
            }
        }
        return 'extracted-via-static';
    }
}
