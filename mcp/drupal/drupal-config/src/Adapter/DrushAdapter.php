<?php

namespace DrupalMcp\Config\Adapter;

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

        // Check Lando
        if (file_exists($this->projectRoot . '/.lando.yml')) {
            $process = new Process(['lando', 'version'], $this->projectRoot);
            $process->run();
            if ($process->isSuccessful()) {
                $this->environment = 'lando';
                return 'lando';
            }
        }

        // Check DDEV
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

    public function evaluate(string $phpCode, array $params = []): mixed {
        $this->ensureResolved();
        $env = $this->detectEnvironment();
        
        $base64Payload = base64_encode($phpCode);
        $base64Params = base64_encode(json_encode($params));
        
        // Construct wrapper
        $wrapper = <<<PHP
\$bootstrap_ok = class_exists('\\\\Drupal') && \\Drupal::hasContainer();
if (!\$bootstrap_ok) {
    echo json_encode(['error' => 'DRUPAL_NOT_BOOTSTRAPPED', 'message' => 'Drupal container not initialized.']);
    exit;
}
try {
    \$params = json_decode(base64_decode('{$base64Params}'), true);
    \$result = eval(base64_decode('{$base64Payload}'));
    echo json_encode(\$result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
} catch (\\Throwable \$e) {
    echo json_encode(['error' => 'PHP_EXECUTION_ERROR', 'message' => \$e->getMessage() . ' in ' . \$e->getFile() . ':' . \$e->getLine()]);
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

        // Add options
        if ($this->drupalRoot !== $this->projectRoot) {
            $relPath = ltrim(str_replace($this->projectRoot, '', $this->drupalRoot), '/');
            $drushCommand[] = '--root=' . ($relPath ?: '.');
        }

        $drushUri = getenv('DRUSH_OPTIONS_URI') ?: getenv('DRUSH_URI');
        if ($drushUri) {
            $drushCommand[] = '--uri=' . $drushUri;
        }

        $drushCommand[] = 'php-eval';
        $drushCommand[] = $wrapper;

        $process = new Process($drushCommand, $this->projectRoot);
        $process->setTimeout(30.0);
        $process->run();

        if (!$process->isSuccessful()) {
            throw new AdapterException("Drush execution failed: " . $process->getErrorOutput() . " | " . $process->getOutput());
        }

        $output = trim($process->getOutput());
        if (empty($output)) {
            throw new AdapterException("Empty response from Drush. Stderr: " . $process->getErrorOutput());
        }

        $result = json_decode($output, true);
        if ($result === null) {
            throw new AdapterException("Failed to decode JSON from Drush. Output: " . $output . " | Stderr: " . $process->getErrorOutput());
        }

        if (is_array($result) && isset($result['error'])) {
            if ($result['error'] === 'DRUPAL_NOT_BOOTSTRAPPED') {
                throw new AdapterException("Drupal Bootstrap Error: " . $result['message']);
            }
            if ($result['error'] === 'PHP_EXECUTION_ERROR') {
                throw new AdapterException("PHP Error: " . $result['message']);
            }
        }

        return $result;
    }
}
