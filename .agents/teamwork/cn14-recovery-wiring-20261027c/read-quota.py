import subprocess
import os
import json
import select
import time
from pathlib import Path

profile = '/home/sr/codex-work'
process = subprocess.Popen(['codex', 'app-server'], env={**os.environ, 'CODEX_HOME': profile},
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

def request(request_id, method, params):
    process.stdin.write(json.dumps({'id': request_id, 'method': method, 'params': params}) + '\n')
    process.stdin.flush()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if select.select([process.stdout], [], [], 1)[0]:
            line = process.stdout.readline()
            if not line:
                raise RuntimeError('App Server closed before quota response')
            row = json.loads(line)
            if row.get('id') == request_id:
                if 'error' in row:
                    raise RuntimeError('Quota RPC failed')
                return row['result']
    raise TimeoutError(method)

try:
    request(1, 'initialize', {'clientInfo': {'name': 'quota_read', 'version': '1.0.0'}})
    limits = request(2, 'account/rateLimits/read', {})['rateLimits']
    report = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'profile': profile,
        'primary': limits['primary'], 'secondary': limits['secondary']}
    Path(__file__).with_name('quota-last.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
