from pathlib import Path
import json, re, subprocess

root = Path.cwd()
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
new_docs = sorted(str(p) for p in Path('docs').glob('autonomous-delivery-*.md'))
assert len(new_docs) == 3, f'Expected backlog, migration and constraint documents, found {new_docs}'
files = changed + new_docs
checks = 0
for name in files:
    p = Path(name)
    content = p.read_text()
    if p.suffix == '.json':
        json.loads(content)
        checks += 1
    if p.suffix != '.md':
        continue
    # Verify the newly authored documentation and links introduced in existing files.
    if name in new_docs:
        assert content.isascii(), f'Non-ASCII in {name}'
        added = content
    else:
        diff = subprocess.check_output(['git', 'diff', '--', name], text=True)
        added = '\n'.join(line[1:] for line in diff.splitlines() if line.startswith('+') and not line.startswith('+++'))
        assert added.isascii(), f'Non-ASCII additions in {name}'
    if name in new_docs:
        for inline in re.findall(r'`((?:src|docs|launcher-ui|test)/[^`]+)`', content):
            relative = re.sub(r':[\d, -]+$', '', inline).split('#', 1)[0]
            if not any(x in relative for x in ('*', '<', '>', ' ', '..')):
                assert Path(relative).exists(), f'Missing inline source path: {name}: {relative}'
                checks += 1
    for target in re.findall(r'\]\(([^)]+)\)', added):
        if '://' in target or target.startswith('#'):
            continue
        relative = target.split('#', 1)[0]
        if relative:
            assert (p.parent / relative).exists(), f'Broken link: {name}: {target}'
            checks += 1

historical = ['docs/orchestrator-improvement-backlog.md', 'docs/dashboard-ideas-backlog.md', 'docs/architecture/concurrent-harness/implementation-plan.md']
for name in historical:
    before = subprocess.check_output(['git', 'show', f'HEAD:{name}'], text=True)
    after = Path(name).read_text()
    restored = re.sub(r'\n> Archived development plan, 2026-11-06[^\n]*\n', '', after, count=1)
    assert restored == before, f'Historical content changed: {name}'
    checks += 1
name = 'docs/architecture/concurrent-harness/implementation-backlog.json'
before = json.loads(subprocess.check_output(['git', 'show', f'HEAD:{name}'], text=True))
after = json.loads(Path(name).read_text())
for key, value in before.items():
    assert after[key] == value, f'Historical package data changed: {key}'
assert after['planningStatus'] == 'archived'
assert (Path(name).parent / after['currentBacklogRef']).exists()
checks += 1
name = 'docs/architecture/concurrent-harness/knowledge-graph.json'
before = json.loads(subprocess.check_output(['git', 'show', f'HEAD:{name}'], text=True))
after = json.loads(Path(name).read_text())
for key, value in before.items():
    if key == 'queries':
        for query, query_value in value.items():
            if query != 'readyPackages':
                assert after[key][query] == query_value
    else:
        assert after[key] == value, f'Historical graph data changed: {key}'
assert after['planningStatus'] == 'historical_snapshot'
checks += 1
subprocess.run(['git', 'diff', '--check'], check=True)
print(f'PASS: {checks} document/link/archive checks; ASCII additions; JSON parse; git diff --check')
