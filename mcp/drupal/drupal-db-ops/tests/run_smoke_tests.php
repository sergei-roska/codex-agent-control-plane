<?php

/**
 * Smoke tests for drupal-db-ops.
 *
 * Uses a PHP-level mock PDO (no real DB driver required) to simulate Drupal's
 * core tables. Compatible with environments that have no SQLite or MySQL
 * PDO extension available in isolation.
 *
 * Run: php tests/run_smoke_tests.php
 */

require_once __DIR__ . '/../vendor/autoload.php';

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Tools\DebugWatchdog;
use DrupalMcp\DbOps\Tools\DebugQueueState;
use DrupalMcp\DbOps\Tools\DebugCronState;
use DrupalMcp\DbOps\Tools\DebugCacheState;
use DrupalMcp\DbOps\Tools\DebugEnvironmentSummary;
use DrupalMcp\DbOps\Tools\DebugStateSystem;
use DrupalMcp\DbOps\Tools\DebugRuntimeHealth;
use DrupalMcp\DbOps\Tools\DebugFailedOperations;
use DrupalMcp\DbOps\Tools\InspectConfigObject;
use DrupalMcp\DbOps\Tools\DiffActiveVsSync;
use DrupalMcp\DbOps\Tools\DetectConfigDrift;
use DrupalMcp\DbOps\Tools\AnalyzeConfigImpact;
use DrupalMcp\DbOps\Tools\SummarizeDeploymentRisk;

// ============================================================
// Tiny in-process data store used by MockPDO
// ============================================================

class TableStore {
    private static array $tables = [];

    public static function seed(string $table, array $rows): void {
        self::$tables[$table] = $rows;
    }

    public static function getRows(string $table): array {
        return self::$tables[$table] ?? [];
    }

    public static function allTables(): array {
        return array_keys(self::$tables);
    }
}

// ============================================================
// Mock PDOStatement — returns pre-seeded rows
// ============================================================

class MockStatement extends \PDOStatement {
    private array $rows;
    private int   $pos = 0;

    public function __construct(array $rows) {
        $this->rows = array_map(fn($r) => (object) $r, $rows);
    }

    public function execute(?array $params = null): bool { $this->pos = 0; return true; }

    public function fetch(int $mode = \PDO::FETCH_DEFAULT, int $cursorOrientation = \PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed {
        return isset($this->rows[$this->pos]) ? $this->rows[$this->pos++] : false;
    }

    public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array {
        return $this->rows;
    }

    public function fetchColumn(int $column = 0): mixed {
        $row = $this->fetch();
        if (!$row) return false;
        $vals = array_values((array) $row);
        return $vals[$column] ?? false;
    }
}

// ============================================================
// Mock PDO — routes queries to TableStore
// ============================================================

class MockPDO extends \PDO {
    public function __construct() {}

    // Basic query router based on table name extraction
    private function resolveTable(string $sql): ?string {
        // Normalise
        $sql = preg_replace('/\s+/', ' ', trim($sql));

        // SELECT … FROM tablename
        if (preg_match('/FROM\s+(\w+)/i', $sql, $m)) {
            return $m[1];
        }
        // SHOW TABLES LIKE
        if (preg_match('/SHOW TABLES/i', $sql)) {
            return '__show_tables__';
        }
        return null;
    }

