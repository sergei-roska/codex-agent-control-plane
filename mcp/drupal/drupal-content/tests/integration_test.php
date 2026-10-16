<?php

$serverScript = dirname(__DIR__) . '/bin/server.php';

// Setup pipes
$descriptors = [
    0 => ['pipe', 'r'], // stdin
    1 => ['pipe', 'w'], // stdout
    2 => ['pipe', 'w'], // stderr
];

$env = array_merge(getenv(), [
    'PROJECT_ROOT' => getenv('PROJECT_ROOT') ?: (dirname(dirname(__DIR__)) . '/dccourtscode'),
    'DRUPAL_ROOT' => getenv('DRUPAL_ROOT') ?: (dirname(dirname(__DIR__)) . '/dccourtscode/web'),
]);

$process = proc_open("php " . escapeshellarg($serverScript), $descriptors, $pipes, dirname(__DIR__), $env);

if (!is_resource($process)) {
    echo "[FAIL] Failed to launch server process.\n";
    exit(1);
}

// Make pipes non-blocking where appropriate
stream_set_blocking($pipes[1], true);
stream_set_blocking($pipes[2], false);

function sendRequest($pipe, array $request): void {
    $payload = json_encode($request) . "\n";
    fwrite($pipe, $payload);
}

function readLineWithTimeout($pipe, float $timeoutSeconds = 30.0): ?string {
    $read = [$pipe];
    $write = null;
    $except = null;
    $sec = (int)$timeoutSeconds;
    $usec = (int)(($timeoutSeconds - $sec) * 1000000);
    
    if (stream_select($read, $write, $except, $sec, $usec) > 0) {
        $line = fgets($pipe);
        return $line !== false ? rtrim($line, "\r\n") : null;
    }
    return null;
}

function callTool($stdin, $stdout, string $toolName, array $arguments, int $id): void {
    echo "Calling tool '$toolName' with arguments: " . json_encode($arguments) . "...\n";
    sendRequest($stdin, [
        'jsonrpc' => '2.0',
        'method' => 'tools/call',
        'id' => $id,
        'params' => [
            'name' => $toolName,
            'arguments' => $arguments
        ]
    ]);
    
    $line = readLineWithTimeout($stdout, 30.0); // 30s timeout for lando drush bootstrap
    if (!$line) {
        throw new \Exception("No response received for tool '$toolName'.");
    }
    
    $response = json_decode($line, true);
    if (isset($response['error'])) {
        throw new \Exception("Tool '$toolName' returned error: " . json_encode($response['error']));
    }
    
    if (!isset($response['result']['content'][0]['text'])) {
        throw new \Exception("Invalid tool response structure: " . $line);
    }
    
    $text = $response['result']['content'][0]['text'];
    $envelope = json_decode($text, true);
    
    if (!is_array($envelope)) {
        throw new \Exception("Tool response text is not a valid JSON array: " . $text);
    }
    
    if (!isset($envelope['ok'])) {
        throw new \Exception("Envelope is missing 'ok' status key. Got: " . $text);
    }
    
    if ($envelope['ok'] !== true) {
        throw new \Exception("Tool returned ok=false. Errors: " . json_encode($envelope['errors'] ?? []));
    }
    
    echo "  [PASS] Tool '$toolName' succeeded. Summary: " . ($envelope['summary'] ?? '') . "\n";
}

try {
    echo "Sending initialize request...\n";
    sendRequest($pipes[0], [
        'jsonrpc' => '2.0',
        'method' => 'initialize',
        'id' => 1,
        'params' => [
            'protocolVersion' => '2024-11-05',
            'capabilities' => (object)[],
            'clientInfo' => [
                'name' => 'integration-test-client',
                'version' => '1.0'
            ]
        ]
    ]);
    
    $responseLine = readLineWithTimeout($pipes[1]);
    if (!$responseLine) {
        $err = stream_get_contents($pipes[2]);
        throw new \Exception("No response received from server. Stderr: $err");
    }
    
    $response = json_decode($responseLine, true);
    if (!isset($response['result']) || $response['id'] !== 1) {
        throw new \Exception("Invalid initialize response format: " . $responseLine);
    }
    
    if (($response['result']['serverInfo']['name'] ?? '') !== 'drupal-content') {
        throw new \Exception("Server name is not 'drupal-content'. Got: " . json_encode($response['result']));
    }
    echo "  [PASS] Initialize handshake successful.\n";
    
    // Send initialized notification
    sendRequest($pipes[0], [
        'jsonrpc' => '2.0',
        'method' => 'notifications/initialized'
    ]);
    
    // Call each tool to verify it works on the real site
    $toolsToTest = [
        'inspect_content_types' => [],
        'inspect_media_types' => [],
        'inspect_taxonomy_models' => [],
        'inspect_field_usage' => ['entity_type_id' => 'node'],
        'inspect_reference_graph' => ['entity_type_id' => 'node'],
        'summarize_editorial_model' => ['entity_type_id' => 'node'],
        'inspect_display_modes' => ['entity_type_id' => 'node'],
        'inspect_revisioning' => ['entity_type_id' => 'node'],
        'inspect_translation' => ['entity_type_id' => 'node'],
        'inspect_moderation' => ['entity_type_id' => 'node'],
        'inspect_entity_types' => [],
        'inspect_bundles' => ['entity_type_id' => 'node'],
        'inspect_fields' => ['entity_type_id' => 'node'],
        'inspect_menus' => [],
        'inspect_vocabularies' => [],
        'inspect_permissions' => [],
    ];
    
    $reqId = 2;
    foreach ($toolsToTest as $toolName => $args) {
        callTool($pipes[0], $pipes[1], $toolName, $args, $reqId++);
    }
    
    echo "\nINTEGRATION TEST PASSED SUCCESSFULLY!\n";
    $exitCode = 0;
} catch (\Exception $e) {
    echo "\n[FAIL] Test failed: " . $e->getMessage() . "\n";
    $exitCode = 1;
} finally {
    // Terminate process
    fclose($pipes[0]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    proc_terminate($process);
    proc_close($process);
}

exit($exitCode);
