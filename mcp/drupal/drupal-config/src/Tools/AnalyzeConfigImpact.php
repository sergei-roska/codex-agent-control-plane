<?php

namespace DrupalMcp\Config\Tools;

use DrupalMcp\Config\Adapter\DrushAdapter;
use DrupalMcp\Config\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class AnalyzeConfigImpact {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Name of the configuration object to analyze.")]
        string $config_name,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $diffTool = new DiffActiveVsSync($this->adapter);
            $diffRes = $diffTool->execute($config_name);
            $diffData = $diffRes['ok'] && !empty($diffRes['data']) ? $diffRes['data'][0] : [];
            
            $depsTool = new TraceConfigDependencies($this->adapter);
            $depsRes = $depsTool->execute($config_name, 1, 'required_by');
            $depsData = $depsRes['ok'] && !empty($depsRes['data']) ? $depsRes['data'][0] : [];
            
            $status = $diffData['status'] ?? 'unknown';
            $riskLevel = $diffData['risk_level'] ?? 'medium';
            $dependents = $depsData['required_by'] ?? [];
            
            $touchedDomains = [];
            if (str_starts_with($config_name, 'field.')) {
                $touchedDomains[] = 'data_schema';
            }
            if (str_starts_with($config_name, 'views.view.')) {
                $touchedDomains[] = 'ui_display';
            }
            if (str_starts_with($config_name, 'core.extension')) {
                $touchedDomains[] = 'module_lifecycle';
            }
            
            $followups = [];
            if ($riskLevel === 'high') {
                $followups[] = 'Manual database backup verification recommended';
            }
            if (count($dependents) > 0) {
                $followups[] = 'Verify dependent objects: ' . implode(', ', array_slice($dependents, 0, 3)) . '...';
            }
            
            $result = [
                'target' => $config_name,
                'impact_summary' => "Deployment of " . $config_name . " is " . $status . ". It has " . count($dependents) . " dependents.",
                'touched_domains' => $touchedDomains,
                'risk_level' => $riskLevel,
                'required_followups' => $followups
            ];
            
            return Envelope::ok("Impact analysis for " . $config_name . ". Risk: " . $riskLevel . ".", [$result], [], [
                'tool' => 'analyze_config_impact'
            ]);
        } catch (\Exception $e) {
            $errResult = [
                'target' => $config_name,
                'error' => $e->getMessage()
            ];
            return Envelope::ok("Error analyzing impact.", [$errResult], [], [
                'tool' => 'analyze_config_impact'
            ]);
        }
    }
}