    private function applyFilters(array $rows, string $sql, array $params): array {
        // Very lightweight: interpret WHERE collection = ? AND name = ?
        // Check for collection filter
        if (preg_match('/collection\s*=\s*[\'"]?(\w[\w.]*)[\'"]?/i', $sql, $m)) {
            $coll = $m[1];
            // Replace with param if placeholder used
            if ($coll === '' || str_contains($coll, ':') || $coll === '?') {
                $coll = reset($params);
            }
            $rows = array_filter($rows, fn($r) => ($r['collection'] ?? '') === $coll);
        }
        // Check for name = X filter
        if (preg_match('/\bname\s*=\s*[\'"]([^\'"]+)[\'"]/i', $sql, $m)) {
            $n = $m[1];
            $rows = array_filter($rows, fn($r) => ($r['name'] ?? '') === $n);
        } elseif (preg_match('/\bname\s*=\s*\?/i', $sql) && !empty($params)) {
            $n = is_array($params) ? reset($params) : $params;
            $rows = array_filter($rows, fn($r) => ($r['name'] ?? '') === $n);
        }
        // Check for name IN (...)
        if (preg_match('/name\s+IN\s*\(/i', $sql) && !empty($params)) {
            $allowed = is_array($params) ? array_values($params) : [];
            $rows = array_filter($rows, fn($r) => in_array($r['name'] ?? '', $allowed, true));
        }
        // Check for name LIKE ? (prefix scan)
        if (preg_match('/name\s+LIKE\s+\?/i', $sql) && !empty($params)) {
            $pattern = str_replace('%', '', is_array($params) ? reset($params) : $params);
            $rows = array_filter($rows, fn($r) => str_starts_with($r['name'] ?? '', $pattern));
        }
        // severity filter
        if (preg_match('/severity\s*=\s*:severity/i', $sql) && isset($params[':severity'])) {
            $sev = (int) $params[':severity'];
            $rows = array_filter($rows, fn($r) => ($r['severity'] ?? 99) === $sev);
        }
        // severity <= threshold
        if (preg_match('/severity\s*<=\s*:sev/i', $sql) && isset($params[':sev'])) {
            $sev = (int) $params[':sev'];
            $rows = array_filter($rows, fn($r) => ($r['severity'] ?? 99) <= $sev);
        }
        // type filter
        if (preg_match('/type\s*=\s*:type/i', $sql) && isset($params[':type'])) {
            $t = $params[':type'];
            $rows = array_filter($rows, fn($r) => ($r['type'] ?? '') === $t);
        }
        // uid filter
        if (preg_match('/uid\s*=\s*:uid/i', $sql) && isset($params[':uid'])) {
            $u = (int) $params[':uid'];
            $rows = array_filter($rows, fn($r) => ((int)($r['uid'] ?? 0)) === $u);
        }
        // queue_name filter
        if (preg_match('/name\s*=\s*:queue_name/i', $sql) && isset($params[':queue_name'])) {
            $qn = $params[':queue_name'];
            $rows = array_filter($rows, fn($r) => ($r['name'] ?? '') === $qn);
        }
        // wid = :wid
        if (preg_match('/wid\s*=\s*:wid/i', $sql) && isset($params[':wid'])) {
            $wid = (int) $params[':wid'];
            $rows = array_filter($rows, fn($r) => ((int)($r['wid'] ?? 0)) === $wid);
        }
        // config name = :name
        if (preg_match('/name\s*=\s*:name/i', $sql) && isset($params[':name'])) {
            $n = $params[':name'];
            $rows = array_filter($rows, fn($r) => ($r['name'] ?? '') === $n);
        }
        return array_values($rows);
    }

    public function prepare(string $query, array $options = []): \PDOStatement|false {
        $self = $this;
        $stmt = new class($query, $self) extends \PDOStatement {
            private string $sql;
            private MockPDO $pdo;
            private array $params = [];
            private array $result = [];

            public function __construct(string $sql, MockPDO $pdo) {
                $this->sql = $sql;
                $this->pdo = $pdo;
            }

            public function execute(?array $params = null): bool {
                $this->params = $params ?? [];
                $this->result = $this->pdo->resolveAndFilter($this->sql, $this->params);
                return true;
            }

            public function fetch(int $mode = \PDO::FETCH_DEFAULT, int $cursorOrientation = \PDO::FETCH_ORI_NEXT, int $cursorOffset = 0): mixed {
                $row = array_shift($this->result);
                return $row ? (object) $row : false;
            }

            public function fetchAll(int $mode = \PDO::FETCH_DEFAULT, mixed ...$args): array {
                return array_map(fn($r) => (object) $r, $this->result);
            }

            public function fetchColumn(int $column = 0): mixed {
                $row = $this->fetch();
                if (!$row) return false;
                $vals = array_values((array) $row);
                return $vals[$column] ?? false;
            }
        };
        return $stmt;
    }

    public function query(string $query, ?int $fetchMode = null, mixed ...$fetch_mode_args): \PDOStatement|false {
        $rows = $this->resolveAndFilter($query, []);
        return new MockStatement($rows);
    }

    public function getAttribute(int $attribute): mixed {
        return match($attribute) {
            \PDO::ATTR_SERVER_VERSION => 'mock-db-server-1.0',
            default => null,
        };
    }

