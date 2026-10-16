<?php

namespace DrupalMcp\Config\Support;

class Envelope {
    public static function ok(string $summary, array $data = [], array $counts = [], array $meta = []): array {
        return [
            'ok' => true,
            'summary' => $summary,
            'data' => $data,
            'counts' => array_merge([
                'returned' => count($data),
                'total' => count($data),
                'truncated' => false
            ], $counts),
            'meta' => array_merge([
                'server' => 'drupal-config',
                'tool' => 'unknown',
                'execution' => 'drush',
                'elapsed_ms' => 0
            ], $meta),
            'errors' => []
        ];
    }

    public static function error(string $code, string $message, string $hint, array $meta = []): array {
        return [
            'ok' => false,
            'summary' => $message,
            'data' => [],
            'counts' => [
                'returned' => 0,
                'total' => 0,
                'truncated' => false
            ],
            'meta' => array_merge([
                'server' => 'drupal-config',
                'tool' => 'unknown',
                'execution' => 'drush',
                'elapsed_ms' => 0
            ], $meta),
            'errors' => [
                [
                    'code' => $code,
                    'message' => $message,
                    'hint' => $hint
                ]
            ]
        ];
    }
}
