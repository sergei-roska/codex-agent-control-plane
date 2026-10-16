<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only canonical implementation: reads the `key_value` table
 * collection='state' directly via PDO. This is the authoritative version;
 * drupal-ops has a mirrored Drush-based copy (note M1 in TOOLS_MANIFEST).
 * No Drupal container required.
 */
class DebugStateSystem {
    private PdoAdapter $adapter;

    // Keys safe to expose (allowlist guards against leaking sensitive state values)
    private const ALLOWLIST = [
        'system.cron_last',
        'system.maintenance_mode',
        'install_profile',
        'install_time',
        'update_last_check',
        'update_last_email_notification',
        'system.private_key',  // excluded by filter below
    ];

    private const PROFILES = [
        'cron'        => ['system.cron_last'],
        'maintenance' => ['system.maintenance_mode'],
        'update'      => ['update_last_check', 'update_last_email_notification'],
    ];

    // Never expose these even if explicitly requested
    private const NEVER_EXPOSE = [
        'system.private_key',
    ];

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Specific state keys to retrieve.")]
        ?array $keys = null,
        #[Schema(description: "Filter state keys by prefix.")]
        ?string $prefix = null,
        #[Schema(description: "Filter by key profile: cron, maintenance, or update.")]
        ?string $allowlist_profile = null,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo     = $this->adapter->getPdo();
            $kvTable = $this->adapter->table('key_value');

            $targetKeys = $keys ?: [];

            if ($allowlist_profile && isset(self::PROFILES[$allowlist_profile])) {
                $targetKeys = array_merge($targetKeys, self::PROFILES[$allowlist_profile]);
            }

            // Filter out sensitive and invalid keys
            $validKeys = array_values(array_filter($targetKeys, function ($k) {
                if (in_array($k, self::NEVER_EXPOSE, true)) {
                    return false;
                }
                return in_array($k, self::ALLOWLIST, true) || str_starts_with($k, 'system.');
            }));

            if (empty($validKeys) && !$prefix && !$allowlist_profile) {
                return Envelope::ok("No valid state keys provided or allowed.", [], [], [
                    'tool' => 'debug_state_system'
                ]);
            }

            $results = [];

            // Fetch specific keys
            if (!empty($validKeys)) {
                $placeholders = implode(',', array_fill(0, count($validKeys), '?'));
                $stmt = $pdo->prepare("SELECT name, value FROM $kvTable WHERE collection = 'state' AND name IN ($placeholders)");
                $stmt->execute($validKeys);
                foreach ($stmt->fetchAll() as $row) {
                    $val = @unserialize((string) $row->value);
                    $results[(string) $row->name] = $val;
                }
            }

            // Fetch by prefix
            if ($prefix) {
                $stmt = $pdo->prepare("SELECT name, value FROM $kvTable WHERE collection = 'state' AND name LIKE ?");
                $stmt->execute([$prefix . '%']);
                foreach ($stmt->fetchAll() as $row) {
                    $name = (string) $row->name;
                    // Apply allowlist filter for prefix queries
                    if (in_array($name, self::NEVER_EXPOSE, true)) continue;
                    if (!in_array($name, self::ALLOWLIST, true) && !str_starts_with($name, 'system.')) continue;
                    $val = @unserialize((string) $row->value);
                    $results[$name] = $val;
                }
            }

            return Envelope::ok(
                "Retrieved " . count($results) . " state key(s).",
                [$results],
                [],
                ['tool' => 'debug_state_system']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_state_system'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_state_system'
            ]);
        }
    }
}
