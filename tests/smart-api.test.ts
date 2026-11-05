import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { guiCommand } from '../apps/cli/src/gui.js';
import { run } from '../apps/cli/src/index.js';
import { fixture, manifest } from './helpers.js';

test('real loopback GUI API persists compound rules with CAS and forwards content, rename and skip options',async(t)=>{
  const root=await fixture(t,{'work/물리.txt':'Physics velocity momentum kinetic energy.','work/other.txt':'other','state/':''});
  const controller=new AbortController();let ready!:(url:string)=>void;const listening=new Promise<string>((resolve)=>{ready=resolve;});
  const ended=guiCommand(undefined,{'no-open':true},{stateDir:()=>path.join(root,'state'),signal:controller.signal,warn:()=>{},onListening:ready});
  t.after(async()=>{controller.abort();await ended;});
  const url=new URL(await listening);const token=new URLSearchParams(url.hash.slice(1)).get('token')!;
  const post=async(route:string,body:unknown,authenticated=true)=>{
    const response=await fetch(new URL(route,url.origin),{method:'POST',headers:{'content-type':'application/json',...(authenticated?{'x-afo-token':token}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  };
  const rule={name:'물리',enabled:true,match:'all',priority:10,targetDirectory:'수업/물리',conditions:[{field:'name',operator:'contains',value:'물리'},{field:'extension',operator:'equals',value:'.txt'}]};
  assert.equal((await post('/api/rules/complex',{rule,expectedRevision:null},false)).status,403);
  const saved=await post('/api/rules/complex',{rule,expectedRevision:null});assert.equal(saved.status,200);
  const stored=JSON.parse(await readFile(path.join(root,'state/profiles/active.json'),'utf8'));assert.equal(stored.profile.complexRules[0].name,'물리');
  const stale=await post('/api/rules/complex',{rule:{...rule,targetDirectory:'덮어쓰지않음'},expectedRevision:null});assert.equal(stale.status,422);assert.equal(stale.body.error.code,'PROFILE_CHANGED');
  const work=path.join(root,'work');const before=await manifest(work);
  const first=await post('/api/preview',{folder:work,smart:{content:true,conflicts:'keep-both'}});assert.equal(first.status,200);
  const item=first.body.preview.items.find((item:any)=>item.source==='물리.txt');assert.equal(item.destination,'수업/물리/물리.txt');
  assert.ok(first.body.preview.smart.documents.some((document:any)=>document.source==='물리.txt'&&document.status==='read'));
  const modified=await post('/api/preview',{folder:work,renames:[{fileId:item.fileId,name:'새 이름.txt'}],smart:{content:true}});
  assert.equal(modified.body.preview.items.find((entry:any)=>entry.fileId===item.fileId).destination,'수업/물리/새 이름.txt');
  const skipped=await post('/api/plan',{folder:work,skips:[item.fileId],smart:{content:true}});assert.equal(skipped.status,200);
  assert.ok(skipped.body.plan.operations.every((operation:any)=>operation.source!=='물리.txt'));
  const blocked=await post('/api/preview',{folder:work,renames:[{fileId:item.fileId,name:'../escape.txt'}]});assert.equal(blocked.status,400);
  assert.deepEqual(await manifest(work),before);
});

test('mocked local AI response is allowlisted, bounded, and a bad destination stops further AI requests',async(t)=>{
  const root=await fixture(t,{'work/a.txt':'Physics velocity momentum.','work/b.txt':'Calculus derivative integral.','state/':''});
  let requests=0;
  const server=createServer((req,res)=>{requests++;req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({message:{content:JSON.stringify({folder:'../outside',confidence:1,reason:'untrusted path'})}}));});
  await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));});
  const address=server.address() as {port:number};const before=await manifest(path.join(root,'work'));
  const data=JSON.parse(await run(['preview',path.join(root,'work'),'--content','--ai-model','mock-contract-only','--ai-url',`http://127.0.0.1:${address.port}`,'--json'],undefined,{stateDir:path.join(root,'state'),warn:()=>{}}));
  assert.equal(requests,1);assert.equal(data.preview.smart.complete,false);
  assert.ok(data.preview.smart.documents.every((document:any)=>document.model===null));
  assert.ok(data.preview.items.every((item:any)=>!item.destination?.includes('outside')));
  assert.deepEqual(await manifest(path.join(root,'work')),before);
});
