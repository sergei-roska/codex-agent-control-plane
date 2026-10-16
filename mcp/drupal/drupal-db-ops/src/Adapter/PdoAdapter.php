<?php

namespace DrupalMcp\DbOps\Adapter;

use DrupalMcp\SharedArgs\LazyProjectRoots;

/**
 * Direct PDO adapter for Drupal databases.
 *
 * Reads database credentials from Drupal's settings.php without bootstrapping
 * the Drupal container. Supports MySQL/MariaDB and PostgreSQL.
 *
 * HARD CONSTRAINT: No \Drupal::*, no Drush, no container calls anywhere in
 * this adapter or the tools that use it.
 */
class PdoAdapter {
    use LazyProjectRoots;

    private ?\PDO $pdo = null;
    private array $dbInfo = [];

    public function __construct(?string $projectRoot = null, ?string $drupalRoot = null, ?array $argv = null, ?string $entryPoint = null) {
        $this->initLazyRoots($projectRoot, $drupalRoot, $argv, $entryPoint);
    }

    private function rootResolutionException(string $message): \Exception {
        return new AdapterException($message);
    }


    /**
     * Return a connected PDO instance (lazy, cached).
     */
    public function getPdo(): \PDO {
        $this->ensureResolved();
        if ($this->pdo !== null) {
            return $this->pdo;
        }

        $creds = $this->readCredentials();
        $this->pdo = $this->connect($creds);
        return $this->pdo;
    }

    /**
     * Return raw DB info array (driver, host, dbname, etc.) for diagnostics.
     */
    public function getDbInfo(): array {
        $this->ensureResolved();
        if (empty($this->dbInfo)) {
            $this->dbInfo = $this->readCredentials();
        }
        return $this->dbInfo;
    }

    /**
     * Parse Drupal settings.php to extract $databases credentials.
     *
     * Uses output buffering + a minimal stub for $settings/$config arrays so
     * the file can be included without crashing on undefined variables.
     */
    private function readCredentials(): array {
        $settingsFile = $this->drupalRoot . '/sites/default/settings.php';
        if (!file_exists($settingsFile)) {
            throw new AdapterException("settings.php not found at: $settingsFile");
        }

        // Minimal stubs to survive settings.php include
        $app_root  = $this->drupalRoot;
        $site_path = 'sites/default';
        $databases = [];
        $settings  = [];
        $config    = [];
        $config_directories = [];

        // Suppress output during include
        ob_start();
        try {
            // phpcs:ignore
            include $settingsFile;
        } catch (\Throwable $e) {
            ob_end_clean();
            // Not fatal — settings.php may include other files that don't exist
        }
        ob_end_clean();

        if (empty($databases)) {
            throw new AdapterException("No \$databases found in settings.php — ensure the file defines database credentials.");
        }

        // Support both flat (legacy) and nested (current) formats
        $db = $databases['default']['default'] ?? reset($databases['default'] ?? [reset($databases)]);
        if (!is_array($db) || empty($db['driver'])) {
            throw new AdapterException("Could not parse database connection info from settings.php.");
        }

        $this->dbInfo = $db;
        return $db;
    }

    /**
     * Connect via PDO using parsed credentials.
     */
    private function connect(array $db): \PDO {
        $driver   = strtolower($db['driver'] ?? 'mysql');
        $host     = $db['host'] ?? '127.0.0.1';
        $port     = $db['port'] ?? ($driver === 'pgsql' ? 5432 : 3306);
        $dbname   = $db['database'] ?? '';
        $username = $db['username'] ?? '';
        $password = $db['password'] ?? '';
        $prefix   = $db['prefix'] ?? '';

        // Normalize prefix — Drupal 10+ uses ['default' => ''] or a plain string
        if (is_array($prefix)) {
            $prefix = $prefix['default'] ?? '';
        }

        if ($driver === 'pgsql') {
            $dsn = "pgsql:host=$host;port=$port;dbname=$dbname";
        } else {
            // mysql / mysqli / mariadb all map to mysql PDO driver
            $dsn = "mysql:host=$host;port=$port;dbname=$dbname;charset=utf8mb4";
        }

        $options = [
            \PDO::ATTR_ERRMODE            => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_OBJ,
        ];

        try {
            $pdo = new \PDO($dsn, $username, $password, $options);
        } catch (\PDOException $e) {
            throw new AdapterException("PDO connection failed: " . $e->getMessage());
        }

        return $pdo;
    }

    /**
     * Helper: apply optional table prefix to a Drupal table name.
     */
    public function table(string $name): string {
        $prefix = $this->dbInfo['prefix'] ?? '';
        if (is_array($prefix)) {
            $prefix = $prefix['default'] ?? '';
        }
        return $prefix . $name;
    }

    /**
     * Locate the config/sync directory relative to project or Drupal root.
     */
    public function findSyncDir(): ?string {
        $this->ensureResolved();
        $locations = [
            'config/sync',
            '../config/sync',
            'sites/default/files/config_sync',
        ];

        foreach ($locations as $loc) {
            $dir = $this->drupalRoot . '/' . ltrim($loc, '/');
            if (is_dir($dir)) return realpath($dir);
            $dir = $this->projectRoot . '/' . ltrim($loc, '/');
            if (is_dir($dir)) return realpath($dir);
        }
        return null;
    }
}
