<?php

namespace DrupalMcp\DbOps\Tools;

use DrupalMcp\DbOps\Adapter\PdoAdapter;
use DrupalMcp\DbOps\Adapter\AdapterException;
use DrupalMcp\DbOps\Support\Envelope;
use Mcp\Attribute\Schema;
use Mcp\Server\RequestContext;

/**
 * SQL-only implementation: queries the `watchdog` table directly via PDO.
 * No Drupal container required.
 */
class DebugWatchdog {
    private PdoAdapter $adapter;

    public function __construct(PdoAdapter $adapter) {
        $this->adapter = $adapter;
    }

    public function execute(
        #[Schema(description: "Specific log entry ID (WID).")]
        ?int $wid = null,
        #[Schema(description: "Filter by severity (0=Emergency..7=Debug).")]
        ?string $severity = null,
        #[Schema(description: "Filter by log type/channel.")]
        ?string $type = null,
        #[Schema(description: "Substring search for message text.")]
        ?string $query = null,
        #[Schema(description: "Filter entries since datetime (e.g., -1 hour, 2026-01-01).")]
        ?string $since = null,
        #[Schema(description: "Filter entries until datetime.")]
        ?string $until = null,
        #[Schema(description: "Filter by user ID.")]
        ?int $uid = null,
        #[Schema(description: "Max entries to return.")]
        ?int $limit = 50,
        ?RequestContext $context = null
    ): array {
        $this->adapter->setRequestContext($context);

        try {
            $pdo   = $this->adapter->getPdo();
            $table = $this->adapter->table('watchdog');

            $sql    = "SELECT wid, uid, type, message, variables, severity, link, location, hostname, timestamp FROM $table WHERE 1=1";
            $params = [];

            if ($wid !== null) {
                $sql .= " AND wid = :wid";
                $params[':wid'] = $wid;
            }
            if ($severity !== null) {
                $sql .= " AND severity = :severity";
                $params[':severity'] = (int) $severity;
            }
            if ($type !== null) {
                $sql .= " AND type = :type";
                $params[':type'] = $type;
            }
            if ($query !== null) {
                $sql .= " AND message LIKE :query";
                $params[':query'] = '%' . $query . '%';
            }
            if ($since !== null) {
                $ts = strtotime($since);
                if ($ts !== false) {
                    $sql .= " AND timestamp >= :since";
                    $params[':since'] = $ts;
                }
            }
            if ($until !== null) {
                $ts = strtotime($until);
                if ($ts !== false) {
                    $sql .= " AND timestamp <= :until";
                    $params[':until'] = $ts;
                }
            }
            if ($uid !== null) {
                $sql .= " AND uid = :uid";
                $params[':uid'] = $uid;
            }

            $limitVal = max(1, min(500, $limit ?? 50));
            $sql .= " ORDER BY wid DESC LIMIT $limitVal";

            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            $rows = $stmt->fetchAll();

            $items = [];
            foreach ($rows as $row) {
                $vars    = @unserialize((string) $row->variables);
                $message = Envelope::safeTranslate((string) $row->message, $vars);
                $items[] = [
                    'event_id'  => (int)   $row->wid,
                    'timestamp' => date('Y-m-d\TH:i:sP', (int) $row->timestamp),
                    'severity'  => (int)   $row->severity,
                    'type'      => (string) $row->type,
                    'message'   => $message,
                ];
            }

            return Envelope::ok(
                "Found " . count($items) . " watchdog entries.",
                $items,
                ['returned' => count($items), 'total' => count($items)],
                ['tool' => 'debug_watchdog']
            );
        } catch (AdapterException $e) {
            return Envelope::error('DB_CONNECTION_FAILED', $e->getMessage(), 'Verify PROJECT_ROOT and settings.php are correct', [
                'tool' => 'debug_watchdog'
            ]);
        } catch (\Exception $e) {
            return Envelope::error('UNEXPECTED_ERROR', $e->getMessage(), 'Check server logs for details', [
                'tool' => 'debug_watchdog'
            ]);
        }
    }
}
