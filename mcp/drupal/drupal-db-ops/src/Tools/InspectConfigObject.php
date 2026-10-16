<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Symfony\Component\Yaml\Yaml;
use Mcp\Server\RequestContext;

/**
 * SQL-only config object inspector. Reads from the `config` table (active
 * storage) and optionally compares against sync files on disk.
 * source='active' only — per TOOLS_MANIFEST note for MCP 6.
 * No Drupal container required.
 */
class InspectConfigObject {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the config object (e.g., system.site).")]
        string $config_name,
        #[Schema(description: "Source storage: active (DB), sync (files), or both.")]
        string $source = 'active',
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $results = ['config_name' => $config_name];

            if ($source === 'active' || $source === 'both') {
                $results['active'] = $this->readFromDb($config_name);
            }

            if ($source === 'sync' || $source === 'both') {
                $results['sync'] = $this->readFromSync($config_name);
            }

            $hasActive = !empty($results['active']);
            $hasSync   = !empty($results['sync']);

            $summary = "Inspected $config_name from $source.";
            if (!$hasActive && $source !== 'sync') {
                $summary .= " Not found in active config table.";
            }

            return Envelope::ok($summary, [$results], [], ['tool' => 'inspect_config_object']);
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'inspect_config_object'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'inspect_config_object'
            ]);
        }
    }

    public function readFromDb(string $config_name): ?array {
        $pdo       = $this->adapter->getPdo();
        $cfgTable  = $this->adapter->table('config');
        $stmt      = $pdo->prepare("SELECT data FROM $cfgTable WHERE name = :name LIMIT 1");
        $stmt->execute([':name' => $config_name]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        $data = @unserialize((string) $row->data);
        return ['name' => $config_name, 'data' => $data ?: []];
    }

    public function readFromSync(string $config_name): ?array {
        $syncDir = $this->adapter->findSyncDir();
        if (!$syncDir) {
            return null;
        }
        $file = $syncDir . '/' . $config_name . '.yml';
        if (!file_exists($file)) {
            return null;
        }
        try {
            return Yaml::parseFile($file);
        } catch (\Exception $e) {
            return null;
        }
    }
}
