<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only config impact analyzer. Uses DiffActiveVsSync to determine what
 * changed and derives impact from config name patterns and key analysis.
 * No Drupal container required.
 */
class AnalyzeConfigImpact {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the config object to analyze.")]
        string $config_name,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $diffTool = new DiffActiveVsSync($this->adapter);
            $diffRes  = $diffTool->execute($config_name);
            $diffData = ($diffRes['ok'] && !empty($diffRes['data'])) ? $diffRes['data'][0] : [];

            $status      = $diffData['status']     ?? 'unknown';
            $riskLevel   = $diffData['risk_level'] ?? 'medium';
            $changedKeys = $diffData['changed_keys'] ?? [];

            // Derive touched domains from config name prefix
            $touchedDomains = [];
            if (str_starts_with($config_name, 'field.')) {
                $touchedDomains[] = 'data_schema';
            }
            if (str_starts_with($config_name, 'views.view.')) {
                $touchedDomains[] = 'ui_display';
            }
            if ($config_name === 'core.extension' || str_starts_with($config_name, 'core.extension')) {
                $touchedDomains[] = 'module_lifecycle';
            }
            if (str_starts_with($config_name, 'node.type.')) {
                $touchedDomains[] = 'content_type';
            }
            if (str_starts_with($config_name, 'user.role.')) {
                $touchedDomains[] = 'permissions';
            }
            if (str_starts_with($config_name, 'system.')) {
                $touchedDomains[] = 'system_config';
            }

            // Derive follow-up recommendations
            $followups = [];
            if ($riskLevel === 'high') {
                $followups[] = 'Manual database backup verification recommended before deployment.';
            }
            if (in_array('data_schema', $touchedDomains, true)) {
                $followups[] = 'Field schema changes require running database updates (drush updb).';
            }
            if (in_array('module_lifecycle', $touchedDomains, true)) {
                $followups[] = 'Module list changes — verify all required modules are present on target.';
            }
            if (count($changedKeys) > 5) {
                $followups[] = 'Many keys changed — consider running full drift scan with detect_config_drift.';
            }

            $result = [
                'target'            => $config_name,
                'impact_summary'    => "Config $config_name is $status with risk level $riskLevel. Changed keys: " . implode(', ', array_slice($changedKeys, 0, 5)) . (count($changedKeys) > 5 ? '...' : '.'),
                'changed_keys'      => $changedKeys,
                'touched_domains'   => $touchedDomains,
                'risk_level'        => $riskLevel,
                'required_followups' => $followups,
                'method'            => 'pdo',
            ];

            return Envelope::ok(
                "Impact analysis for $config_name. Risk: $riskLevel.",
                [$result],
                [],
                ['tool' => 'analyze_config_impact']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'analyze_config_impact'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'analyze_config_impact'
            ]);
        }
    }
}
