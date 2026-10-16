<?php

namespace DrupalMcp\SharedArgs;

/**
 * Lazy project/Drupal root resolution for MCP server adapters.
 *
 * The server starts without knowing the project root; the root is resolved on
 * the first tool call via ProjectRootResolver (env, CLI argument, install path,
 * CWD ancestry) and, as a final fallback, by asking the MCP client for its
 * workspace roots (roots/list). The roots fallback covers IDE clients that
 * spawn MCP servers from the home directory instead of the project.
 *
 * The using class must implement:
 *   private function rootResolutionException(string $message): \Exception
 * returning its adapter-specific exception type (so tools can keep catching it).
 */
trait LazyProjectRoots {
    private ?string $projectRoot = null;
    private ?string $drupalRoot = null;
    private ?array $rootsArgv = null;
    private ?string $rootsEntryPoint = null;
    private ?object $requestContext = null;

    /**
     * Constructor helper: explicit roots are validated eagerly; null defers
     * resolution to the first ensureResolved() call.
     */
    private function initLazyRoots(?string $projectRoot, ?string $drupalRoot, ?array $argv, ?string $entryPoint): void {
        $this->rootsArgv = $argv;
        $this->rootsEntryPoint = $entryPoint;

        if ($projectRoot === null) {
            return;
        }
        if (!is_dir($projectRoot)) {
            throw $this->rootResolutionException("PROJECT_ROOT does not exist: $projectRoot");
        }
        $this->projectRoot = realpath($projectRoot);

        if ($drupalRoot) {
            if (!is_dir($drupalRoot)) {
                throw $this->rootResolutionException("DRUPAL_ROOT does not exist: $drupalRoot");
            }
            $this->drupalRoot = realpath($drupalRoot);
        } else {
            $this->drupalRoot = ProjectRootResolver::resolveDrupalRoot($this->projectRoot);
        }
    }

    /**
     * Gives the adapter access to the current MCP request, so root detection can
     * query the client for its workspace roots (roots/list). Set once per tool
     * call; ignored after the root has been resolved.
     */
    public function setRequestContext(?object $context): void {
        if ($context !== null && $this->projectRoot === null) {
            $this->requestContext = $context;
        }
    }

    public function getProjectRoot(): string {
        $this->ensureResolved();
        return $this->projectRoot;
    }

    public function getDrupalRoot(): string {
        $this->ensureResolved();
        return $this->drupalRoot;
    }

    private function ensureResolved(): void {
        if ($this->projectRoot !== null) {
            return;
        }
        try {
            $resolved = ProjectRootResolver::resolve($this->rootsArgv, $this->rootsEntryPoint);
            $this->projectRoot = $resolved['project_root'];
            $this->drupalRoot = $resolved['drupal_root'];
            return;
        } catch (\Exception $localError) {
            // Fall through to client workspace roots (IDE clients start MCP
            // servers from the home directory, so CWD detection fails there).
        }

        $fromRoots = $this->detectFromClientRoots();
        if ($fromRoots !== null) {
            $this->projectRoot = $fromRoots;
            $this->drupalRoot = ProjectRootResolver::resolveDrupalRoot($fromRoots);
            return;
        }

        throw $this->rootResolutionException(
            "Drupal project root could not be auto-detected. Tried the PROJECT_ROOT env variable, "
            . "the --project-root argument, the install path, walking up from the current working "
            . "directory (" . (getcwd() ?: 'unknown') . "), and the MCP client workspace roots. "
            . "Start your MCP client from inside a Drupal project, or set PROJECT_ROOT in the "
            . "server config. Original error: " . $localError->getMessage()
        );
    }

    /**
     * Asks the MCP client for its workspace roots (roots/list) and returns the
     * first one that is, contains, or lives inside a Drupal project.
     */
    private function detectFromClientRoots(): ?string {
        if ($this->requestContext === null
            || \Fiber::getCurrent() === null
            || !class_exists(\Mcp\Schema\Request\ListRootsRequest::class)
        ) {
            return null;
        }

        $session = $this->requestContext->getSession();
        $capabilities = $session->get('client_capabilities', []);
        if (!\is_array($capabilities) || !\array_key_exists('roots', $capabilities)) {
            return null;
        }

        // ClientGateway::request() is private in mcp/sdk 0.6, so suspend the
        // handler Fiber with the same payload shape the gateway uses; the
        // transport resumes it with the client's Response or Error.
        try {
            $response = \Fiber::suspend([
                'type' => 'request',
                'request' => new \Mcp\Schema\Request\ListRootsRequest(),
                'session_id' => $session->getId()->toRfc4122(),
                'timeout' => 15,
            ]);
        } catch (\Throwable $e) {
            return null;
        }
        if (!$response instanceof \Mcp\Schema\JsonRpc\Response) {
            return null;
        }

        foreach (($response->result['roots'] ?? []) as $root) {
            $uri = $root['uri'] ?? '';
            if (!\is_string($uri) || !str_starts_with($uri, 'file://')) {
                continue;
            }
            $path = realpath(rawurldecode(substr($uri, 7)));
            if ($path === false || !is_dir($path)) {
                continue;
            }

            // The workspace root itself, or an ancestor of it (workspace opened
            // on a subdirectory of the project).
            $current = $path;
            while (true) {
                if (ProjectRootResolver::isDrupalProject($current)) {
                    return realpath($current);
                }
                $parent = dirname($current);
                if ($parent === $current) {
                    break;
                }
                $current = $parent;
            }

            // Direct children (workspace opened on a folder that contains the
            // Drupal project, e.g. a multi-project workspace).
            foreach (glob($path . '/*', GLOB_ONLYDIR) ?: [] as $child) {
                if (ProjectRootResolver::isDrupalProject($child)) {
                    return realpath($child);
                }
            }
        }

        return null;
    }
}
