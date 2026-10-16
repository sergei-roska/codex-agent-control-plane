<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugEnvironmentSummary {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include PHP version, DB driver, and cache backend info")]
        ?bool $include_runtime_versions = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($include_runtime_versions !== null) $params['include_runtime_versions'] = $include_runtime_versions;

            $php = <<<'PHP'
$data = ['drupal_version' => \Drupal::VERSION, 'maintenance_mode' => \Drupal::state()->get('system.maintenance_mode') ? 'ON' : 'OFF'];
if (!empty($params['include_runtime_versions'])) {
    $data['php_version'] = PHP_VERSION;
    $data['db_driver'] = \Drupal::database()->driver();
    $data['cache_backend_default'] = get_class(\Drupal::cache());
}
return $data;
PHP;

            $res = $this->adapter->evaluate($php, $params);

            return Envelope::ok(
                "Drupal " . ($res['drupal_version'] ?? 'unknown') . " | Maintenance: " . ($res['maintenance_mode'] ?? 'unknown'),
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_environment_summary']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_environment_summary'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_environment_summary'
            ]);
        }
    }
}
