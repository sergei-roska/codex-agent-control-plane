import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path.cwd()
RUNTIME = ROOT / '.runtime'
EVIDENCE = ROOT / '.agents/teamwork/local-autonomy-20261028'
PROJECT = '3d9c2e759c'
BASE = 'http://127.0.0.1:8081'
TOKEN = (RUNTIME / 'a2a-token').read_text().strip()


def request(path, body=None, backend=False, timeout=5):
    url = ('http://127.0.0.1:3002' if backend else BASE) + path
    headers = {'Authorization': 'Bearer ' + TOKEN} if backend else {}
    payload = None
    if body is not None:
        payload = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers), timeout=timeout) as response:
        return json.load(response)


def wait_for(check, label, seconds=45):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.2)
    raise RuntimeError(label)


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name('.' + path.name + '.autonomy-' + str(os.getpid()))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def listener():
    values = subprocess.check_output(['lsof', '-ti', 'tcp:8081', '-sTCP:LISTEN'], text=True).split()
    if len(values) != 1:
        raise RuntimeError('Expected exactly one launcher listener')
    return int(values[0])


def start_stamp(pid):
    contents = Path(f'/proc/{pid}/stat').read_text()
    return contents[contents.rfind(')') + 2:].split()[19]


projects = request('/api/projects')['projects']
selected = next(project for project in projects if project['id'] == PROJECT)
if any(project['status'] != 'stopped' for project in projects if project['id'] != PROJECT):
    raise RuntimeError('Another project is active; refusing launcher restart')
if request('/control/pause', backend=True)['runs']:
    raise RuntimeError('Active runs present; refusing unscheduled restart')
state_file = Path(selected['stateDb'])
with sqlite3.connect('file:' + str(state_file) + '?mode=ro', uri=True) as database:
    before_tasks = database.execute("SELECT id,status_state FROM tasks WHERE owner='orchestrator' ORDER BY id").fetchall()
    unresolved = database.execute("SELECT count(*) FROM writer_executions WHERE state NOT IN ('released')").fetchone()[0]
    if unresolved:
        raise RuntimeError('Unreleased writer executions; refusing restart')

old_pid = listener()
old_stamp = start_stamp(old_pid)
proc = Path('/proc') / str(old_pid)
argv = [item.decode() for item in (proc / 'cmdline').read_bytes().split(b'\0') if item]
cwd = (proc / 'cwd').resolve()
node = str((proc / 'exe').resolve())
if cwd != ROOT or len(argv) != 2 or Path(argv[1]).name not in ['launcher', 'launcher.js']:
    raise RuntimeError('Unrecognized launcher invocation')
# Preserve the existing launcher environment in memory; never persist or print it.
environment = {}
for item in (proc / 'environ').read_bytes().split(b'\0'):
    key, separator, value = item.partition(b'=')
    if separator:
        environment[key.decode()] = value.decode()

stopped = request('/api/projects/' + PROJECT + '/stop', {}, timeout=25)
if stopped.get('success') is not True:
    raise RuntimeError('Project stop failed')
wait_for(lambda: request('/api/projects/' + PROJECT + '/status')['status'] == 'stopped', 'Project did not stop')

for project in projects:
    path = RUNTIME / 'projects' / project['id'] / 'project-settings.json'
    document = json.loads(path.read_text()) if path.exists() else {'version': 1}
    updated = {**document, 'executionPermissions': 'full-access', 'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    subprocess.run([node, '-e', "require('./src/project-settings').validateSettingsDocument(JSON.parse(process.argv[1]))", json.dumps(updated)], check=True, stdout=subprocess.DEVNULL)
    atomic_json(path, updated)
atomic_json(RUNTIME / 'launcher-settings.json', {'version': 1, 'defaultExecutionPermissions': 'full-access'})

if start_stamp(old_pid) != old_stamp:
    raise RuntimeError('Launcher process identity changed')
os.kill(old_pid, signal.SIGTERM)
wait_for(lambda: not Path(f'/proc/{old_pid}').exists(), 'Launcher did not terminate cleanly', seconds=20)
log_dir = RUNTIME / 'local-autonomy'
log_dir.mkdir(mode=0o700, exist_ok=True)
log_fd = os.open(log_dir / 'launcher.log', os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
try:
    new_launcher = subprocess.Popen([node, argv[1]], cwd=ROOT, env=environment, stdin=subprocess.DEVNULL, stdout=log_fd, stderr=subprocess.STDOUT, start_new_session=True)
finally:
    os.close(log_fd)
wait_for(lambda: request('/api/projects'), 'Updated launcher did not become ready', seconds=20)
if listener() != new_launcher.pid:
    raise RuntimeError('Unexpected launcher listener identity')
started = request('/api/projects/' + PROJECT + '/start', {}, timeout=45)
if started.get('success') is not True:
    raise RuntimeError('Updated project start failed')
status = wait_for(lambda: (lambda value: value if value['status'] == 'running' else False)(request('/api/projects/' + PROJECT + '/status')), 'Project did not become ready', seconds=60)
identity = request('/control/runtime', backend=True)
critical = ['src/project-settings.js', 'src/execution-permissions.js', 'src/codex-app-server.js', 'src/concurrent-delivery-engine.js', 'src/delivery-role-capabilities.js', 'src/delivery-acceptance.js', 'src/acceptance.js', 'src/lead-graph.js']
for name in critical:
    if identity['sourceHashes'].get(name) != hashlib.sha256((ROOT / name).read_bytes()).hexdigest():
        raise RuntimeError('Running source mismatch: ' + name)
with sqlite3.connect('file:' + str(state_file) + '?mode=ro', uri=True) as database:
    after_tasks = database.execute("SELECT id,status_state FROM tasks WHERE owner='orchestrator' ORDER BY id").fetchall()
if before_tasks != after_tasks:
    raise RuntimeError('Task state changed unexpectedly during policy application')
report = {'oldLauncherPid': old_pid, 'launcherPid': new_launcher.pid, 'projectPid': status['project']['pid'], 'projectId': PROJECT, 'engine': request('/api/projects/' + PROJECT + '/delivery-engine')['deliveryEngine'], 'executionPermissions': 'full-access', 'launcherDefault': 'full-access', 'registeredProjectsConfigured': len(projects), 'taskStatesPreserved': True, 'runningSourceVerified': critical, 'pausedRunResumed': False}
atomic_json(EVIDENCE / 'runtime-applied.json', report)
print(json.dumps(report))