    public function resolveAndFilter(string $sql, array $params): array {
        $table = $this->resolveTable($sql);
        if (!$table) return [];

        if ($table === '__show_tables__') {
            // Return empty — no table exists by default in mock (override per tool)
            if (preg_match('/LIKE\s+[\'"]([\w_]+)[\'"]/i', $sql, $m)) {
                $t = $m[1];
                return TableStore::getRows($t) !== [] ? [[$t => $t]] : [];
            }
            return [];
        }

        $rows = TableStore::getRows($table);

        // Aggregation shortcuts for queue GROUP BY
        if (preg_match('/GROUP BY/i', $sql) && $table === 'queue') {
            return $this->aggregateQueue($rows, $sql, $params);
        }

        // COUNT(*)
        if (preg_match('/COUNT\(\*\)/i', $sql)) {
            $filtered = $this->applyFilters($rows, $sql, $params);
            return [['COUNT(*)' => count($filtered)]];
        }

        return $this->applyFilters($rows, $sql, $params);
    }

    private function aggregateQueue(array $rows, string $sql, array $params): array {
        // Apply name filter first
        if (preg_match('/name\s*=\s*:queue_name/i', $sql) && isset($params[':queue_name'])) {
            $rows = array_filter($rows, fn($r) => ($r['name'] ?? '') === $params[':queue_name']);
        }
        $groups = [];
        $now    = time();
        foreach ($rows as $row) {
            $name = $row['name'];
            if (!isset($groups[$name])) {
                $groups[$name] = ['queue_name' => $name, 'item_count' => 0, 'oldest_item_timestamp' => null, 'claimed_count' => 0, 'name' => $name, 'cnt' => 0, 'oldest' => null];
            }
            $groups[$name]['item_count']++;
            $groups[$name]['cnt']++;
            $created = $row['created'] ?? $now;
            if ($groups[$name]['oldest_item_timestamp'] === null || $created < $groups[$name]['oldest_item_timestamp']) {
                $groups[$name]['oldest_item_timestamp'] = $created;
                $groups[$name]['oldest'] = $created;
            }
            if (($row['expire'] ?? 0) > 0) $groups[$name]['claimed_count']++;
        }
        return array_values($groups);
    }
}

// ============================================================
// MockPdoAdapter — wraps MockPDO
// ============================================================

class MockPdoAdapter extends PdoAdapter {
    private MockPDO  $mockPdo;
    private string   $mockProjectRoot;
    private string   $mockDrupalRoot;
    private ?string  $mockSyncDir;

    public function __construct(MockPDO $pdo, string $projectRoot, string $drupalRoot, ?string $syncDir = null) {
        $this->mockPdo         = $pdo;
        $this->mockProjectRoot = $projectRoot;
        $this->mockDrupalRoot  = $drupalRoot;
        $this->mockSyncDir     = $syncDir;
    }

