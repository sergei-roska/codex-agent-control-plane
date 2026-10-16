<?php

namespace DrupalMcp\Ops\Tools;

use DrupalMcp\Ops\Adapter\DrushAdapter;
use DrupalMcp\Ops\Adapter\AdapterException;
use DrupalMcp\Ops\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

class DebugWatchdog {
    private DrushAdapter $adapter;

    public function __construct(DrushAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Specific watchdog entry ID to retrieve")]
        ?int $wid = null,
        #[Schema(description: "Filter by severity level (0=Emergency, 1=Alert, 2=Critical, 3=Error, 4=Warning, 5=Notice, 6=Info, 7=Debug)")]
        ?string $severity = null,
        #[Schema(description: "Filter by log type/channel")]
        ?string $type = null,
        #[Schema(description: "Search string in message text")]
        ?string $query = null,
        #[Schema(description: "Return entries since this datetime (e.g. 2026-01-01 or -1 hour)")]
        ?string $since = null,
        #[Schema(description: "Return entries until this datetime")]
        ?string $until = null,
        #[Schema(description: "Filter by request ID")]
        ?string $request_id = null,
        #[Schema(description: "Filter by user ID")]
        ?int $uid = null,
        #[Schema(description: "Maximum number of entries to return")]
        ?int $limit = 50,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $params = [];
            if ($wid !== null) $params['wid'] = $wid;
            if ($severity !== null) $params['severity'] = $severity;
            if ($type !== null) $params['type'] = $type;
            if ($query !== null) $params['query'] = $query;
            if ($since !== null) $params['since'] = $since;
            if ($until !== null) $params['until'] = $until;
            if ($request_id !== null) $params['request_id'] = $request_id;
            if ($uid !== null) $params['uid'] = $uid;
            $params['limit'] = $limit ?? 50;

            $php = <<<'PHP'
$query = \Drupal::database()->select('watchdog', 'w')
  ->fields('w', ['wid', 'uid', 'type', 'message', 'variables', 'severity', 'link', 'location', 'referer', 'hostname', 'timestamp']);
if (isset($params['wid'])) $query->condition('wid', $params['wid']);
if (!empty($params['severity'])) $query->condition('severity', $params['severity']);
if (!empty($params['type'])) $query->condition('type', $params['type']);
if (!empty($params['query'])) $query->condition('message', '%' . \Drupal::database()->escapeLike($params['query']) . '%', 'LIKE');
if (!empty($params['since'])) { $since = strtotime($params['since']); if ($since !== false) $query->condition('timestamp', $since, '>='); }
if (!empty($params['until'])) { $until = strtotime($params['until']); if ($until !== false) $query->condition('timestamp', $until, '<='); }
if (isset($params['uid'])) $query->condition('uid', $params['uid']);
$query->orderBy('wid', 'DESC');
$query->range(0, (int)($params['limit'] ?? 50));
$results = [];
try {
    $records = $query->execute();
    foreach ($records as $row) {
        $vars = @unserialize($row->variables);
        $message = $row->message;
        if (is_array($vars)) $message = strip_tags(strtr($message, $vars));
        $results[] = ['event_id' => (int)$row->wid, 'timestamp' => date('Y-m-d\TH:i:sP', $row->timestamp), 'severity' => (int)$row->severity, 'type' => (string)$row->type, 'message' => $message];
    }
} catch (\Exception $e) { return ['error' => 'watchdog query failed', 'details' => $e->getMessage()]; }
return $results;
PHP;

            $res = $this->adapter->evaluate($php, $params);
            $items = is_array($res) && !isset($res['error']) ? $res : [];

            return Envelope::ok(
                "Found " . count($items) . " watchdog entries.",
                $items,
                ['returned' => count($items), 'total' => count($items)],
                ['tool' => 'debug_watchdog']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DRUPAL_BOOTSTRAP_FAILED', $e->getMessage(), 'Make sure your local site is running and bootstrapped', [
                'tool' => 'debug_watchdog'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_watchdog'
            ]);
        }
    }
}
