import datetime
import hashlib
import json
import pathlib
import re

root = pathlib.Path.cwd()
base = root / 'docs/architecture/concurrent-harness'
path = base / 'knowledge-graph.json'
graph = json.loads(path.read_text())
backlog = json.loads((base / 'implementation-backlog.json').read_text())
packages = {item['id']: item for item in backlog['packages']}
nodes = {node['id']: node for node in graph['nodes']}
concurrent_files = {
    'backlog-store', 'candidate-review', 'candidate-store', 'delivery-contracts',
    'delivery-events', 'delivery-inbox', 'delivery-review-policy', 'lead-planner',
    'project-delivery-controller', 'task-executor', 'task-resource-policy',
    'task-scheduler', 'delivery-lifecycle', 'delivery-acceptance',
    'delivery-visibility',
}
for package_id, package in packages.items():
    node = nodes['package:' + package_id]
    node['status'] = package['status']

files = list((root / 'src').glob('*.js')) + list((root / 'test').glob('*.test.js'))
files += [p for p in (root / 'launcher-ui').iterdir() if p.suffix in {'.js', '.css', '.html'}]
for file in files:
    relative = file.relative_to(root).as_posix()
    identity = 'file:' + relative
    node = nodes.get(identity, {'id': identity})
    node.update(type='test' if relative.startswith('test/') else 'ui' if relative.startswith('launcher-ui/') else 'module', path=relative,
                sha256=hashlib.sha256(file.read_bytes()).hexdigest(), lines=len(file.read_text().splitlines()))
    node.setdefault('subsystem', 'tests' if relative.startswith('test/') else 'ui' if relative.startswith('launcher-ui/') else 'concurrent_runtime' if file.stem in concurrent_files else 'runtime')
    nodes[identity] = node

edges = [edge for edge in graph['edges'] if edge['type'] not in {'imports', 'tests_import'}]
seen = {(edge['from'], edge['to'], edge['type']) for edge in edges}
for node in list(nodes.values()):
    if 'path' not in node:
        continue
    file = root / node['path']
    if not file.is_file():
        continue
    node['sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
    node['lines'] = len(file.read_text().splitlines())
    subsystem = 'subsystem:' + node.get('subsystem', '')
    if subsystem in nodes and (node['id'], subsystem, 'belongs_to') not in seen:
        edges.append({'from': node['id'], 'to': subsystem, 'type': 'belongs_to'})
        seen.add((node['id'], subsystem, 'belongs_to'))
    if file.suffix != '.js':
        continue
    for match in re.finditer(r"require\(['\"](\.[^'\"]+)['\"]\)", file.read_text()):
        target = (file.parent / match.group(1)).resolve()
        if target.suffix != '.js':
            target = pathlib.Path(str(target) + '.js')
        try:
            target_id = 'file:' + target.relative_to(root).as_posix()
        except ValueError:
            continue
        kind = 'tests_import' if node['type'] == 'test' else 'imports'
        key = (node['id'], target_id, kind)
        if target_id in nodes and key not in seen:
            edges.append({'from': node['id'], 'to': target_id, 'type': kind,
                          'evidence': {'path': node['path'], 'line': file.read_text()[:match.start()].count('\n') + 1}})
            seen.add(key)

graph['capturedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
graph['basis'] = 'Current working tree and package status; source gates are distinct from inactive runtime'
graph['nodes'] = sorted(nodes.values(), key=lambda item: item['id'])
graph['edges'] = sorted(edges, key=lambda item: (item['from'], item['to'], item['type']))
assert all(edge['from'] in nodes and edge['to'] in nodes for edge in edges)
assert all('file:' + p.relative_to(root).as_posix() in nodes for p in (root / 'src').glob('*.js'))
path.write_text(json.dumps(graph, indent=2) + '\n')
print(json.dumps({'nodes': len(nodes), 'edges': len(edges), 'sourceModules': len(list((root / 'src').glob('*.js')))}))
