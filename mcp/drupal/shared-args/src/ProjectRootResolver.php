<?php

namespace DrupalMcp\SharedArgs;

class ProjectRootResolver {
    /**
     * Resolves the Drupal project root and Drupal root directories.
     *
     * @param array|null $argv CLI arguments.
     * @param string|null $entryPoint Directory of the calling script.
     * @return array Array with keys 'project_root' and 'drupal_root'.
     * @throws \Exception If roots cannot be resolved or explicit paths are invalid.
     */
    public static function resolve(?array $argv = null, ?string $entryPoint = null): array {
        $resolvedProjectRoot = null;

        // 1. Environment Variable
        $projectRootEnv = getenv('PROJECT_ROOT');
        if ($projectRootEnv !== false && $projectRootEnv !== '') {
            $real = realpath($projectRootEnv);
            if ($real === false || !self::isDrupalProject($real)) {
                throw new \Exception("Explicit PROJECT_ROOT does not point to a valid Drupal project: " . $projectRootEnv);
            }
            $resolvedProjectRoot = $real;
        }

        // 2. CLI Argument
        if ($resolvedProjectRoot === null && is_array($argv)) {
            for ($i = 0; $i < count($argv); $i++) {
                $arg = $argv[$i];
                if (str_starts_with($arg, '--project-root=')) {
                    $path = substr($arg, 15);
                    $real = realpath($path);
                    if ($real === false || !self::isDrupalProject($real)) {
                        throw new \Exception("Explicit --project-root does not point to a valid Drupal project: " . $path);
                    }
                    $resolvedProjectRoot = $real;
                    break;
                } elseif ($arg === '--project-root') {
                    if (isset($argv[$i + 1])) {
                        $path = $argv[$i + 1];
                        $real = realpath($path);
                        if ($real === false || !self::isDrupalProject($real)) {
                            throw new \Exception("Explicit --project-root does not point to a valid Drupal project: " . $path);
                        }
                        $resolvedProjectRoot = $real;
                        break;
                    } else {
                        throw new \Exception("Explicit --project-root option is missing a value.");
                    }
                }
            }
        }

        // 3. Install-Relative (Local Installs)
        if ($resolvedProjectRoot === null && $entryPoint !== null) {
            $realEntryPoint = realpath($entryPoint);
            if ($realEntryPoint !== false) {
                $normalized = str_replace('\\', '/', $realEntryPoint);
                $pos = strripos($normalized, '/vendor/');
                if ($pos !== false) {
                    $vendorParent = substr($realEntryPoint, 0, $pos);
                    if (self::isDrupalProject($vendorParent)) {
                        $resolvedProjectRoot = realpath($vendorParent);
                    }
                }
            }
        }

        // 4. Current Working Directory (CWD)
        if ($resolvedProjectRoot === null) {
            $cwd = getcwd();
            if ($cwd !== false) {
                $current = realpath($cwd);
                while ($current !== false) {
                    if (self::isDrupalProject($current)) {
                        $resolvedProjectRoot = $current;
                        break;
                    }
                    $parent = dirname($current);
                    if ($parent === $current) {
                        break;
                    }
                    $current = $parent;
                }
            }
        }

        // 5. Fallback / Fail Fast
        if ($resolvedProjectRoot === null) {
            throw new \Exception("PROJECT_ROOT could not be resolved.");
        }

        return [
            'project_root' => $resolvedProjectRoot,
            'drupal_root' => self::resolveDrupalRoot($resolvedProjectRoot),
        ];
    }

    /**
     * Resolves the Drupal root for a given project root: explicit DRUPAL_ROOT
     * env override, otherwise web/core, docroot/core, or the project root itself.
     *
     * @throws \Exception If an explicit DRUPAL_ROOT is invalid.
     */
    public static function resolveDrupalRoot(string $projectRoot): string {
        $drupalRootEnv = getenv('DRUPAL_ROOT');
        if ($drupalRootEnv !== false && $drupalRootEnv !== '') {
            $realDrupal = realpath($drupalRootEnv);
            if ($realDrupal === false || !is_dir($realDrupal)) {
                throw new \Exception("Explicit DRUPAL_ROOT does not point to a valid directory: " . $drupalRootEnv);
            }
            return $realDrupal;
        }

        if (is_dir($projectRoot . '/web/core')) {
            return realpath($projectRoot . '/web');
        }
        if (is_dir($projectRoot . '/docroot/core')) {
            return realpath($projectRoot . '/docroot');
        }
        return $projectRoot;
    }

    /**
     * Verifies if a directory is a valid Drupal project root.
     */
    public static function isDrupalProject(string $path): bool {
        $realPath = realpath($path);
        if ($realPath === false) {
            return false;
        }

        $composerJson = $realPath . '/composer.json';
        if (!file_exists($composerJson)) {
            return false;
        }

        if (is_dir($realPath . '/web/core') || is_dir($realPath . '/docroot/core') || is_dir($realPath . '/core')) {
            return true;
        }

        return false;
    }
}
