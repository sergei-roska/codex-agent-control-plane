import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path.cwd()
evidence = root / '.agents/teamwork/engine-integration-20261027'
mode = sys.argv[1] if len(sys.argv) > 1 else 'full'
assert mode in {'full', 'affected'}
if mode == 'full':
    files = sorted(str(path.relative_to(root)) for path in (root / 'test').glob('*.test.js'))
else:
    names = ['backlog-store', 'candidate-store', 'candidate-review', 'delivery-contracts',
             'delivery-events', 'delivery-inbox', 'delivery-lifecycle', 'delivery-review-policy',
             'delivery-acceptance', 'delivery-acceptance-join', 'delivery-role-capabilities',
             'delivery-verifier-integration', 'delivery-output-artifacts', 'delivery-visibility',
             'lead-planner', 'project-delivery-controller', 'task-executor', 'task-resource-policy',
             'task-scheduler', 'acceptance', 'acceptance-scratch', 'workspace-snapshot',
             'launcher-backlog-ui']
    names += ['delivery-role-service', 'app-server-switch', 'project-settings', 'delivery-engine-router', 'concurrent-delivery-engine', 'server-delivery-engine']
    files = [f'test/{name}.test.js' for name in names if (root / f'test/{name}.test.js').is_file()]
    assert all((root / name).is_file() for name in files)
source_paths = sorted(set(subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
                         + subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()))
def fingerprints():
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in source_paths if (root / name).is_file()}
before = fingerprints()
command = ['node', '--test', '--test-reporter=tap',
           '--test-skip-pattern=candidate attributes and inherited Git configuration cannot execute filters while mirroring', *files]
env = dict(os.environ)
env.pop('NODE_TEST_CONTEXT', None)
log = evidence / f'verification-{mode}.tap'
with log.open('w') as output:
    result = subprocess.run(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
text = log.read_text()
summary = {key: int(value) for key, value in re.findall(r'^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$', text, re.M)}
failures = re.findall(r'^\s*not ok \d+ - (.+)$', text, re.M)
after = fingerprints()
report = {'command': command, 'exitCode': result.returncode, 'summary': summary, 'failures': failures,
          'log': str(log.relative_to(root)), 'inputDrift': [name for name in before if before[name] != after.get(name)],
          'inputs': before}
(evidence / f'verification-{mode}.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key not in {'inputs', 'command'}}))
sys.exit(result.returncode)
