<?php

namespace DrupalMcp\Ops\Adapter;

use Symfony\Component\Process\Process;
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
            $process = new Process(['lando', 'version'], $this->projectRoot);
            $process->run();
            if ($process->isSuccessful()) {
                $this->environment = 'lando';
                return 'lando';
            }
        }

        if (is_dir($this->projectRoot . '/.ddev')) {
            $process = new Process(['ddev', '--version'], $this->projectRoot);
            $process->run();
            if ($process->isSuccessful()) {
                $this->environment = 'ddev';
                return 'ddev';
            }
        }

        $this->environment = 'local';
        return 'local';
    }

    /**
     * Evaluate dynamic PHP in Drupal runtime and return decoded JSON array.
     * Params are injected via base64-encoded JSON at the top of the wrapper.
     */
    public function evaluate(string $phpCode, array $params = []): array {
        $this->ensureResolved();
        $env = $this->detectEnvironment();

        $base64Payload = base64_encode($phpCode);
        $base64Params = base64_encode(json_encode($params));

        // Standard Drupal container bootstrap wrapper
        $wrapper = <<<PHP
\$bootstrap_ok = class_exists('\\\\Drupal') && \\Drupal::hasContainer();
if (!\$bootstrap_ok) {
    echo json_encode(['error' => 'DRUPAL_NOT_BOOTSTRAPPED', 'message' => 'Drupal container not initialized.']);
    exit(1);
}
try {
    \$params = json_decode(base64_decode('{$base64Params}'), true);
    \$result = eval(base64_decode('{$base64Payload}'));
    echo json_encode(\$result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (\\Throwable \$e) {
    echo json_encode(['error' => 'PHP_EXECUTION_ERROR', 'message' => \$e->getMessage() . ' in ' . \$e->getFile() . ':' . \$e->getLine()]);
    exit(1);
}
PHP;

        $drushCommand = [];
        if ($env === 'lando') {
            $drushCommand = ['lando', 'drush'];
        } elseif ($env === 'ddev') {
            $drushCommand = ['ddev', 'drush'];
        } else {
            $vendorDrush = $this->projectRoot . '/vendor/bin/drush';
            if (file_exists($vendorDrush)) {
                $drushCommand = [$vendorDrush];
            } else {
                $drushCommand = ['drush'];
            }
        }

        // Add root option if drupal root differs from project root
        if ($this->drupalRoot !== $this->projectRoot) {
            $relPath = ltrim(str_replace($this->projectRoot, '', $this->drupalRoot), '/');
            $drushCommand[] = '--root=' . ($relPath ?: '.');
        }

        // Handle URI option if configured in env
        $drushUri = getenv('DRUSH_OPTIONS_URI') ?: getenv('DRUSH_URI');
        if ($drushUri) {
            $drushCommand[] = '--uri=' . $drushUri;
        }

        $drushCommand[] = 'php-eval';
        $drushCommand[] = $wrapper;

        $process = new Process($drushCommand, $this->projectRoot);
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
}
