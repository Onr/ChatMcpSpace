#!/usr/bin/env python3
"""Prepare complete, reviewable VM harnesses; never execute supplied JavaScript."""
import argparse
import datetime
import difflib
import hashlib
import json
import os
import pathlib
import subprocess
import tarfile
import uuid

OLD_ROUND = '20261004T170051Z-f58b7fd0'
OLD_SOURCE = '1d4ebd727291bfa011c213679cb33629ba4dacbf9fb665a1c202d9b261da0deb'
MAIN_HASH = 'a7b64db1ca307e4020e0411d2335b55555734781d701b85c81218d567f91589e'
ADDITIONAL_HASH = 'b0b1da34910135b49e4d89914a4c7c9ee1edd2e29d72116be34b94b6a8bdc2a2'
CONSUMER_HASH = 'f8f15151687b75ad25bf54d5d42fa9a11e3684ffcdb3fe448b0655892afe40f2'
ROOT = pathlib.Path(__file__).resolve().parents[2]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def once(text, old, new):
    if text.count(old) != 1:
        raise ValueError('Adaptation requires exactly one match: ' + old[:100])
    return text.replace(old, new, 1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--round7', type=pathlib.Path, required=True)
    parser.add_argument('--destination', type=pathlib.Path, required=True)
    parser.add_argument('--number', type=int, default=8)
    parser.add_argument('--previous-packet', type=pathlib.Path)
    args = parser.parse_args()
    if not 8 <= args.number <= 99:
        parser.error('--number must be between 8 and 99')
    previous_round = OLD_ROUND
    previous_number = 7
    previous_files = {}
    if args.previous_packet:
        previous_manifest = json.loads((args.previous_packet / 'artifact-manifest.json').read_text())
        for name, item in previous_manifest.items():
            relative = pathlib.PurePosixPath(name)
            assert not relative.is_absolute() and '..' not in relative.parts, name
            file = args.previous_packet / name
            assert file.is_file() and not file.is_symlink(), name
            data = file.read_bytes()
            assert len(data) == item['bytes'] and digest(data) == item['sha256'], name
            previous_files[name] = data
        previous_metadata = json.loads(previous_files['verification-round.json'])
        previous_round = previous_metadata['roundId']
        previous_number = previous_metadata['roundNumber']
        if not isinstance(previous_number, int) or not 8 <= previous_number < args.number:
            raise ValueError('Previous packet number must precede this round')
    manifest = json.loads((args.round7 / 'verification-artifact-manifest.json').read_text())
    known = {item['path']: item for item in manifest['files']}

    def retained(name, expected=None):
        item = known[name]
        data = (args.round7 / name).read_bytes()
        assert len(data) == item['bytes'] and digest(data) == item['sha256'], name
        if expected:
            assert digest(data) == expected, name
        return data

    originals = {
        'executor-verification-harness-r8.js': retained('executor-verification-harness-r7.js', MAIN_HASH),
        'round8-additional-harness.js': retained('round7-additional-harness.js', ADDITIONAL_HASH),
        'query-error-audit-r8.js': retained('query-error-audit-r7-corrected.js'),
        'workspace-bind-audit-r8.js': retained('workspace-bind-audit-r7.js'),
        'task-mount-race-r8.js': retained('task-mount-race-r7.js'),
        'task-files-targeted-r8.js': retained('task-files-targeted-r7.js'),
        'task-file-limits-r8.js': retained('task-file-limits-r7.js'),
        'policy-path-harness-r8.js': retained('policy-path-harness-r7.js'),
        'tmpfs-exhaustion-r8.py': retained('tmpfs-exhaustion-r7.py'),
    }
    consumer = retained('consumer-reference.js', CONSUMER_HASH)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    source = subprocess.check_output(['git', 'show', commit + ':src/shared/restrictedExecutor.js'], cwd=ROOT)
    source_hash = digest(source)
    round_id = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    args.destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    payload = args.destination / 'payload'
    payload.mkdir(mode=0o700)

    def write(name, data):
        file = payload / name
        file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with file.open('xb') as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
        os.chmod(file, 0o700 if name == 'podman-phase-recorder.js' else 0o600)

    def adapt(text):
        return text.replace(OLD_ROUND, round_id).replace(OLD_SOURCE, source_hash)

    def numbered(name, old_number=8):
        return name.replace('r' + str(old_number), 'r' + str(args.number)).replace('round' + str(old_number), 'round' + str(args.number))

    for name, data in originals.items():
        original_name = name.replace('r8', 'r7').replace('round8', 'round7')
        write('originals/' + original_name, data)
        text = adapt(data.decode())
        if name.endswith('.js'):
            text = once(text, "'use strict';", "'use strict';\nconst {publishJSON,waitForJSON,readJSONLines,readJSON,phaseReader,processIdentity,acquireDriverLock,verifyRecorder,requiredResultsExitCode,readCgroupSample}=require('./protocol');\nconst {cleanupTaskFiles}=require('./task-files-cleanup');\nacquireDriverLock(__dirname);")
            if name not in ['policy-path-harness-r8.js', 'task-file-limits-r8.js']:
                text = once(text, 'acquireDriverLock(__dirname);', 'acquireDriverLock(__dirname);\nverifyRecorder(__dirname);')
            # All drivers have an exclusive control handoff. Refuse a second driver
            # and make the final pathname visible only after JSON is complete.
            import re
            text = re.sub(r"fs\.writeFileSync\((path\.join\((?:ROOT|root|R),'phase-control\.json'\)),JSON\.stringify\((control|\{plans\})\),\{(?:mode:0o600,flag:'wx'|flag:'wx',mode:0o600)\}\)",
                          r'publishJSON(\1,\2)', text)
            for directory in ['evidenceDir', 'E', 'evidence']:
                old = "fs.readFileSync(path.join(" + directory + ",'engine-phases.jsonl'),'utf8').trim().split('\\n').map(v=>JSON.parse(v))"
                text = text.replace(old, "readJSONLines(path.join(" + directory + ",'engine-phases.jsonl'))")

        if name == 'executor-verification-harness-r8.js':
            text = once(text, "process.exitCode = records.some(record => record.status === 'FAIL') ? 1 : 0;",
                        'process.exitCode = requiredResultsExitCode(records, 13);')
            observer_start = text.index('async function waitContainerLive(')
            observer_end = text.index('async function cancellationChecks()', observer_start)
            text = text[:observer_start] + '''const nextMainPhases=phaseReader(path.join(evidenceDir,'engine-phases.jsonl')),mainPhaseCache=[];
function mainPhases(){mainPhaseCache.push(...nextMainPhases());return mainPhaseCache}
async function waitContainerLive(before, runPromise, deadlineMs) {
  const offset=mainPhases().length;
  const settledPromise=runPromise.then(value=>({ok:true,value}),error=>({ok:false,error}));
  let completed=false;
  settledPromise.then(()=>{completed=true});
  let name,id,initialized,identity;
  while(Date.now()<deadlineMs){
    const records=mainPhases().slice(offset);
    if(!id){
      const create=records.find(v=>v.event==='invoke'&&v.phase==='create'&&v.argv.includes('--name')&&!before.has(v.argv[v.argv.indexOf('--name')+1]));
      const exit=create&&records.find(v=>v.event==='exit'&&v.call===create.call);
      if(exit&&exit.code===0){
        id=exit.stdout.trim();name=create.argv[create.argv.indexOf('--name')+1];
        assert(/^[a-f0-9]{64}$/.test(id)&&/^chatspace-task-[0-9a-f-]{36}$/.test(name),'observer create identity invalid');
        ownedNames.add(name);ownedIds.set(name,id);
      }
    }
    if(id&&!initialized){
      const call=records.find(v=>v.event==='invoke'&&v.phase==='container'&&v.argv.includes('{{json .}}')&&v.argv.at(-1)===id);
      const saved=call&&records.find(v=>v.call===call.call&&v.event==='control-output-saved');
      if(saved){
        assert(path.dirname(saved.file)===evidenceDir,'observer inspection outside round evidence');
        initialized=readJSON(saved.file);
        assert(initialized.Id===id&&initialized.State.Status==='initialized','observer initialized identity mismatch');
        identity=processIdentity(Number(initialized.State.Pid));
        publishJSON(path.join(evidenceDir,'observer-initialized-'+id+'.json'),{id,name,identity,state:initialized.State});
      }
    }
    if(identity){
      let current;
      try{current=processIdentity(identity.pid)}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}
      const start=records.some(v=>v.event==='invoke'&&v.phase==='start'&&v.argv.at(-1)===id);
      // Initialization alone is not liveness: require the exact initialized PID
      // to exec Node, then independently confirm live state with real Podman.
      if(start&&current&&current.startTime===identity.startTime&&current.command==='node'&&!['Z','X','x'].includes(current.state)){
        const inspected=await inspectContainer(name).catch(error=>{if(!completed)throw error;return null});
        if(inspected&&inspected.Id===id&&inspected.State.Running)return {name,inspection:inspected,settledPromise};
      }
    }
    if(completed)return {name:null,settledPromise,completed:await settledPromise};
    await wait(10);
  }
  return {name:null,settledPromise,timeout:true};
}
''' + text[observer_end:]
            text = once(text, '  const inspect = await inspectContainer(live.name);',
                        '  const inspect = live.inspection || await inspectContainer(live.name);')
            text = once(text, '    const taskInspect = await inspectContainer(observed.name);',
                        '    const taskInspect = observed.inspection || await inspectContainer(observed.name);')
            # The main workload sampler also races cgroup teardown. Preserve
            # partial ENOENT/ENODEV observations using the same reviewed reader
            # as the additional suite. Enforcement/result/absence assertions
            # below remain unchanged and still require their positive evidence.
            text = once(text, "        const sample = {};\n        for (const name of ['cpu.stat', 'pids.current', 'pids.events', 'memory.events']) sample[name] = readCgroupValue(taskCgroup, name);",
                        '        const sample = readCgroupSample(taskCgroup, {});')
            text = once(text, '  process.env.HOME = remote.testHome;',
                        '  const previousHome = process.env.HOME;\n  process.env.HOME = remote.testHome;')
            text = once(text, "    remote.server.removeListener('connection', onConnection);",
                        "    if (previousHome === undefined) delete process.env.HOME;\n    else process.env.HOME = previousHome;\n    remote.server.removeListener('connection', onConnection);")
            text = once(text, '  const helperPath = __filename;',
                        "  const helperPath = path.join(__dirname, 'workspace-race-worker.js');")
            text = once(text, "  const worker = spawn(process.execPath, [helperPath, '--workspace-race-worker', raceRoot, canaryRoot, stopFile], {",
                        "  const workerStderr = fs.openSync(path.join(evidenceDir,'workspace-race-worker.stderr.log'),'wx',0o600);\n  const worker = spawn(process.execPath, [helperPath, '--workspace-race-worker', raceRoot, canaryRoot, stopFile], {")
            text = once(text, "    stdio: 'ignore', shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, windowsHide: true",
                        "    stdio: ['ignore','ignore',workerStderr], shell: false, env: { PATH: process.env.PATH || '/usr/bin:/bin' }, windowsHide: true")
            text = once(text, "  const readyFile=stopFile+'.ready';\n  const readyUntil=Date.now()+5000;while(!fs.existsSync(readyFile)&&Date.now()<readyUntil)await wait(10);\n  assert(fs.existsSync(readyFile),'workspace race worker never acknowledged readiness');",
                        "  fs.closeSync(workerStderr);\n  const workerExited = new Promise(resolve=>{worker.once('exit',(code,signal)=>resolve({code,signal}));worker.once('error',error=>resolve({error:error.message}));});\n  const readyFile=stopFile+'.ready';")
            text = once(text, '  let snapshotRejections = 0;\n  try {',
                        "  let snapshotRejections = 0;\n  try {\n    const ready = await waitForJSON(readyFile,5000);\n    assert(ready.ready&&ready.pid===worker.pid&&processIdentity(worker.pid).startTime===ready.startTime,'workspace worker readiness identity differs');")
            text = once(text, "    await new Promise(resolve => {\n      const timer = setTimeout(() => { try { worker.kill('SIGKILL'); } catch (_) {} resolve(); }, 3000);\n      worker.once('exit', () => { clearTimeout(timer); resolve(); });\n    });",
                        "    const timer = setTimeout(()=>{try{worker.kill('SIGKILL')}catch(_){}},3000);\n    let workerExit;try{workerExit=await workerExited}finally{clearTimeout(timer)}\n    publishJSON(path.join(evidenceDir,'workspace-race-worker-exit.json'),workerExit);")
            worker_start = text.index('function workspaceRaceWorker() {')
            worker_end = text.index('async function consumerTests()', worker_start)
            text = text[:worker_start] + text[worker_end:]
            text = once(text, "  if (process.argv[2] === '--workspace-race-worker') {\n    workspaceRaceWorker();\n    return;\n  }\n", '')
            text = once(text, "const roundDir = path.resolve(process.env.AGENT_SHARING_ROUND_DIR || __dirname);",
                        "const roundDir = path.resolve(process.env.AGENT_SHARING_ROUND_DIR || __dirname);\nif(roundDir!==path.resolve(__dirname)) throw Error('Recorder and driver evidence directories must match');")
            text = once(text, "assert(exists.exitCode===1,'exact container absence not established: exit '+exists.exitCode);",
                        "assert(exists.exitCode===1&&!exists.stdout&&!exists.stderr&&!exists.error.signal&&!exists.error.killed,'exact container absence not established: exit '+exists.exitCode);")
            start = text.index('  if (fs.readdirSync(outputStore).length !== 0) {', text.index('const untrackedNewNames'))
            end = text.index('  const fixtureStat = ', start)
            text = text[:start] + "  assert(fs.readdirSync(outputStore).length===0,'output store not empty: preserve paths for exact identity/absence review; never delete by prefix');\n" + text[end:]

        if name == 'round8-additional-harness.js':
            text = once(text, "process.exitCode=records.some(r=>r.status==='FAIL')?1:0;return",
                        'process.exitCode=requiredResultsExitCode(records,1);return')
            text = once(text, "const sample={elapsedMs:Date.now()-started};for(const key of ['pids.current','pids.events','memory.events','cpu.stat','cgroup.events','cgroup.procs'])try{sample[key]=fs.readFileSync(path.join(snapshot.dir,key),'utf8').trim()}catch(e){if(e.code!=='ENOENT')throw e}",
                        'const sample=readCgroupSample(snapshot.dir,{elapsedMs:Date.now()-started});')
            text = once(text, "function phases(){const p=path.join(E,'engine-phases.jsonl');return fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\\n').filter(Boolean).map(v=>JSON.parse(v)):[]}",
                        "const nextPhases=phaseReader(path.join(E,'engine-phases.jsonl')),phaseCache=[];\nfunction phases(){phaseCache.push(...nextPhases());return phaseCache}")
            text = once(text, "async function ready(control){const until=Date.now()+15000;while(!fs.existsSync(control.ready)&&Date.now()<until)await sleep(10);assert(fs.existsSync(control.ready),'phase barrier not reached');return JSON.parse(fs.readFileSync(control.ready,'utf8'))}",
                        "async function ready(control){return waitForJSON(control.ready)}")
            text = once(text, "return {message:e.message,code:e.code,containerId:e.containerId,containerName:e.containerName,",
                        "return {message:e.message,stack:e.stack,code:e.code,containerId:e.containerId,containerName:e.containerName,")
            text = once(text, "assert(r.exitCode===1,'container absence uncertain/present (exit '+r.exitCode+')');",
                        "assert(r.exitCode===1&&!r.stdout&&!r.stderr&&!r.signal&&!r.killed,'container absence uncertain/present (exit '+r.exitCode+')');")
            text = once(text, "signal:e.signal}}", "signal:e.signal,killed:e.killed}}")
            text = once(text, "hand=await ready(control);const item=currentCreates(offset).find(v=>v.id);",
                        "hand=await ready(control);controller.abort(Error('real '+phase+' '+where+' barrier cancellation'));log('phase-race-handshakes.jsonl',{label,hand,abortAt:new Date().toISOString()});const item=currentCreates(offset).find(v=>v.id);")
            text = once(text, "controller.abort(Error('real '+phase+' '+where+' barrier cancellation'));log('phase-race-handshakes.jsonl',{label,hand,abortAt:new Date().toISOString()});release(control);",
                        'release(control);')
            text = once(text, 'let original,config,returned,identity;', 'let original,config,returned,identity,configurationIdentity;')
            text = once(text, 'config=hand.config;assert(config&&config.startsWith', 'config=hand.config;configurationIdentity=hand.configRootIdentity;assert(config&&config.startsWith')
            text = once(text, "assert(parent.startsWith('/tmp/chatspace-engine-config-')&&fs.lstatSync(parent).uid===process.getuid(),'retained config owner mismatch');",
                        "const stat=fs.lstatSync(parent,{bigint:true});assert(parent.startsWith('/tmp/chatspace-engine-config-')&&stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===BigInt(process.getuid())&&configurationIdentity&&String(stat.dev)===configurationIdentity.dev&&String(stat.ino)===configurationIdentity.ino,'retained config identity mismatch');")
            text = once(text, 'async function observedTask(label,code,options={}){', '''function initializedInspection(offset,id){
 const records=phases().slice(offset);
 const call=records.find(v=>v.event==='invoke'&&v.phase==='container'&&v.argv.includes('{{json .}}')&&v.argv.at(-1)===id);
 const saved=call&&records.find(v=>v.call===call.call&&v.event==='control-output-saved');
 if(!saved)return null;assert(path.dirname(saved.file)===E,'inspection artifact outside evidence root');
 const value=readJSON(saved.file);assert(value.Id===id,'initialized inspection ID mismatch');return value;
}
async function observedTask(label,code,options={}){''')
            text = once(text, 'if(item){const inspected=await inspect(item.id);if(inspected&&inspected.State.Running){', '''if(item){
   if(!snapshot){const initialized=initializedInspection(offset,item.id);if(initialized){snapshot=cgroupSnapshot(initialized);write(label+'-initialized.json',{inspection:initialized,snapshot,elapsedMs:Date.now()-started})}}
   let identity=null;try{if(snapshot)identity=processIdentity(snapshot.pid)}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}
   const startedPhase=phases().slice(offset).some(v=>v.event==='invoke'&&v.phase==='start'&&v.argv.at(-1)===item.id);
   // Observe the known initialized PID before issuing a live Podman query. This
   // avoids repeatedly spawning a control CLI while initialization is in flight.
   const nodeLive=startedPhase&&identity&&identity.startTime===snapshot.starttime&&identity.command==='node'&&!['Z','X','x'].includes(identity.state);
   const inspected=nodeLive&&!live?await inspect(item.id):live;
   if(inspected&&inspected.State.Running){''')
            text = once(text, "const saved={label,id:item&&item.id,name:item&&item.name,started,", "const taskPhases=phases().slice(offset),createPhase=taskPhases.find(v=>v.event==='invoke'&&v.phase==='create'),startPhase=taskPhases.find(v=>v.event==='invoke'&&v.phase==='start');\n const saved={label,timings:{budgetMs:options.timeoutMs||10000,createAt:createPhase&&createPhase.at,startAt:startPhase&&startPhase.at,createToStartMs:startPhase&&createPhase?Date.parse(startPhase.at)-Date.parse(createPhase.at):null},id:item&&item.id,name:item&&item.name,started,")
            text = once(text, 'save();process.exitCode=records.some(v=>v.status===\'FAIL\')?1:0;', '''await check(7,'separate acknowledged live timeout positive (original 4s result retained)',async()=>{
  const label='timeout-live-positive';
  const code="require('fs').writeFileSync('/workspace/timeout-live-positive.marker',String(process.pid));setTimeout(()=>{},30000)";
  const v=await observedTask(label,code,{timeoutMs:10000});
  if(!v.live)throw blocked('no acknowledged live timeout positive');
  assert(fs.existsSync(path.join(workspace,label+'.marker')),'live timeout marker absent');
  assert(!v.result.ok&&/timed out/.test(v.result.error.message)&&v.result.error.code!=='RESTRICTED_CANCELLATION_UNCONFIRMED','live timeout did not fail with confirmed cleanup');
  return v.saved;
 });
 save();process.exitCode=requiredResultsExitCode(records,18);''')

        if name == 'query-error-audit-r8.js':
            text = once(text, "const until=Date.now()+15000;while(!fs.existsSync(control.ready)&&Date.now()<until)await delay(20);assert(fs.existsSync(control.ready),'exists barrier missing');const hand=JSON.parse(fs.readFileSync(control.ready));",
                        'const hand=await waitForJSON(control.ready,30000);')
            text = once(text, "return {message:e.message,code:e.code,containerId:e.containerId,",
                        "return {message:e.message,stack:e.stack,code:e.code,containerId:e.containerId,")
            text = once(text, "stderr:e.stderr||''}}", "stderr:e.stderr||'',signal:e.signal,killed:e.killed}}")
            text = once(text, "assert(before.exit===0||before.exit===1,'recovery query uncertain');",
                        "assert(before.exit===0||(before.exit===1&&!before.stdout&&!before.stderr&&!before.signal&&!before.killed),'recovery query uncertain');")
            text = once(text, "assert(after.exit===1,'recovery absence uncertain');",
                        "assert(after.exit===1&&!after.stdout&&!after.stderr&&!after.signal&&!after.killed,'recovery absence uncertain');")
            text = once(text, 'let original,config,id;', 'let original,config,id,configurationIdentity;')
            text = once(text, "config=hand.config;assert(/^[a-f0-9]{64}$/.test(id)", "config=hand.config;configurationIdentity=hand.configRootIdentity;assert(/^[a-f0-9]{64}$/.test(id)")
            text = once(text, "assert(dir.startsWith('/tmp/chatspace-engine-config-')&&fs.lstatSync(dir).uid===1000,'retained config owner mismatch');",
                        "const stat=fs.lstatSync(dir,{bigint:true});assert(dir.startsWith('/tmp/chatspace-engine-config-')&&stat.isDirectory()&&!stat.isSymbolicLink()&&stat.uid===1000n&&configurationIdentity&&String(stat.dev)===configurationIdentity.dev&&String(stat.ino)===configurationIdentity.ino,'retained config identity mismatch');")
            text = once(text, 'const correct=!result.ok', 'let correct=!result.ok')
            text = once(text, '&&configRetained&&!probe.available;', '&&configRetained&&inputRetained&&outputRetained&&!probe.available;')
            text = once(text, "exit=phases.find(v=>v.call===hand.call&&v.event==='exit');", "exit=phases.find(v=>v.call===hand.call&&v.event==='exit');correct=correct&&!!invocation&&!!exit&&exit.code!==0&&!!exit.stderr;")

        if name == 'task-mount-race-r8.js':
            text = once(text, "async function ready(c){const end=Date.now()+15000;while(!fs.existsSync(c.ready)&&Date.now()<end)await wait(10);if(!fs.existsSync(c.ready))throw Error('real '+c.phase+' '+c.where+' phase handshake absent');return JSON.parse(fs.readFileSync(c.ready))}",
                        'async function ready(c){return waitForJSON(c.ready)}')
            text = once(text, 'const m=require(SOURCE);', 'let m;')
            text = once(text, "if(crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex')!==EXPECTED)throw Error('source hash gate failed');",
                        "if(crypto.createHash('sha256').update(fs.readFileSync(SOURCE)).digest('hex')!==EXPECTED)throw Error('source hash gate failed');m=require(SOURCE);")

        if name == 'workspace-bind-audit-r8.js':
            text = once(text, "async function ready(plan){const until=Date.now()+15000;while(!fs.existsSync(plan.ready)&&Date.now()<until)await sleep(10);assert(fs.existsSync(plan.ready),'real '+plan.where+' init barrier not reached');return JSON.parse(fs.readFileSync(plan.ready,'utf8'))}",
                        'async function ready(plan){return waitForJSON(plan.ready)}')

        if name in ['task-files-targeted-r8.js', 'task-file-limits-r8.js']:
            imports = 'RestrictedTaskFiles,RootlessPodmanExecutor' if 'targeted' in name else 'RestrictedTaskFiles'
            text = once(text, 'const {' + imports + "}=require('./restrictedExecutor.js');", 'let ' + imports + ';')
            gate = "ck(process.env.AGENT_SHARING_GUEST_READY===round,'guest marker');" if 'targeted' in name else "ck(crypto.createHash('sha256').update(bytes).digest('hex')===expected,'source hash');"
            text = once(text, gate, gate + "({" + imports + "}=require('./restrictedExecutor.js'));")
            text = text.replace('length===42440', 'length===' + str(len(source)))

        if name == 'tmpfs-exhaustion-r8.py':
            text = once(text, "root=pathlib.Path('/home/ubuntu/agent-sharing-output-store-" + round_id + "')",
                        "root=pathlib.Path(os.environ['AGENT_SHARING_OUTPUT_STORE'])")
            text = once(text, "pathlib.Path('/home/ubuntu/agent-sharing-rounds/" + round_id + "/evidence/tmpfs-exhaustion-results.json')",
                        "(pathlib.Path(__file__).resolve().parent/'evidence/tmpfs-exhaustion-results.json')")
            text = once(text, 'import errno,json,os,pathlib,stat', '''import errno,json,os,pathlib,stat,atexit,uuid
round_dir=pathlib.Path(__file__).resolve().parent
metadata=json.loads((round_dir/'verification-round.json').read_text())
assert pathlib.Path('/etc/agent-sharing-verification-guest').read_text().strip()==metadata['roundId']
lock=round_dir/'.driver-lock.json';temporary=round_dir/('.driver-lock-'+uuid.uuid4().hex+'.tmp')
try:
 with temporary.open('x') as stream:
  os.chmod(temporary,0o600);stream.write(json.dumps({'pid':os.getpid(),'roundId':metadata['roundId']})+'\\n')
 os.link(temporary,lock)
finally:
 temporary.unlink(missing_ok=True)
lock_stat=os.lstat(lock)
def release_lock():
 current=os.lstat(lock)
 if stat.S_ISREG(current.st_mode) and current.st_dev==lock_stat.st_dev and current.st_ino==lock_stat.st_ino:
  lock.unlink()
atexit.register(release_lock)''')

        text = text.replace("['rm','--force','--ignore',", "['rm','--force','--time=0','--ignore',")
        # Never destroy staging after a failed/unknown create or uncertain removal.
        import re
        text = re.sub(r'\b(files|aggregate|count|taskFiles)\.cleanup\(\)', r'cleanupTaskFiles(\1)', text)
        output_name = numbered(name)
        write(output_name, text)
        patch = ''.join(difflib.unified_diff(data.decode().splitlines(True), text.splitlines(True),
                                           fromfile='originals/' + original_name, tofile=output_name))
        write('patches/' + output_name + '.patch', patch)

    write('restrictedExecutor.js', source)
    if b"require('./executorCgroup')" in source:
        write('executorCgroup.js', subprocess.check_output(['git', 'show', commit + ':src/shared/executorCgroup.js'], cwd=ROOT))
    if b"require('./executorHostPolicy')" in source:
        write('executorHostPolicy.js', subprocess.check_output(['git', 'show', commit + ':src/shared/executorHostPolicy.js'], cwd=ROOT))
    if b"require('./restricted-seccomp.json')" in source:
        write('restricted-seccomp.json', subprocess.check_output(['git', 'show', commit + ':src/shared/restricted-seccomp.json'], cwd=ROOT))
        for attribution in ['NOTICE', 'LICENSE']:
            write('restricted-seccomp.' + attribution, subprocess.check_output(['git', 'show', commit + ':src/shared/restricted-seccomp.' + attribution], cwd=ROOT))
    write('consumer-reference.js', consumer)
    consumer_harness = retained('originals/consumer-only-harness.js')
    write('originals/consumer-only-harness.js', consumer_harness)
    consumer_text = once(consumer_harness.decode(), 'laptop independent consumer-only real filesystem;',
                         'dedicated guest independent consumer-only real filesystem;')
    write('consumer-only-harness.js', once(consumer_text, "'use strict';", "'use strict';\nrequire('./protocol').acquireDriverLock(__dirname);"))
    for name in ['protocol.js', 'podman-phase-recorder.js', 'task-files-cleanup.js', 'workspace-race-worker.js']:
        write(name, (pathlib.Path(__file__).parent / name).read_bytes())
    write('executor.patch', subprocess.check_output(['git', 'diff', 'd03aaecf7791fd5e76c31690f1f711c4e1d2ef62', commit, '--', 'src/shared/restrictedExecutor.js'], cwd=ROOT))
    write('verification-round.json', json.dumps({'roundId': round_id, 'previousRoundId': previous_round,
          'roundNumber': args.number,
          'sourceCommit': commit, 'sourceSha256': source_hash, 'sourceBytes': len(source),
          'diagnosticOnly': True, 'consumerSha256': CONSUMER_HASH}, indent=2) + '\n')
    runbook = (pathlib.Path(__file__).parent / 'RUNBOOK.md').read_text()
    write('RUNBOOK.md', numbered(runbook).replace('Round 8', 'Round ' + str(args.number)))
    write('developer-review.md', (ROOT / 'docs/AGENT_SHARING_ROUND_7_REVIEW.md').read_bytes())
    for name, before in previous_files.items():
        updated_name = numbered(name, previous_number)
        after_path = payload / updated_name
        if not after_path.is_file() or name.startswith(('originals/', 'patches/')):
            continue
        after = after_path.read_bytes()
        if before != after:
            retained_name = 'originals/previous-packet/' + name
            write(retained_name, before)
            patch = ''.join(difflib.unified_diff(before.decode().splitlines(True), after.decode().splitlines(True),
                                               fromfile=retained_name, tofile=updated_name))
            write('patches/previous-packet/' + updated_name + '.patch', patch)
    manifest = {}
    for file in sorted(payload.rglob('*')):
        if file.is_file():
            data = file.read_bytes()
            manifest[file.relative_to(payload).as_posix()] = {'bytes': len(data), 'sha256': digest(data)}
    assert len(manifest) < 256 and sum(item['bytes'] for item in manifest.values()) < 16 * 1024 * 1024
    write('artifact-manifest.json', json.dumps(manifest, indent=2) + '\n')
    archive = args.destination / ('agent-sharing-round' + str(args.number) + '.tar.gz')
    with tarfile.open(archive, 'w:gz') as stream:
        for file in sorted(payload.rglob('*')):
            if file.is_file():
                assert not file.is_symlink()
                stream.add(file, arcname=file.relative_to(payload).as_posix(), recursive=False)
    os.chmod(archive, 0o600)
    print(json.dumps({'destination': str(args.destination), 'roundId': round_id,
                      'sourceCommit': commit, 'sourceSha256': source_hash, 'sourceBytes': len(source),
                      'archiveBytes': archive.stat().st_size, 'archiveSha256': digest(archive.read_bytes()),
                      'manifestEntries': len(manifest)}, indent=2))


if __name__ == '__main__':
    main()
