<?php

namespace DrupalMcp\DbOps\Support;

class Envelope {
    public static function ok(string $summary, array $data = [], array $counts = [], array $meta = []): array {
        return [
            'ok'     => true,
            'summary' => $summary,
            'data'   => $data,
            'counts' => array_merge([
                'returned'  => count($data),
                'total'     => count($data),
                'truncated' => false
            ], $counts),
            'meta'   => array_merge([
                'server'    => 'drupal-db-ops',
                'tool'      => 'unknown',
                'execution' => 'pdo',
                'elapsed_ms' => 0
            ], $meta),
            'errors' => []
        ];
    }

    public static function error(string $code, string $message, string $hint, array $meta = []): array {
        return [
            'ok'      => false,
            'summary' => $message,
            'data'    => [],
            'counts'  => [
                'returned'  => 0,
                'total'     => 0,
                'truncated' => false
            ],
            'meta'    => array_merge([
                'server'    => 'drupal-db-ops',
                'tool'      => 'unknown',
                'execution' => 'pdo',
                'elapsed_ms' => 0
            ], $meta),
            'errors'  => [
                [
                    'code'    => $code,
                    'message' => $message,
                    'hint'    => $hint
                ]
            ]
        ];
    }

    public static function safeTranslate(string $message, mixed $variables): string {
        if (!is_array($variables)) {
            return $message;
        }
        $safeVars = [];
        foreach ($variables as $k => $v) {
            if (is_scalar($v)) {
                $safeVars[$k] = (string) $v;
            } elseif (is_null($v)) {
                $safeVars[$k] = '';
            } elseif (is_object($v)) {
                if ($v instanceof \__PHP_Incomplete_Class) {
                    $safeVars[$k] = json_encode((array) $v);
                } elseif (method_exists($v, '__toString')) {
                    $safeVars[$k] = (string) $v;
                } else {
                    $safeVars[$k] = json_encode((array) $v);
                }
            } else {
                $safeVars[$k] = json_encode($v);
            }
        }
        return strip_tags(strtr($message, $safeVars));
    }
}