    public function getPdo(): \PDO           { return $this->mockPdo; }
    public function getProjectRoot(): string { return $this->mockProjectRoot; }
    public function getDrupalRoot(): string  { return $this->mockDrupalRoot; }
    public function getDbInfo(): array       { return ['driver' => 'mock', 'prefix' => '']; }
    public function table(string $name): string { return $name; }
    public function findSyncDir(): ?string   { return $this->mockSyncDir; }
}

// ============================================================
// Seed data
// ============================================================

$now = time();
$old = $now - 90000; // older than 24h

TableStore::seed('watchdog', [
    ['wid' => 1, 'uid' => 0, 'type' => 'php',    'message' => 'Fatal error: @error', 'variables' => serialize(['@error' => 'Out of mem.']), 'severity' => 3, 'link' => '', 'location' => '', 'hostname' => '127.0.0.1', 'timestamp' => $now],
    ['wid' => 2, 'uid' => 1, 'type' => 'system', 'message' => 'Cron completed.',      'variables' => serialize([]),                           'severity' => 6, 'link' => '', 'location' => '', 'hostname' => '127.0.0.1', 'timestamp' => $now - 3600],
]);

TableStore::seed('queue', [
    ['item_id' => 1, 'name' => 'email_send',  'data' => '', 'expire' => 0,   'created' => $now],
    ['item_id' => 2, 'name' => 'email_send',  'data' => '', 'expire' => 100, 'created' => $now],
    ['item_id' => 3, 'name' => 'stale_queue', 'data' => '', 'expire' => 0,   'created' => $old],
]);

TableStore::seed('key_value', [
    ['collection' => 'state', 'name' => 'system.cron_last',        'value' => serialize($now - 7200)],
    ['collection' => 'state', 'name' => 'system.maintenance_mode', 'value' => serialize(0)],
    ['collection' => 'system.schema', 'name' => 'node', 'value' => serialize(10001)],
    ['collection' => 'system.schema', 'name' => 'user', 'value' => serialize(10001)],
]);

TableStore::seed('semaphore', []); // no active cron lock

TableStore::seed('cache_default', [
    ['cid' => 'valid_entry', 'data' => '', 'expire' => 0,          'created' => $now,       'serialized' => 0, 'tags' => '', 'checksum' => ''],
    ['cid' => 'stale_entry', 'data' => '', 'expire' => $now - 100, 'created' => $now - 200, 'serialized' => 0, 'tags' => '', 'checksum' => ''],
]);

$siteCfg = serialize(['name' => 'My Drupal Site', 'mail' => 'admin@example.com', 'uuid' => 'abc-123']);
TableStore::seed('config', [
    ['collection' => '', 'name' => 'system.site', 'data' => $siteCfg],
]);

// ============================================================
// Build adapters
// ============================================================

$mockPdo     = new MockPDO();
$tmpRoot     = sys_get_temp_dir() . '/drupal_db_ops_test_' . getmypid();
@mkdir($tmpRoot, 0755, true);
$adapter     = new MockPdoAdapter($mockPdo, $tmpRoot, $tmpRoot, null);

// Adapter with a sync dir
$syncDir = sys_get_temp_dir() . '/drupal_db_ops_sync_' . getmypid();
mkdir($syncDir, 0755, true);
file_put_contents($syncDir . '/system.site.yml', "name: 'My Drupal Site'\nmail: admin@example.com\nuuid: abc-123\n");
file_put_contents($syncDir . '/node.type.article.yml', "type: article\nname: Article\n");
// Add article config to store
$articleData = serialize(['type' => 'article', 'name' => 'News Article']);
TableStore::seed('config', [
    ['collection' => '', 'name' => 'system.site',       'data' => $siteCfg],
    ['collection' => '', 'name' => 'node.type.article', 'data' => $articleData],
]);
$adapterWithSync = new MockPdoAdapter($mockPdo, $tmpRoot, $tmpRoot, $syncDir);

// ============================================================
// Test harness
// ============================================================

$passed = 0;
$failed = 0;

function ok(string $label, bool $condition, string $details = ''): void {
    global $passed, $failed;
    if ($condition) {
        echo "  \033[32m✓\033[0m $label\n";
        $passed++;
    } else {
        echo "  \033[31m✗\033[0m $label" . ($details ? " — $details" : '') . "\n";
        $failed++;
    }
}

function section(string $title): void {
    echo "\n\033[1m$title\033[0m\n";
}

// ============================================================
// Tests
// ============================================================

section("1. DebugWatchdog");
$tool = new DebugWatchdog($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("returns 2 entries", count($res['data']) === 2, json_encode($res['data']));
ok("entry has event_id field", isset($res['data'][0]['event_id']));
ok("entry has timestamp field", isset($res['data'][0]['timestamp']));
ok("severity filter works", count((new DebugWatchdog($adapter))->execute(severity: '6')['data']) === 1);
ok("type filter works", count((new DebugWatchdog($adapter))->execute(type: 'php')['data']) === 1);

section("2. DebugQueueState");
$tool = new DebugQueueState($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("returns queue groups", count($res['data']) >= 1, json_encode($res['data']));
$emailQueue = null;
foreach ($res['data'] as $q) {
    if ($q['queue_name'] === 'email_send') { $emailQueue = $q; break; }
}
ok("email_send exists", $emailQueue !== null);
ok("email_send item_count is 2", ($emailQueue['item_count'] ?? 0) === 2);
$resWithClaimed = (new DebugQueueState($adapter))->execute(include_claimed: true);
ok("include_claimed adds claimed_count field", isset($resWithClaimed['data'][0]['claimed_count']));
ok("claimed_count for email_send is 1", (function() use ($resWithClaimed) {
    foreach ($resWithClaimed['data'] as $q) {
        if ($q['queue_name'] === 'email_send') return ((int) $q['claimed_count']) === 1;
    }
    return false;
})());

section("3. DebugCronState");
$tool = new DebugCronState($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("has last_run field", isset($res['data'][0]['last_run']));
ok("status is OK (ran 2h ago)", $res['data'][0]['status'] === 'OK');
ok("is_running is false (no semaphore)", $res['data'][0]['is_running'] === false);

section("4. DebugEnvironmentSummary");
$tool = new DebugEnvironmentSummary($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("has maintenance_mode field", isset($res['data'][0]['maintenance_mode']));
ok("maintenance_mode is OFF", $res['data'][0]['maintenance_mode'] === 'OFF');
$resVer = (new DebugEnvironmentSummary($adapter))->execute(include_runtime_versions: true);
ok("include_runtime_versions adds php_version", isset($resVer['data'][0]['php_version']));
ok("include_runtime_versions adds db_driver", isset($resVer['data'][0]['db_driver']));

section("5. DebugStateSystem");
$tool = new DebugStateSystem($adapter);

$res = $tool->execute(keys: ['system.cron_last']);
ok("fetches system.cron_last", $res['ok'] === true && isset($res['data'][0]['system.cron_last']), json_encode($res['data']));

$res = $tool->execute(allowlist_profile: 'maintenance');
ok("allowlist_profile=maintenance fetches maintenance key", isset($res['data'][0]['system.maintenance_mode']));
ok("maintenance_mode is 0 (falsy)", $res['data'][0]['system.maintenance_mode'] == 0);

$res = $tool->execute(prefix: 'system.');
ok("prefix query returns results", $res['ok'] === true && !empty($res['data'][0]));

$res = $tool->execute();
ok("empty call returns ok with no data", $res['ok'] === true);

section("6. DebugRuntimeHealth");
$tool = new DebugRuntimeHealth($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("has health_status field", isset($res['data'][0]['health_status']));
ok("health_status is OK (cron ran 2h ago, maintenance OFF)", $res['data'][0]['health_status'] === 'OK');
ok("alerts array is empty", empty($res['data'][0]['alerts']));
$resDomains = (new DebugRuntimeHealth($adapter))->execute(include_domains: true);
ok("include_domains adds domains.env", isset($resDomains['data'][0]['domains']['env']));
ok("include_domains adds domains.cron", isset($resDomains['data'][0]['domains']['cron']));
$resRec = (new DebugRuntimeHealth($adapter))->execute(include_recommendations: true);
ok("include_recommendations adds next_steps array", isset($resRec['data'][0]['next_steps']));

section("7. DebugFailedOperations");
$tool = new DebugFailedOperations($adapter);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("result has total_failures key", isset($res['data'][0]['total_failures']));
ok("watchdog error is detected (severity<=3)", (function() use ($res) {
    foreach ($res['data'][0]['failures'] as $f) {
        if ($f['domain'] === 'watchdog') return true;
    }
    return false;
})());
ok("stale queue is detected", (function() use ($res) {
    foreach ($res['data'][0]['failures'] as $f) {
        if ($f['domain'] === 'queues') return true;
    }
    return false;
})());

section("8. InspectConfigObject");
$tool = new InspectConfigObject($adapter);
$res  = $tool->execute('system.site');
ok("execute() returns ok=true", $res['ok'] === true);
ok("result has active key", isset($res['data'][0]['active']));
ok("active data has name field", isset($res['data'][0]['active']['data']['name']));
ok("active name is 'My Drupal Site'", $res['data'][0]['active']['data']['name'] === 'My Drupal Site');
$resMissing = $tool->execute('nonexistent.config');
ok("missing config returns ok=true with null active", $resMissing['ok'] === true);
ok("missing config active is null", $resMissing['data'][0]['active'] === null);

section("9. DiffActiveVsSync (no sync dir)");
$tool = new DiffActiveVsSync($adapter);
$res  = $tool->execute('system.site');
ok("execute() returns ok=true", $res['ok'] === true);
ok("status is 'removed' (in DB, no sync dir)", $res['data'][0]['status'] === 'removed', $res['data'][0]['status'] ?? 'missing');
ok("has risk_level", isset($res['data'][0]['risk_level']));
ok("risk_level is 'high' for system.site", $res['data'][0]['risk_level'] === 'high');

section("10. DiffActiveVsSync (with sync dir)");
$tool = new DiffActiveVsSync($adapterWithSync);
$res  = $tool->execute('system.site');
ok("system.site with matching sync is 'identical'", $res['data'][0]['status'] === 'identical', $res['data'][0]['status'] ?? 'missing');

$res = (new DiffActiveVsSync($adapterWithSync))->execute('node.type.article');
ok("node.type.article with differing data is 'changed'", $res['data'][0]['status'] === 'changed', $res['data'][0]['status'] ?? 'missing');
ok("changed_keys is not empty", !empty($res['data'][0]['changed_keys']));

$res = (new DiffActiveVsSync($adapterWithSync))->execute('nonexistent.config');
ok("missing in both is 'missing_both'", $res['data'][0]['status'] === 'missing_both');

section("11. DetectConfigDrift");
$tool = new DetectConfigDrift($adapterWithSync);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("found at least 1 drifting item", ($res['counts']['total'] ?? 0) >= 1, json_encode($res['counts'] ?? []));
ok("node.type.article appears as 'update'", (function() use ($res) {
    foreach ($res['data'] as $item) {
        if ($item['name'] === 'node.type.article' && $item['operation'] === 'update') return true;
    }
    return false;
})());
ok("system.site (identical) is NOT in drift list", (function() use ($res) {
    foreach ($res['data'] as $item) {
        if ($item['name'] === 'system.site') return false;
    }
    return true;
})());

section("12. AnalyzeConfigImpact");
$tool = new AnalyzeConfigImpact($adapterWithSync);
$res  = $tool->execute('node.type.article');
ok("execute() returns ok=true", $res['ok'] === true);
ok("has risk_level field", isset($res['data'][0]['risk_level']));
ok("risk_level is 'high' for node.type.", $res['data'][0]['risk_level'] === 'high');
ok("content_type domain is detected", in_array('content_type', $res['data'][0]['touched_domains']));
ok("has required_followups", isset($res['data'][0]['required_followups']));

section("13. SummarizeDeploymentRisk");
$tool = new SummarizeDeploymentRisk($adapterWithSync);
$res  = $tool->execute();
ok("execute() returns ok=true", $res['ok'] === true);
ok("has drift_count", isset($res['data'][0]['drift_count']));
ok("has highest_risk_items", isset($res['data'][0]['highest_risk_items']));
ok("has suggested_checks", isset($res['data'][0]['suggested_checks']));

// ============================================================
// Envelope structure validation across all tools
// ============================================================

section("14. Envelope structure validation");
$allResults = [
    'DebugWatchdog'           => (new DebugWatchdog($adapter))->execute(),
    'DebugQueueState'         => (new DebugQueueState($adapter))->execute(),
    'DebugCronState'          => (new DebugCronState($adapter))->execute(),
    'DebugEnvironmentSummary' => (new DebugEnvironmentSummary($adapter))->execute(),
    'DebugStateSystem'        => (new DebugStateSystem($adapter))->execute(keys: ['system.cron_last']),
    'DebugRuntimeHealth'      => (new DebugRuntimeHealth($adapter))->execute(),
    'DebugFailedOperations'   => (new DebugFailedOperations($adapter))->execute(),
    'InspectConfigObject'     => (new InspectConfigObject($adapter))->execute('system.site'),
    'DiffActiveVsSync'        => (new DiffActiveVsSync($adapter))->execute('system.site'),
    'DetectConfigDrift'       => (new DetectConfigDrift($adapterWithSync))->execute(),
    'AnalyzeConfigImpact'     => (new AnalyzeConfigImpact($adapterWithSync))->execute('node.type.article'),
    'SummarizeDeploymentRisk' => (new SummarizeDeploymentRisk($adapterWithSync))->execute(),
];

foreach ($allResults as $toolName => $result) {
    ok("$toolName has all required envelope keys", (
        array_key_exists('ok', $result)      &&
        array_key_exists('summary', $result) &&
        array_key_exists('data', $result)    &&
        array_key_exists('counts', $result)  &&
        array_key_exists('meta', $result)    &&
        array_key_exists('errors', $result)
    ));
    ok("$toolName meta.server is 'drupal-db-ops'", $result['meta']['server'] === 'drupal-db-ops');
    ok("$toolName meta.execution is 'pdo'", $result['meta']['execution'] === 'pdo');
}

// Cleanup
foreach ([$syncDir . '/system.site.yml', $syncDir . '/node.type.article.yml'] as $f) {
    @unlink($f);
}
@rmdir($syncDir);
@rmdir($tmpRoot);

// ============================================================
// Summary
// ============================================================

echo "\n";
echo str_repeat('─', 50) . "\n";
$total = $passed + $failed;
if ($failed === 0) {
    echo "\033[32m✓ All $total tests passed.\033[0m\n";
    exit(0);
} else {
    echo "\033[31m✗ $failed/$total tests failed.\033[0m\n";
    exit(1);
}
