<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Server\RequestContext;

class SummarizeDeploymentRisk {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(?RequestContext $context = null): array {
        $this->adapter->setRequestContext($context);

        try {
            $driftTool = new DetectConfigDrift($this->adapter);
            $driftRes = $driftTool->execute();
            
            $splitTool = new InspectConfigSplitState($this->adapter);
            $splitRes = $splitTool->execute();
            
            $driftItems = $driftRes['ok'] ? $driftRes['data'] : [];
            $splits = $splitRes['ok'] ? $splitRes['data'] : [];
            
            $riskItems = [];
            $blockers = [];
            $checks = ['Check if all config is exported to sync storage.'];
            
            // Check drift results
            if (isset($driftRes['errors']) && !empty($driftRes['errors'])) {
                $blockers[] = 'Drift detection failed due to Drush bootstrap failure.';
                $driftCount = 'unknown';
            } else {
                $driftCount = $driftRes['counts']['total'] ?? count($driftItems);
                foreach ($driftItems as $item) {
                    if (isset($item['name'])) {
                        if (strpos($item['name'], 'field.storage') !== false || strpos($item['name'], 'core.extension') !== false) {
                            $riskItems[] = $item['name'];
                        }
                    }
                }
            }
            
            // Check active splits
            $activeSplits = [];
            foreach ($splits as $s) {
                if (!empty($s['status'])) {
                    $activeSplits[] = $s['name'];
                }
            }
            
            if (!empty($activeSplits)) {
                $checks[] = 'Verify split-specific config for: ' . implode(', ', $activeSplits);
            }
            
            $summary = "Found " . $driftCount . " items drifting.";
            if (!empty($blockers)) {
                $summary = "INCOMPLETE: " . $blockers[0];
            }
            
            $result = [
                'summary' => $summary,
                'highest_risk_items' => $riskItems,
                'blockers' => $blockers,
                'suggested_checks' => $checks
            ];
            
            return Envelope::ok($summary, [$result], [], [
                'tool' => 'summarize_deployment_risk'
            ]);
        } catch (\Exception $e) {
            $errResult = [
                'summary' => 'Deployment Risk Analysis: FAILED. Error: ' . $e->getMessage(),
                'highest_risk_items' => [],
                'blockers' => [$e->getMessage()],
                'suggested_checks' => []
            ];
            return Envelope::ok("Deployment Risk Analysis: FAILED.", [$errResult], [], [
                'tool' => 'summarize_deployment_risk'
            ]);
        }
    }
}
