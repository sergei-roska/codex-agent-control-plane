<?php

namespace DrupalMcp\Content\Adapter;

use Symfony\Component\Process\Process;
use Symfony\Component\Process\Exception\ProcessFailedException;
use DrupalMcp\SharedArgs\LazyProjectRoots;

class DrushAdapter {
    use LazyProjectRoots;

    private ?string $environment = null;

    public function __construct(?string $projectRoot = null, ?string $drupalRoot = null, ?array $argv = null, ?string $entryPoint = null) {
        $this->initLazyRoots($projectRoot, $drupalRoot, $argv, $entryPoint);
    }

    private function rootResolutionException(string $message): \Exception {
        return new AdapterException($message);
    }


    private function detectEnvironment(): string {
        if ($this->environment !== null) {
            return $this->environment;
        }

        // Check for configuration markers first (fast path)
        if (file_exists($this->projectRoot . '/.lando.yml')) {
            $this->environment = 'lando';
            return 'lando';
        }
        if (is_dir($this->projectRoot . '/.ddev')) {
            $this->environment = 'ddev';
            return 'ddev';
        }

        // Fallback to checking executable commands
        if ($this->commandExists('lando')) {
            $this->environment = 'lando';
            return 'lando';
        }
        if ($this->commandExists('ddev')) {
            $this->environment = 'ddev';
            return 'ddev';
        }

        $this->environment = 'local';
        return 'local';
    }

    private function commandExists(string $cmd): bool {
        $process = new Process(['which', $cmd]);
        try {
            $process->run();
            return $process->isSuccessful();
        } catch (\Exception $e) {
            return false;
        }
    }

    /**
     * Evaluate dynamic PHP in Drupal runtime and return decoded JSON array.
     */
    public function evaluate(string $phpCode): array {
        $this->ensureResolved();
        $env = $this->detectEnvironment();
        $base64Payload = base64_encode($phpCode);

        // Standard Drupal container bootstrap wrapper
        $wrapper = <<<PHP
\$bootstrap_ok = class_exists('\\\\Drupal') && \\Drupal::hasContainer();
if (!\$bootstrap_ok) {
    echo json_encode(['error' => 'DRUPAL_NOT_BOOTSTRAPPED', 'message' => 'Drupal container not initialized.']);
    exit(1);
}
try {
    \$result = eval(base64_decode('$base64Payload'));
    echo json_encode(\$result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (\\Throwable \$e) {
    echo json_encode(['error' => 'PHP_EXECUTION_ERROR', 'message' => \$e->getMessage() . ' in ' . \$e->getFile() . ':' . \$e->getLine()]);
    exit(1);
}
PHP;

        $drushArgs = ['php-eval', $wrapper];

        // Root option relative path override
        if ($this->drupalRoot !== $this->projectRoot) {
            // Find relative path from project root to drupal root
            $relPath = $this->getRelativePath($this->projectRoot, $this->drupalRoot);
            array_unshift($drushArgs, "--root=" . ($relPath ?: '.'));
        }

        // Handle URI option if configured in env
        $drushUri = getenv('DRUSH_OPTIONS_URI') ?: getenv('DRUSH_URI');
        if ($drushUri) {
            array_unshift($drushArgs, "--uri=$drushUri");
        }

        // Construct target command line
        if ($env === 'lando') {
            $cmd = array_merge(['lando', 'drush'], $drushArgs);
        } elseif ($env === 'ddev') {
            $cmd = array_merge(['ddev', 'drush'], $drushArgs);
        } else {
            $vendorDrush = $this->projectRoot . '/vendor/bin/drush';
            $drushCmd = file_exists($vendorDrush) ? $vendorDrush : 'drush';
            $cmd = array_merge([$drushCmd], $drushArgs);
        }

        $process = new Process($cmd, $this->projectRoot);
        $process->setTimeout(30.0);

        try {
            $process->run();
            if (!$process->isSuccessful()) {
                $stderr = $process->getErrorOutput();
                throw new AdapterException("Drush execution failed (exit code " . $process->getExitCode() . "): " . trim($stderr ?: $process->getOutput()));
            }

            $output = trim($process->getOutput());
            if (empty($output)) {
                $stderr = $process->getErrorOutput();
                throw new AdapterException("Empty output from Drush. Stderr: " . trim($stderr));
            }

            $result = json_decode($output, true);
            if (json_last_error() !== JSON_ERROR_NONE) {
                throw new AdapterException("Failed to decode JSON from Drush: " . json_last_error_msg() . "\nRaw output: " . substr($output, 0, 500));
            }

            if (is_array($result) && isset($result['error'])) {
                if ($result['error'] === 'DRUPAL_NOT_BOOTSTRAPPED') {
                    throw new AdapterException("Drupal Bootstrap Error: " . $result['message']);
                }
                if ($result['error'] === 'PHP_EXECUTION_ERROR') {
                    throw new AdapterException("PHP Runtime Error: " . $result['message']);
                }
            }

            return $result;
        } catch (\Exception $e) {
            if ($e instanceof AdapterException) {
                throw $e;
            }
            throw new AdapterException("Adapter command execution exception: " . $e->getMessage(), 0, $e);
        }
    }

    private function getRelativePath(string $from, string $to): string {
        $from = rtrim($from, '/') . '/';
        $to = rtrim($to, '/') . '/';
        
        $fromParts = explode('/', $from);
        $toParts = explode('/', $to);
        
        while (count($fromParts) && count($toParts) && ($fromParts[0] === $toParts[0])) {
            array_shift($fromParts);
            array_shift($toParts);
        }
        
        $rel = str_repeat('../', count($fromParts) - 1);
        $rel .= implode('/', $toParts);
        
        return rtrim($rel, '/');
    }
}
