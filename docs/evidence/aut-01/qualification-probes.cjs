'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const repo = '/home/sr/Projects/Workspace/codex-agent-control-plane';
const fixture = path.join(repo, 'test/fixtures/spec-kit/pilot-price');
const profiles = path.join(repo, 'profiles');
const cli = path.join(repo, 'tools/spec-kit/analyze.js');
const analyzer = require(path.join(repo, 'src/spec-analyzer.js'));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function setup(){ const root=fs.mkdtempSync(path.join(os.tmpdir(),'aut01-final-probe-'));fs.cpSync(fixture,root,{recursive:true});return root; }
function read(root,p){return JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));}
function write(root,p,v){fs.writeFileSync(path.join(root,p),JSON.stringify(v,null,2)+'\n');}
function run(root){const accepted=read(root,'context/accepted-context.json');const args=[cli,'--workspace',root,'--context',accepted.contextPath,'--context-sha256',accepted.contextSha256,'--map','specs/pilot-price/traceability.json','--profiles',profiles,'--json'];const p=spawnSync(process.execPath,args,{encoding:'utf8'});if(p.error)throw p.error;const report=JSON.parse(p.stdout);return {exit:p.status,verdict:report.verdict,codes:report.findings.map(x=>x.code),fingerprint:report.analysisFingerprint};}
function rebindContext(root,fn){const p='context/pilot-context.json';const c=read(root,p);fn(c);write(root,p,c);const a=read(root,'context/accepted-context.json');a.contextSha256=hash(fs.readFileSync(path.join(root,p)));write(root,'context/accepted-context.json',a);const m=read(root,'specs/pilot-price/traceability.json');m.contextSha256=a.contextSha256;write(root,'specs/pilot-price/traceability.json',m);}
function mapCase(name,fn){const root=setup();try{const p='specs/pilot-price/traceability.json';const m=read(root,p);fn(m);write(root,p,m);console.log(JSON.stringify({name,...run(root)}));}finally{fs.rmSync(root,{recursive:true,force:true});}}
function contextCase(name,fn){const root=setup();try{rebindContext(root,fn);console.log(JSON.stringify({name,...run(root)}));}finally{fs.rmSync(root,{recursive:true,force:true});}}
mapCase('Q21 missing objective',m=>{delete m.tasks[0].objective;});
mapCase('Q21 incomplete review reason',m=>{delete m.tasks[0].reviewReason;});
mapCase('Q21 empty stops',m=>{m.tasks[0].stopConditions=[];});
contextCase('Q21 absent verifier paths',c=>{c.checks[0].verifierWritePaths=[];});
contextCase('Q21 outside verifier paths',c=>{c.checks[0].verifierWritePaths=[{kind:'file',path:'product/test/price.test.js'}];});
mapCase('Q23 too many items',m=>{m.tasks[0].stopConditions=Array.from({length:21},(_,i)=>`stop ${i}`);});
contextCase('Q25 boolean number',c=>{c.checks[0].timeoutMs=true;});
{
 const root=setup();const p=path.join(root,'canonical/GOAL.txt');const open=fs.openSync;let n=0;
 try{fs.openSync=function(file,...args){if(path.resolve(String(file))===p){n++;if(n===3)fs.unlinkSync(p);}return open.call(fs,file,...args);};const a=read(root,'context/accepted-context.json');const report=analyzer.analyzeWorkspace({workspaceRoot:root,contextPath:a.contextPath,contextSha256:a.contextSha256,mapPath:'specs/pilot-price/traceability.json',profilesDir:profiles});console.log(JSON.stringify({name:'Q24 disappeared input',opens:n,verdict:report.verdict,codes:report.findings.map(x=>x.code),fingerprint:report.analysisFingerprint}));}finally{fs.openSync=open;fs.rmSync(root,{recursive:true,force:true});}
}
for(const field of ['requirements','acceptanceCriteria','checks','priorEvidence']) contextCase(`Q05 duplicate ${field}`,c=>{c[field].push(structuredClone(c[field][0]));});
for(const bad of ['a/../b','/absolute','product/src/*.js','product//src/price.js']) mapCase(`Q07 unsafe ${bad}`,m=>{m.tasks[0].writePaths=[{kind:'file',path:bad}];});
for(const field of ['workspaceRoot','writeScope','contextPath']) mapCase(`Q20 injected ${field}`,m=>{m[field]=field==='writeScope'?{allow:[]}:field==='workspaceRoot'?'/tmp':'context/attacker.json';});
for(const role of ['spec','plan','tasks']){const root=setup();try{const m=read(root,'specs/pilot-price/traceability.json');fs.appendFileSync(path.join(root,m.artifactBindings.find(b=>b.role===role).path),'\nchanged');console.log(JSON.stringify({name:`Q18 changed ${role}`,...run(root)}));}finally{fs.rmSync(root,{recursive:true,force:true});}}
