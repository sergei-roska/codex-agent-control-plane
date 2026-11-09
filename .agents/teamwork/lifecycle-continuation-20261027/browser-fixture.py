import http.server
import json
import pathlib
import re
import subprocess
import tempfile
import threading
import time

root = pathlib.Path.cwd()
output = root / '.agents/teamwork/lifecycle-continuation-20261027/browser'
output.mkdir(parents=True, exist_ok=True)
objective = {'objectiveId': 'delivery-demo', 'sessionId': 'session-demo', 'disposition': 'executing'}
projection = {'available': True, 'objective': objective, 'counts': {'ready': 2, 'blocked': 1, 'active': 3, 'unknown': 1},
    'capacity': {'projectActive': 4, 'objectiveActive': 3, 'configuredWorkerLimit': 11, 'effectiveRuntimeLimit': None,
                 'byRole': {'engineer': {'active': 3, 'configuredLimit': 4}, 'verifier': {'active': 1, 'configuredLimit': 2}, 'auditor': {'active': 0, 'configuredLimit': 2}}},
    'planner': {'available': True, 'scope': 'session', 'sessionId': 'session-demo', 'inFlight': True},
    'inbox': {'available': True, 'wakeup': True},
    'idleReasons': {'known': [{'reason': 'dependency', 'detail': 'Final audit waits for verifier evidence from the frozen candidate.'}],
                    'unknown': [{'reason': 'effective_runtime_capacity_unknown', 'detail': 'The active scheduler limit is not exposed.'}]},
    'tasks': [{'taskId': 'CN-demo-engineer-1', 'title': 'Implement dependency scheduler', 'state': 'running', 'role': 'engineer', 'readiness': 'active', 'attempts': [{'attemptId': 'attempt-demo-1', 'state': 'running', 'contextId': 'context-demo-1', 'selectedSettingsKnown': True}]},
              {'taskId': 'CN-demo-auditor-1', 'title': 'Audit frozen candidate', 'state': 'queued', 'role': 'auditor', 'readiness': 'unknown', 'dependencyReasons': [{'predecessorId': 'verify-final', 'state': 'unknown', 'detail': 'Waiting for verifier receipt.'}], 'attempts': []}],
    'nextCursor': 'fixture-next-page'}
diagnostic = '''<script>setTimeout(()=>{const p=document.createElement('script');p.id='visual-evidence';p.type='application/json';p.textContent=JSON.stringify({color:getComputedStyle(document.querySelector('main')).color,background:getComputedStyle(document.body).backgroundColor,headerBackground:getComputedStyle(document.querySelector('th')).backgroundColor,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,status:document.querySelector('#backlogStatus').textContent,rows:document.querySelectorAll('#backlogRows tr').length});document.body.appendChild(p)},1000)</script>'''
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        route = self.path.split('?')[0]
        if route.endswith('/delivery/objectives'):
            body = json.dumps({'available': True, 'objectives': [objective]}).encode(); mime='application/json'
        elif route.endswith('/delivery/backlog'):
            body=json.dumps(projection).encode(); mime='application/json'
        elif route.startswith('/ui/') and '/' not in route[4:]:
            file=root/'launcher-ui'/route[4:]
            if not file.is_file(): self.send_error(404); return
            body=file.read_bytes(); mime='text/css' if file.suffix=='.css' else 'text/javascript' if file.suffix=='.js' else 'text/html'
            if file.suffix=='.html': body=body.replace(b'</body>', diagnostic.encode()+b'</body>')
        else: self.send_error(404); return
        self.send_response(200); self.send_header('Content-Type',mime); self.end_headers(); self.wfile.write(body)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    for name, width, height in [('desktop',1440,1100),('mobile',390,844)]:
        with tempfile.TemporaryDirectory(prefix='cn13-chrome-') as profile:
            cmd=['google-chrome','--headless','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',f'--user-data-dir={profile}','--remote-debugging-port=0','about:blank']
            browser=subprocess.Popen(cmd,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            try:
                port_file=pathlib.Path(profile)/'DevToolsActivePort'
                for attempt in range(50):
                    if port_file.is_file(): break
                    time.sleep(.1)
                port=port_file.read_text().splitlines()[0]
                run=subprocess.run(['node',str(output.parent/'browser-cdp.cjs'),f'http://127.0.0.1:{port}',f'http://127.0.0.1:{server.server_port}/ui/backlog.html?project=abcdef1234&session=session-demo',str(output/name),str(width),str(height)],capture_output=True,text=True,timeout=20)
                print(name,run.stdout.strip() or run.stderr[-800:])
                if run.returncode: raise RuntimeError('Browser probe failed')
            finally:
                browser.terminate()
                try: browser.wait(timeout=5)
                except subprocess.TimeoutExpired: browser.kill(); browser.wait()

finally: server.shutdown(); server.server_close()
