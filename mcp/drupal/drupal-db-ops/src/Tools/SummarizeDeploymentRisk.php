<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Server\RequestContext;

/**
 * SQL-only deployment risk summarizer. Aggregates drift detection results
 * via PDO and classifies the deployment risk based on changed config objects.
 * No Drupal container required.
 */
class SummarizeDeploymentRisk {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $driftTool = new DetectConfigDrift($this->adapter);
            $driftRes  = $driftTool->execute(null, 200);

            $driftItems = $driftRes['ok'] ? ($driftRes['data'] ?? []) : [];
            $driftCount = $driftRes['counts']['total'] ?? count($driftItems);

            $riskItems  = [];
            $blockers   = [];

            foreach ($driftItems as $item) {
                $name = $item['name'] ?? '';
                if (
                    str_starts_with($name, 'field.storage.')
                    || $name === 'core.extension'
                    || str_starts_with($name, 'node.type.')
                    || $name === 'system.site'
                ) {
                    $riskItems[] = $name;
                }
            }

            if (!$driftRes['ok']) {
                $blockers[] = 'Drift detection failed: ' . ($driftRes['errors'][0]['message'] ?? 'unknown error');
            }

            $syncDir = $this->adapter->findSyncDir();
            if (!$syncDir) {
                $blockers[] = 'config/sync directory not found — deployment drift comparison is incomplete.';
            }

            $checks = [
                'Verify all config is exported to sync storage.',
                'Run detect_config_drift to see the full list of changed items.',
            ];

            if (!empty($riskItems)) {
                $checks[] = 'High-risk config objects detected — review carefully: ' . implode(', ', array_slice($riskItems, 0, 5));
            }

            $summary = empty($blockers)
                ? "Found $driftCount drifting config object(s)."
                : "INCOMPLETE: " . $blockers[0];

            $result = [
                'summary'            => $summary,
                'drift_count'        => $driftCount,
                'highest_risk_items' => $riskItems,
                'blockers'           => $blockers,
                'suggested_checks'   => $checks,
                'method'             => 'pdo',
            ];

            return Envelope::ok($summary, [$result], [], ['tool' => 'summarize_deployment_risk']);
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'summarize_deployment_risk'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'summarize_deployment_risk'
            ]);
        }
    }
}
