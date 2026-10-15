'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {execFileSync}=require('child_process');
// This suite exercises actual file receipts, processes and kernel flock with a
// fixture control executable. It does not certify real container termination.
jest.mock('../../src/shared/executorCgroup', () => ({
  ...jest.requireActual('../../src/shared/executorCgroup'),
  observeRetainedTaskCgroup: jest.fn(() => ({scope:{removed:true,populated:false,processCount:0},leaf:{removed:true,populated:false,processCount:0},stopped:true}))
}));
const {ExecutionSupervisor}=require('../../src/shared/executorSupervisor');
const {stopExecutorRecovery}=require('../../src/shared/executorRecoveryStop');
const {releaseExecutorRecovery}=require('../../src/shared/executorRecoveryRelease');
const sampler=require('../../src/shared/executorCgroup');
let dir,root,receiptPath,lease,stages,config,binary,cid;
function deadProcess(){return JSON.parse(execFileSync(process.execPath,['-e',"const fs=require('fs'),s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);console.log(JSON.stringify({pid:process.pid,startTime:f[19]}))"],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}));}
function receipt(){return JSON.parse(fs.readFileSync(receiptPath));}
function change(fn){const r=receipt();fn(r);fs.writeFileSync(receiptPath,JSON.stringify(r)+'\n');}
function digest(){return crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');}
function queries(){const p=path.join(dir,'queries.jsonl');return fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').map(JSON.parse):[];}
function mutations(){return queries().filter(q=>q.args[1]==='rm');}
function auditFiles(){const p=path.join(root,'recovery');return fs.existsSync(p)?fs.readdirSync(p).flatMap(n=>fs.readdirSync(path.join(p,n)).map(f=>path.join(p,n,f))):[];}
function engine(mode='normal'){
 fs.writeFileSync(binary,'#!'+process.execPath+'\n'+`
 const fs=require('fs'),path=require('path'),dir=${JSON.stringify(dir)},args=process.argv.slice(2),mode=${JSON.stringify(mode)},present=path.join(dir,'present');
 fs.appendFileSync(path.join(dir,'queries.jsonl'),JSON.stringify({args,keys:Object.keys(process.env)})+'\\n');
 if(args[0]!=='--remote=false')process.exit(9);
 if(args[1]==='container'&&args[2]==='exists'){
  if(mode==='late-query-error'&&!fs.existsSync(present)){console.error('SYNTHETIC_PRIVATE_DIAGNOSTIC');process.exit(1);}
  process.exit(fs.existsSync(present)?0:1);
 }
 if(args[1]==='container'&&args[2]==='inspect'){
  const item=JSON.parse(fs.readFileSync(path.join(dir,'inspection.json')));
  if(mode==='changed-current'&&fs.existsSync(path.join(dir,'inspected')))item.Name='changed';
  fs.writeFileSync(path.join(dir,'inspected'),'1');console.log(JSON.stringify(item));process.exit(0);
 }
 if(args[1]==='rm'){
  if(mode==='remove-error'){console.error('SYNTHETIC_PRIVATE_DIAGNOSTIC');process.exit(125);}
  if(mode==='receipt-race')fs.appendFileSync(${JSON.stringify(path.join(root,'active','receipt.json'))},' ');
  if(mode!=='residual')fs.unlinkSync(present);
  console.log('removed synthetic task');process.exit(0);
 }
 process.exit(9);
 `,{mode:0o700});
}
function stop(options={}){return stopExecutorRecovery({root,podmanPath:binary,receiptSha256:digest(),...options});}
beforeEach(()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-stop-test-'));root=path.join(dir,'supervisor');
 lease=new ExecutionSupervisor({root}).acquire(crypto.randomUUID());
 const stage=fs.mkdtempSync(path.join(os.tmpdir(),'chatspace-task-files-'));
 stages={root:stage,inputRoot:path.join(stage,'inputs'),outputRoot:fs.mkdtempSync(path.join(dir,'chatspace-task-outputs-'))};fs.mkdirSync(stages.inputRoot,{mode:0o700});lease.staged(stages);lease.start();
 config=fs.mkdtempSync(path.join(os.tmpdir(),'chatspace-engine-config-'));const s=fs.statSync(config,{bigint:true}),j=lease.journal();
 j.record({phase:'creating',containerName:'chatspace-task-'+crypto.randomUUID(),image:'sha256:'+'a'.repeat(64),podmanPath:'/untrusted/receipt/binary',configuration:{path:config,dev:String(s.dev),ino:String(s.ino)}});
 cid='b'.repeat(64);fs.writeFileSync(j.cidFile,cid,{mode:0o600});const c=fs.statSync(j.cidFile,{bigint:true});j.record({phase:'created',containerId:cid,cidFile:{path:j.cidFile,dev:String(c.dev),ino:String(c.ino)}});
 const cg='/sys/fs/cgroup/user.slice/libpod-'+cid+'.scope';j.record({phase:'starting',containerId:cid,process:deadProcess(),cgroup:{path:cg+'/container',dev:'30',ino:'123',scope:{path:cg,dev:'30',ino:'122'}}});lease.retain();
 receiptPath=path.join(root,'active','receipt.json');change(r=>{r.ownerProcess=deadProcess()});
 const r=receipt();fs.writeFileSync(path.join(dir,'inspection.json'),JSON.stringify({Id:cid,Name:r.engine.containerName,ImageName:r.engine.image,Config:{Labels:{'chatspace.task':r.taskId,'chatspace.lease':r.leaseId}},State:{Status:'exited',Running:false,Pid:0}}));
 fs.writeFileSync(path.join(dir,'present'),'1');binary=path.join(dir,'engine');engine();sampler.observeRetainedTaskCgroup.mockClear();
});
afterEach(()=>{lease.close();for(const p of[stages.root,config,dir])fs.rmSync(p,{recursive:true,force:true});});
test('stop binds exact identity, preserves original receipt/files and leaves admission blocked',async()=>{
 const before=fs.readFileSync(receiptPath);fs.writeFileSync(path.join(stages.outputRoot,'controlled.txt'),'PRESERVE');
 const result=await stop();expect(result).toMatchObject({mode:'stop_only',containerId:cid,stopConfirmed:true,admissionCleared:false});
 expect(result.observations).toHaveLength(5);expect(mutations().map(q=>q.args)).toEqual([['--remote=false','rm','--force','--time=0','--ignore',cid]]);
 expect(fs.readFileSync(receiptPath)).toEqual(before);expect(fs.readFileSync(path.join(stages.outputRoot,'controlled.txt'),'utf8')).toBe('PRESERVE');expect(fs.existsSync(config)).toBe(true);
 const files=auditFiles();expect(files.map(p=>path.basename(p)).sort()).toEqual(['intent.json','result.json']);
 expect(files.every(p=>(fs.statSync(p).mode&0o777)===0o600)).toBe(true);expect(JSON.parse(fs.readFileSync(files.find(p=>p.endsWith('intent.json')))).receiptSha256).toBe(digest());
 expect(()=>new ExecutionSupervisor({root}).acquire(crypto.randomUUID())).toThrow('supervisor review');
});
test.each(['missing-hash','changed-hash','live-owner','changed-boot','legacy-boot','legacy-cgroup','replaced-stage','unreviewed-file','wrong-current-identity'])('%s refuses mutation and preserves admission',async kind=>{
 let options={};
 if(kind==='missing-hash')options.receiptSha256=undefined;
 if(kind==='changed-hash')options.receiptSha256='c'.repeat(64);
 if(kind==='live-owner')change(r=>{const t=fs.readFileSync('/proc/self/stat','utf8'),f=t.slice(t.lastIndexOf(')')+2).trim().split(/\s+/);r.ownerProcess={pid:process.pid,startTime:f[19]}});
 if(kind==='changed-boot')change(r=>{r.bootId=crypto.randomUUID()});
 if(kind==='legacy-boot')change(r=>{delete r.bootId});
 if(kind==='legacy-cgroup')change(r=>{delete r.engine.cgroup});
 if(kind==='replaced-stage'){fs.renameSync(stages.outputRoot,stages.outputRoot+'-saved');fs.mkdirSync(stages.outputRoot,{mode:0o700});}
 if(kind==='unreviewed-file')fs.writeFileSync(path.join(root,'active','unknown'),'PRESERVE');
 if(kind==='wrong-current-identity')engine('changed-current');
 await expect(stop(options)).rejects.toThrow();expect(mutations()).toEqual([]);expect(fs.existsSync(receiptPath)).toBe(true);expect(auditFiles()).toEqual([]);
});
test.each(['remove-error','residual','late-query-error','receipt-race'])('%s retains a durable intent and uncertain outcome without releasing anything',async mode=>{
 engine(mode);const before=fs.readFileSync(receiptPath);await expect(stop()).rejects.toThrow();
 expect(mutations()).toHaveLength(1);expect(fs.existsSync(stages.outputRoot)).toBe(true);expect(fs.existsSync(config)).toBe(true);
 if(mode!=='receipt-race')expect(fs.readFileSync(receiptPath)).toEqual(before);
 expect(auditFiles().map(p=>path.basename(p)).sort()).toEqual(['intent.json','uncertain.json']);
 expect(auditFiles().every(p=>!fs.readFileSync(p,'utf8').includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'))).toBe(true);
});
test('populated descendants with an exited main process cannot produce a stoppage proof',async()=>{
 sampler.observeRetainedTaskCgroup.mockImplementationOnce(()=>({stopped:false})).mockImplementationOnce(()=>({stopped:false}));
 await expect(stop()).rejects.toThrow('hierarchy remains live');expect(auditFiles().some(p=>p.endsWith('uncertain.json'))).toBe(true);expect(fs.existsSync(receiptPath)).toBe(true);
});
test('kernel flock excludes a concurrent operator until all inherited descriptors close',async()=>{
 const first=stop(),until=Date.now()+10000;
 while(!auditFiles().some(p=>p.endsWith('intent.json'))&&Date.now()<until)await new Promise(r=>setTimeout(r,20));
 await expect(stop()).rejects.toThrow('operator');expect((await first).stopConfirmed).toBe(true);expect(mutations()).toHaveLength(1);
 // A completed stop never expunges admission; another inspect/stop can review it.
 expect((await stop()).stopConfirmed).toBe(true);expect(mutations()).toHaveLength(1);
});
test.each(['symlink','hardlink','public'])('unsafe %s operator lock cannot authorize removal',async kind=>{
 const p=path.join(root,'.operator.lock'),target=path.join(dir,'target');fs.writeFileSync(target,'PRESERVE',{mode:0o600});
 if(kind==='symlink')fs.symlinkSync(target,p);else if(kind==='hardlink')fs.linkSync(target,p);else fs.writeFileSync(p,'PRESERVE',{mode:0o644});
 await expect(stop()).rejects.toThrow();expect(mutations()).toEqual([]);expect(fs.readFileSync(target,'utf8')).toBe('PRESERVE');
});
test.each(['malformed-pid','unrelated-live-process'])('%s cannot authorize stopping a synthetic container',async kind=>{
 const p=path.join(dir,'inspection.json'),item=JSON.parse(fs.readFileSync(p));
 if(kind==='malformed-pid'){item.State.Running=true;item.State.Pid=0;}
 else{const text=fs.readFileSync('/proc/self/stat','utf8'),fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
   change(r=>{r.engine.process={pid:process.pid,startTime:fields[19]}});item.State={Status:'running',Running:true,Pid:process.pid};}
 fs.writeFileSync(p,JSON.stringify(item));await expect(stop()).rejects.toThrow();expect(mutations()).toEqual([]);expect(auditFiles()).toEqual([]);
});
test('untrusted audit directory cannot redirect writes or authorize task removal',async()=>{
 const target=path.join(dir,'target-directory');fs.mkdirSync(target,{mode:0o700});fs.writeFileSync(path.join(target,'canary'),'PRESERVE');
 fs.symlinkSync(target,path.join(root,'recovery'));
 await expect(stop()).rejects.toThrow();expect(mutations()).toEqual([]);expect(fs.readFileSync(path.join(target,'canary'),'utf8')).toBe('PRESERVE');
});

// Release tests still use the fixture engine/hierarchy. A stop audit authorizes
// review only; release must independently establish current absence and emptiness.
function stopProof() {
 const r=receipt(),id=crypto.randomUUID(),base=path.join(root,'recovery',id);
 fs.mkdirSync(base,{recursive:true,mode:0o700});
 const ident=p=>{const s=fs.statSync(p,{bigint:true});return{dev:String(s.dev),ino:String(s.ino)}};
 const common={version:1,taskId:r.taskId,leaseId:r.leaseId,receiptSha256:digest(),containerId:cid,admissionCleared:false};
 fs.writeFileSync(path.join(base,'intent.json'),JSON.stringify({...common,operation:'stop_only',id,boot:{recorded:r.bootId,current:r.bootId,same:true},rootIdentity:ident(root),activeIdentity:ident(path.join(root,'active'))}),{mode:0o600});
 fs.writeFileSync(path.join(base,'result.json'),JSON.stringify({...common,mode:'stop_only',operationId:id,stopConfirmed:true,observations:Array.from({length:5},()=>({exactAbsence:true}))}),{mode:0o600});
 fs.unlinkSync(path.join(dir,'present'));return id;
}
function release(id,options={}){return releaseExecutorRecovery({root,podmanPath:binary,receiptSha256:digest(),stopOperation:id,discardTaskFiles:true,...options});}
test('reviewed release discards bounded bytes, archives original evidence and reopens admission',async()=>{
 fs.mkdirSync(path.join(config,'hooks'),{mode:0o700});fs.writeFileSync(path.join(config,'containers.conf'),'CONTROL',{mode:0o600});
 fs.writeFileSync(path.join(stages.inputRoot,'input.txt'),'INPUT',{mode:0o600});fs.writeFileSync(path.join(stages.outputRoot,'output.txt'),'OUTPUT');
 const stopped=await stop(),before=fs.readFileSync(receiptPath),result=await release(stopped.operationId);
 expect(result).toMatchObject({mode:'release_discard',admissionCleared:true,stageBytesDisposed:true,cleanupPending:[],blockers:[]});
 const archive=path.join(root,'recovery',result.operationId,'admission');expect(fs.readFileSync(path.join(archive,'receipt.json'))).toEqual(before);
 expect(fs.readFileSync(path.join(archive,'container.cid'),'utf8')).toBe(cid);
 for(const p of[stages.root,stages.outputRoot,config])expect(fs.existsSync(p)).toBe(false);
 const next=new ExecutionSupervisor({root}).acquire(crypto.randomUUID());next.stopped();next.release();
 expect(mutations()).toHaveLength(1);
});
test.each(['no-discard','stale-hash','wrong-stop-operation','mismatched-stop-audit','audit-symlink','live-container','populated-hierarchy','changed-stage','unknown-stage-entry','linked-output'])('%s cannot release admission or discard any task bytes',async kind=>{
 fs.writeFileSync(path.join(stages.outputRoot,'canary'),'PRESERVE');const id=stopProof();let opts={};
 if(kind==='no-discard')opts.discardTaskFiles=false;
 if(kind==='stale-hash')opts.receiptSha256='c'.repeat(64);
 if(kind==='wrong-stop-operation')opts.stopOperation=crypto.randomUUID();
 if(kind==='mismatched-stop-audit'){const p=path.join(root,'recovery',id,'result.json'),r=JSON.parse(fs.readFileSync(p));r.taskId=crypto.randomUUID();fs.writeFileSync(p,JSON.stringify(r));}
 if(kind==='audit-symlink'){const p=path.join(root,'recovery',id,'result.json');fs.renameSync(p,p+'-saved');fs.symlinkSync(p+'-saved',p);}
 if(kind==='live-container')fs.writeFileSync(path.join(dir,'present'),'1');
 if(kind==='populated-hierarchy')sampler.observeRetainedTaskCgroup.mockImplementationOnce(()=>({stopped:false}));
 if(kind==='changed-stage'){fs.renameSync(stages.outputRoot,stages.outputRoot+'-saved');fs.mkdirSync(stages.outputRoot,{mode:0o700});fs.writeFileSync(path.join(stages.outputRoot,'canary'),'PRESERVE');}
 if(kind==='unknown-stage-entry')fs.writeFileSync(path.join(stages.root,'unknown'),'PRESERVE');
 if(kind==='linked-output')fs.linkSync(path.join(stages.outputRoot,'canary'),path.join(dir,'hardlink'));
 await expect(release(id,opts)).rejects.toThrow();expect(fs.existsSync(receiptPath)).toBe(true);expect(mutations()).toEqual([]);
 expect(fs.readFileSync(path.join(stages.outputRoot,'canary'),'utf8')).toBe('PRESERVE');
});
test('task symlink and FIFO disposal never opens or follows a private target',async()=>{
 const target=path.join(dir,'private-target');fs.writeFileSync(target,'PRIVATE_CONTROL');
 fs.symlinkSync(target,path.join(stages.outputRoot,'link'));execFileSync('/usr/bin/mkfifo',[path.join(stages.outputRoot,'pipe')]);
 const id=stopProof();expect((await release(id)).admissionCleared).toBe(true);expect(fs.readFileSync(target,'utf8')).toBe('PRIVATE_CONTROL');
});
test('oversized staging fails before any disposal',async()=>{
 const file=path.join(stages.outputRoot,'large'),fd=fs.openSync(file,'w');fs.ftruncateSync(fd,24*1024*1024+1);fs.closeSync(fd);
 const id=stopProof();await expect(release(id)).rejects.toThrow('byte budget');expect(fs.statSync(file).size).toBe(24*1024*1024+1);expect(fs.existsSync(receiptPath)).toBe(true);
});
test('release query errors preserve bytes and hide fixture diagnostics',async()=>{
 fs.writeFileSync(path.join(stages.outputRoot,'canary'),'PRESERVE');const id=stopProof();engine('late-query-error');
 await expect(release(id)).rejects.toThrow('uncertain');expect(fs.readFileSync(path.join(stages.outputRoot,'canary'),'utf8')).toBe('PRESERVE');expect(fs.existsSync(receiptPath)).toBe(true);
});

test('interrupted disposal keeps the original admission and safely resumes with the same review',async()=>{
 fs.writeFileSync(path.join(stages.inputRoot,'input.txt'),'INPUT');const output=path.join(stages.outputRoot,'output.txt');fs.writeFileSync(output,'OUTPUT');
 const id=stopProof(),before=fs.readFileSync(receiptPath),unlink=fs.unlinkSync;
 const failure=jest.spyOn(fs,'unlinkSync').mockImplementation(p=>{if(path.basename(p)==='output.txt')throw Object.assign(Error('controlled interruption'),{code:'EIO'});return unlink(p)});
 try { await expect(release(id)).rejects.toThrow('controlled interruption'); } finally { failure.mockRestore(); }
 expect(fs.readFileSync(receiptPath)).toEqual(before);expect(fs.readdirSync(stages.inputRoot)).toEqual([]);expect(fs.readFileSync(output,'utf8')).toBe('OUTPUT');
 expect(()=>new ExecutionSupervisor({root}).acquire(crypto.randomUUID())).toThrow('supervisor review');
 expect(auditFiles().some(p=>p.endsWith('uncertain.json'))).toBe(true);
 expect((await release(id)).admissionCleared).toBe(true);
});
test('post-archive empty-directory failure reports pending cleanup without erasing evidence',async()=>{
 fs.writeFileSync(path.join(stages.outputRoot,'output.txt'),'OUTPUT');const id=stopProof(),remove=fs.rmdirSync;
 const failure=jest.spyOn(fs,'rmdirSync').mockImplementation(p=>{if(path.basename(p)===path.basename(stages.outputRoot))throw Error('controlled empty-directory failure');return remove(p)});
 let result;try { result=await release(id); } finally { failure.mockRestore(); }
 expect(result).toMatchObject({admissionCleared:true,stageBytesDisposed:true,cleanupPending:[1]});expect(result.blockers).toHaveLength(1);
 expect(fs.readdirSync(stages.outputRoot)).toEqual([]);expect(fs.existsSync(path.join(root,'recovery',result.operationId,'admission','receipt.json'))).toBe(true);
 const next=new ExecutionSupervisor({root}).acquire(crypto.randomUUID());next.stopped();next.release();
});

test('a post-rename fsync error records uncertain durability and retains the archived receipt',async()=>{
 const id=stopProof(),before=fs.readFileSync(receiptPath),sync=fs.fsyncSync;let triggered=false;
 const fault=jest.spyOn(fs,'fsyncSync').mockImplementation(fd=>{
  const anchored='/proc/self/fd/'+fd+'/admission';
  if(!triggered&&fs.existsSync(anchored)){triggered=true;throw Error('controlled archive sync failure')}
  return sync(fd);
 });
 try { await expect(release(id)).rejects.toThrow('controlled archive sync failure'); } finally { fault.mockRestore(); }
 expect(triggered).toBe(true);
 const records=auditFiles().filter(p=>p.endsWith('uncertain.json')).map(p=>JSON.parse(fs.readFileSync(p)));
 expect(records).toEqual(expect.arrayContaining([expect.objectContaining({step:'admission_archive',admissionArchiveRenamed:true,admissionCleared:null})]));
 const archived=fs.readdirSync(path.join(root,'recovery')).map(n=>path.join(root,'recovery',n,'admission','receipt.json')).filter(p=>fs.existsSync(p));
 expect(archived).toHaveLength(1);expect(fs.readFileSync(archived[0])).toEqual(before);
});
