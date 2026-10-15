'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const { validateTaskCgroupIdentity, readInitializedTaskCgroup, observeRetainedTaskCgroup, observeTaskProcess } = require('../../src/shared/executorCgroup');
const id = 'b'.repeat(64), scope = '/sys/fs/cgroup/user.slice/libpod-' + id + '.scope';
const valid = () => ({ path: scope + '/container', dev: '30', ino: '123', scope: { path: scope, dev: '30', ino: '122' } });

test('selects only the exact container scope and stable inode metadata', () => {
  const value = valid(); value.extra = 'SYNTHETIC_UNREVIEWED'; value.scope.extra = 'SYNTHETIC_UNREVIEWED';
  expect(validateTaskCgroupIdentity(value, id)).toEqual(valid());
});
test.each(['wrong-id', 'traversal', 'relative', 'wrong-scope', 'wrong-parent', 'wrong-leaf', 'null', 'numeric-dev', 'zero-inode', 'missing-scope', 'newline'])('rejects %s cgroup metadata', kind => {
  let value = valid(), cid = id;
  if (kind === 'wrong-id') cid = 'c'.repeat(64);
  if (kind === 'traversal') value.path = scope + '/elsewhere/../container';
  if (kind === 'relative') value.path = 'sys/fs/cgroup/container';
  if (kind === 'wrong-scope') value.scope.path = scope.replace('libpod-', 'other-');
  if (kind === 'wrong-parent') { value.path = '/tmp/libpod-' + id + '.scope/container'; value.scope.path = '/tmp/libpod-' + id + '.scope'; }
  if (kind === 'wrong-leaf') value.path = scope + '/another';
  if (kind === 'null') value = null;
  if (kind === 'numeric-dev') value.dev = 30;
  if (kind === 'zero-inode') value.ino = '0';
  if (kind === 'missing-scope') delete value.scope;
  if (kind === 'newline') value.path += '\n';
  expect(() => validateTaskCgroupIdentity(value, cid)).toThrow('cgroup identity');
});
test('an exited process cannot supply an initialized cgroup through a reused PID', () => {
  const identity = JSON.parse(execFileSync(process.execPath, ['-e', "const fs=require('fs'),s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);console.log(JSON.stringify({pid:process.pid,startTime:f[19]}))"], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }));
  expect(() => readInitializedTaskCgroup(identity, id)).toThrow();
});
test('wrong start identity is denied before cgroup path access', () => {
  const text=fs.readFileSync('/proc/self/stat','utf8'), fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  expect(() => readInitializedTaskCgroup({pid:process.pid,startTime:String(BigInt(fields[19])+1n)},id)).toThrow('cgroup identity');
});
test('ordinary test process membership cannot masquerade as the exact libpod task', () => {
  const text=fs.readFileSync('/proc/self/stat','utf8'), fields=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  expect(() => readInitializedTaskCgroup({pid:process.pid,startTime:fields[19]},id)).toThrow('cgroup identity');
});
describe('bounded cgroup observation protocol, with explicit filesystem fixtures', () => {
  const os=require('os'),path=require('path');let dir,scopeDir,leafDir,spies;
  beforeEach(()=>{
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'cgroup-observation-fixture-'));scopeDir=path.join(dir,'scope');leafDir=path.join(scopeDir,'container');
    fs.mkdirSync(scopeDir);fs.mkdirSync(leafDir);
    for(const p of[scopeDir,leafDir]){fs.writeFileSync(path.join(p,'cgroup.events'),'populated 0\nfrozen 0\n');fs.writeFileSync(path.join(p,'cgroup.procs'),'');}
    const mapped=p=>String(p)===scope?scopeDir:String(p)===scope+'/container'?leafDir:p;
    const real=fs.realpathSync.bind(fs),open=fs.openSync.bind(fs),lstat=fs.lstatSync.bind(fs);
    // Deliberately model kernel path/type claims; only the bounded/no-follow
    // filesystem behavior is real here. The VM supplies kernel evidence.
    spies=[jest.spyOn(fs,'realpathSync').mockImplementation(p=>String(p).startsWith('/sys/fs/cgroup')?String(p):real(p)),
      jest.spyOn(fs,'openSync').mockImplementation((p,...args)=>open(mapped(p),...args)),
      jest.spyOn(fs,'lstatSync').mockImplementation((p,...args)=>lstat(mapped(p),...args)),
      jest.spyOn(fs,'statfsSync').mockReturnValue({type:0x63677270})];
  });
  afterEach(()=>{for(const spy of spies)spy.mockRestore();fs.rmSync(dir,{recursive:true,force:true});});
  function metadata(){const s=fs.statSync(scopeDir,{bigint:true}),l=fs.statSync(leafDir,{bigint:true});return{path:scope+'/container',dev:String(l.dev),ino:String(l.ino),scope:{path:scope,dev:String(s.dev),ino:String(s.ino)}};}
  test('scope population detects descendants even when the leaf main process is absent',()=>{
    fs.writeFileSync(path.join(scopeDir,'cgroup.events'),'populated 1\nfrozen 0\n');
    expect(observeRetainedTaskCgroup(metadata(),id).stopped).toBe(false);
  });
  test('an empty exact hierarchy is observed without any write',()=>{
    const before=fs.readFileSync(path.join(scopeDir,'cgroup.events'));
    expect(observeRetainedTaskCgroup(metadata(),id).stopped).toBe(true);
    expect(fs.readFileSync(path.join(scopeDir,'cgroup.events'))).toEqual(before);
  });
  test.each(['wrong-inode','missing-control','malformed-population','duplicate-population','oversize','symlink','fifo'])('%s cannot be reported as a stopped hierarchy',kind=>{
    const value=metadata(),control=path.join(scopeDir,'cgroup.events');
    if(kind==='wrong-inode')value.scope.ino=String(BigInt(value.scope.ino)+1n);
    if(kind==='missing-control')fs.unlinkSync(control);
    if(kind==='malformed-population')fs.writeFileSync(control,'populated maybe\n');
    if(kind==='duplicate-population')fs.writeFileSync(control,'populated 0\npopulated 1\n');
    if(kind==='oversize')fs.writeFileSync(control,'x'.repeat(257));
    if(kind==='symlink'){fs.unlinkSync(control);fs.symlinkSync(path.join(leafDir,'cgroup.events'),control);}
    if(kind==='fifo'){fs.unlinkSync(control);execFileSync('/usr/bin/mkfifo',[control]);}
    expect(()=>observeRetainedTaskCgroup(value,id)).toThrow();
  });
});

test('fixed process observation distinguishes live, exited and reused start identities',()=>{
 const text=fs.readFileSync('/proc/self/stat','utf8'),f=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/),self={pid:process.pid,startTime:f[19]};
 expect(observeTaskProcess(self)).toEqual({...self,absentOrStopped:false});
 expect(observeTaskProcess({...self,startTime:String(BigInt(f[19])+1n)}).absentOrStopped).toBe(true);
 const exited=JSON.parse(execFileSync(process.execPath,['-e',"const fs=require('fs'),s=fs.readFileSync('/proc/self/stat','utf8'),f=s.slice(s.lastIndexOf(')')+2).trim().split(/\\s+/);console.log(JSON.stringify({pid:process.pid,startTime:f[19]}))"],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}));
 expect(observeTaskProcess(exited)).toEqual({...exited,absentOrStopped:true});
});
test.each([null,{pid:1,startTime:'100'},{pid:'123',startTime:'100'},{pid:process.pid,startTime:'0'}])('missing or invalid process identity %p is not stoppage proof',value=>{
 expect(()=>observeTaskProcess(value)).toThrow('cgroup identity');
});
