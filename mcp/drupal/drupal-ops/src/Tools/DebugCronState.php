<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugCronState {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Include recent cron run log entries")]
        ?bool $include_recent_runs = false,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $php = <<<'PHP'
$last_run = \Drupal::state()->get('system.cron_last');
$now = time();
$status = 'OK';
if (!$last_run) { $status = 'NEVER_RUN'; }
elseif ($now - $last_run > 86400) { $status = 'STALE_OVER_24H'; }
$data = ['last_run' => $last_run ? date('Y-m-d\TH:i:sP', $last_run) : null, 'status' => $status];
$lock = \Drupal::lock();
$could_acquire = $lock->acquire('cron', 0.0);
$data['is_running'] = !$could_acquire;
if ($could_acquire) $lock->release('cron');
return $data;
PHP;

            $res = $this->adapter->evaluate($php);

            return Envelope::ok(
                "Cron status: " . ($res['status'] ?? 'unknown'),
                [$res],
                ['returned' => 1, 'total' => 1],
                ['tool' => 'debug_cron_state']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_cron_state'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_cron_state'
            ]);
        }
    }
}
