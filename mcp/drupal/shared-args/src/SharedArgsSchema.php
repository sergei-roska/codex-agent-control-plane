<?php

namespace DrupalMcp\SharedArgs;

class SharedArgsSchema {
    public static function merge(array $toolSpecific): array {
        return array_merge(self::base(), $toolSpecific);
    }

    private static function base(): array {
        return [
            'limit'           => ['type' => 'integer', 'default' => 50, 'description' => 'Maximum number of items to return in this page. Use with offset or cursor pagination when supported.'],
            'offset'          => ['type' => 'integer', 'description' => 'Number of matching items to skip before returning results; use for offset pagination.'],
            'sort'            => ['type' => 'string', 'description' => 'Response field to sort by. Use only a field supported by the tool.'],
            'sort_direction'  => ['type' => 'string', 'enum' => ['ASC', 'DESC'], 'default' => 'ASC', 'description' => 'Sort direction for the selected field: ASC or DESC.'],
            'query'           => ['type' => 'string', 'description' => 'Case-insensitive substring filter applied to supported name or label fields.'],
            'verbosity'       => ['type' => 'string', 'enum' => ['minimal','normal','diagnostic','raw'], 'default' => 'minimal', 'description' => 'Response detail: minimal for compact results, normal for standard data, diagnostic for troubleshooting, raw for unprocessed data.'],
            'summary_only'    => ['type' => 'boolean', 'default' => false, 'description' => 'Return counts and metadata without the matching item list.'],
            'exclude_noise'   => ['type' => 'boolean', 'default' => true, 'description' => 'Remove common Drupal boilerplate fields from each result when true.'],
            'max_chars'       => ['type' => 'integer', 'default' => 10000, 'description' => 'Maximum response size in characters; output is truncated when exceeded.'],
        ];
    }
}
