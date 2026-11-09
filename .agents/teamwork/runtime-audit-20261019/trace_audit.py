"""Summarize selected runtime rollout tool calls without retaining transcripts."""
import ast
import collections
import datetime as dt
import glob
import hashlib
import json
from pathlib import Path
import re
import sqlite3

ROOT = Path(__file__).parent
SNAPSHOT = '/tmp/harness-audit-20261019-jlcuqqwq/snapshot.sqlite'
CUTOFF = '2026-10-19T08:33:51.211293+00:00'
RUN = '9e2c8b53-458b-4ccf-924b-ee13639510df'
def instant(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))

c = sqlite3.connect('file:' + SNAPSHOT + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row
assignments = []
threads = collections.defaultdict(list)
for row in c.execute('SELECT * FROM dispatch_journal WHERE run_id=? ORDER BY created_at', (RUN,)):
    result = json.loads(row['result_json'] or '{}')
    tid = (result.get('continuation') or {}).get('threadId')
    item = {key: row[key] for key in ['assignment_id', 'role', 'created_at', 'updated_at']}
    item['threadId'] = tid
    task = c.execute('SELECT history FROM tasks WHERE id=?', (row['task_id'],)).fetchone()
    payload = None
    for message in json.loads(task['history'] or '[]') if task else []:
        if message.get('role') != 'ROLE_USER':
            continue
        text = '\n'.join(p.get('text', '') for p in message.get('parts', []))
        try:
            candidate = json.loads(text)
            if isinstance(candidate, dict) and 'objective' in candidate:
                payload = candidate
                break
        except (ValueError, TypeError):
            pass
    if payload:
        item['prompt'] = {
            'chars': len(json.dumps(payload)),
            'inputsCount': len(payload.get('inputs', [])),
            'evidenceCount': len(payload.get('evidence', [])),
            'allowedFilesCount': len(payload.get('allowedFiles', [])),
            'explicitPriorAssignmentReferences': sorted(set(re.findall(r':r\d+:a\d+(?::c\d+)?', json.dumps(payload)))),
            'continued': bool(payload.get('continuation')),
        }
    assignments.append(item)
    if tid:
        threads[tid].append(item)

files = glob.glob('/home/sr/.codex/sessions/2026/10/18/*.jsonl') + glob.glob('/home/sr/.codex/sessions/2026/10/19/*.jsonl')
commands = []
coverage = []
for filename in files:
    with open(filename) as stream:
        head = stream.readline()
        if not head:
            continue
        meta = json.loads(head).get('payload', {})
        tid = meta.get('id')
        known_worker = tid in threads
        possible_lead = meta.get('cwd') == '/home/sr/Projects/Workspace/claude-harness'
        if not known_worker and not possible_lead:
            continue
        is_lead = False
        events = []
        for line in stream:
            event = json.loads(line)
            if instant(event['timestamp']) > instant(CUTOFF):
                continue
            p = event.get('payload', {})
            if event.get('type') == 'response_item' and p.get('type') == 'message' and p.get('role') == 'developer':
                body = '\n'.join(x.get('text', '') for x in p.get('content', []))
                if 'You are the read-only lead of this A2A development team.' in body:
                    is_lead = True
            if event.get('type') == 'response_item' and p.get('type') in ['function_call', 'custom_tool_call']:
                events.append((event['timestamp'], p))
        if not known_worker and not is_lead:
            continue
        coverage.append({'threadId': tid, 'role': 'coordinator' if is_lead else threads[tid][0]['role'], 'path': filename, 'calls': len(events)})
        for timestamp, p in events:
            owner = None
            if known_worker:
                choices = [x for x in threads[tid] if instant(x['created_at']) <= instant(timestamp) <= instant(x['updated_at'])]
                if choices:
                    owner = choices[-1]
            role = 'coordinator' if is_lead else threads[tid][0]['role']
            raw = p.get('arguments', p.get('input', ''))
            if isinstance(raw, dict):
                raw = json.dumps(raw)
            shell = []
            if p.get('name', '').endswith('exec_command'):
                try:
                    shell.append(json.loads(raw).get('cmd', ''))
                except ValueError:
                    pass
            else:
                for match in re.finditer(r'\bcmd\s*:\s*("(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27)', raw):
                    try:
                        shell.append(ast.literal_eval(match[1]))
                    except (ValueError, SyntaxError):
                        pass
            for cmd in shell:
                normalized = re.sub(r'/home/sr/Projects/Workspace/codex-agent-control-plane/\.runtime/projects/c65886082e/lanes/[^/ ]+', '<workspace>', cmd)
                normalized = normalized.replace('/home/sr/Projects/Workspace/claude-harness', '<workspace>')
                # Preserve command identity, never command bodies or raw private text.
                digest = hashlib.sha256(normalized.encode()).hexdigest()
                verbs = sorted(set(re.findall(r'(?<![\w/])(rg|grep|find|ls|cat|sed|head|tail|pytest|git)\b', cmd)))
                paths = sorted(set(re.findall(r'(?<![\w/])(?:harness|tests|docs)/[A-Za-z0-9_./*-]+', cmd)))
                commands.append({'at': timestamp, 'role': role, 'assignment': owner['assignment_id'] if owner else None,
                                 'threadId': tid, 'sha256': digest, 'verbs': verbs, 'paths': paths,
                                 'repositoryInventory': bool(re.search(r'rg\s+--files\b|find\s+\.', cmd)),
                                 'commandChars': len(cmd)})

groups = collections.defaultdict(list)
for item in commands:
    if set(item['verbs']) & {'rg', 'grep', 'find', 'ls', 'cat', 'sed', 'head', 'tail'}:
        groups[item['sha256']].append(item)
duplicates = []
for digest, items in groups.items():
    roles = {i['role'] for i in items}
    if 'coordinator' in roles and len(roles) > 1:
        duplicates.append({'sha256': digest, 'occurrences': items})
by_role = {}
for role in sorted({i['role'] for i in commands}):
    items = [i for i in commands if i['role'] == role]
    by_role[role] = {'shellCommands': len(items), 'readSearchCommands': sum(bool(set(i['verbs']) & {'rg','grep','find','ls','cat','sed','head','tail'}) for i in items),
                     'repositoryInventories': sum(i['repositoryInventory'] for i in items)}
out = {'cutoff': CUTOFF, 'snapshot': SNAPSHOT, 'source': 'selected .codex rollout logs, timestamp bounded',
       'limitations': ['Only syntactically extracted shell command strings are counted; nested dynamic expressions may be missed.',
                       'Read/search commands can include other actions in the same shell string.',
                       'Repeated commands demonstrate repeated inspection, not necessarily avoidable work.',
                       'Rollout logs are temporary and are not copied into durable evidence.'],
       'assignmentCount': len(assignments), 'workerAssignmentsWithThread': sum(bool(i['threadId']) for i in assignments),
       'coverage': coverage, 'byRole': by_role, 'leadWorkerExactInspectionMatches': duplicates,
       'assignments': assignments, 'commands': commands}
(ROOT / 'traces.json').write_text(json.dumps(out, indent=2) + '\n')
print(json.dumps({k:out[k] for k in ['assignmentCount','workerAssignmentsWithThread','byRole']},indent=2))
print('covered threads:', len(coverage), 'lead-worker identical inspections:', len(duplicates))
