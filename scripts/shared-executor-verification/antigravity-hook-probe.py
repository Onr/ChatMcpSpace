#!/usr/bin/env python3
"""Bounded native configuration observation; never a guest/runtime release pass."""
import hashlib
import json
import os
import pathlib
import selectors
import signal
import stat
import subprocess
import sys
import time

CLI = pathlib.Path('/home/ubuntu/agent-sharing-auth/antigravity/cli-1.2.15/agy')
CLI_HASH = '5f9c16b286895f8f7fdecd423883ca256a85077b8acf9a6bc1111761d34df164'
MODE = sys.argv[1] if len(sys.argv) == 2 else 'lifecycle'
assert MODE in ['lifecycle', 'allow', 'deny', 'malformed', 'timeout', 'nonzero', 'missing', 'mcp_allow', 'mcp_deny'] and len(sys.argv) <= 2
ROOT = pathlib.Path('/home/ubuntu/agent-sharing-auth/antigravity/hook-probe-v17-20261008-' + MODE)
CANARY = 'INVENTED_NATIVE_HOOK_CANARY_20261008'
MODEL = 'gemini-3.8-flash-low'
AGENT = 'sharing-hook-probe'
FIXTURE_PERMISSIONS_SHA = '75a542c06c5880121b6bbb73a9aad4a13b09343f9c5a0a7c9b8bcb25594b3ebf'


def owned_fixture_permissions():
    # Refuse existing owner configuration without reading it. Only the exact
    # public policy created for this diagnostic may be inspected.
    target = pathlib.Path('/home/ubuntu/.gemini/antigravity-cli/settings.json')
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        return None
    receipt_path = pathlib.Path('/home/ubuntu/agent-sharing-auth/antigravity/native-fixture-permission-receipt-20261008.json')
    fd = os.open(receipt_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        receipt_stat = os.fstat(fd)
        assert stat.S_ISREG(receipt_stat.st_mode) and receipt_stat.st_uid == 1000 and receipt_stat.st_nlink == 1 and receipt_stat.st_size <= 1024
        receipt = json.loads(os.read(fd, 1025))
    finally:
        os.close(fd)
    assert receipt['path'] == str(target) and receipt['sha256'] == FIXTURE_PERMISSIONS_SHA and receipt['nativeGlobalFileWasAbsent'] is True
    assert stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_uid == 1000 and stat.S_IMODE(metadata.st_mode) == 0o400
    assert str(metadata.st_dev) == receipt['dev'] and str(metadata.st_ino) == receipt['ino'] and metadata.st_size == receipt['bytes'] == 257
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(fd)
        assert opened.st_dev == metadata.st_dev and opened.st_ino == metadata.st_ino
        content = os.read(fd, 258)
        assert len(content) == 257 and hashlib.sha256(content).hexdigest() == FIXTURE_PERMISSIONS_SHA
        after = os.fstat(fd)
        assert (after.st_size, after.st_mtime_ns, after.st_ctime_ns) == (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
    finally:
        os.close(fd)
    return FIXTURE_PERMISSIONS_SHA


def main():
    assert os.getuid() == os.getgid() == 1000
    assert subprocess.check_output(['systemd-detect-virt', '--vm'], text=True).strip() == 'kvm'
    metadata = CLI.lstat()
    assert stat.S_ISREG(metadata.st_mode) and not CLI.is_symlink() and metadata.st_uid == 1000
    with CLI.open('rb') as file:
        digest = hashlib.file_digest(file, 'sha256').hexdigest()
    assert digest == CLI_HASH
    fixture_permission_sha = owned_fixture_permissions()
    assert not ROOT.exists()
    ROOT.mkdir(mode=0o700)
    agents = ROOT / '.agents' / 'agents'
    agents.mkdir(mode=0o700, parents=True)
    if MODE != 'lifecycle':
        (ROOT / 'canary.txt').write_text(CANARY)
        (ROOT / 'canary.txt').chmod(0o400)
    mcp = MODE.startswith('mcp_')
    if mcp:
        # A static, invented response tests native MCP routing only. It never
        # reads a workspace, credentials or a real server/task/grant.
        server = ROOT / 'mcp-probe.py'
        server.write_text('CANARY=' + repr(CANARY) + '\n' + '''import json,sys,os,pathlib
fields=pathlib.Path('/proc/self/stat').read_text().rpartition(') ')[2].split()
identity={'pid':os.getpid(),'startTime':fields[19]}
with pathlib.Path(__file__).with_name('mcp-identity.json').open('x') as file:
    os.chmod(file.fileno(),0o600)
    json.dump(identity,file)
calls=0
for number in range(32):
    line=sys.stdin.buffer.readline(65537)
    if not line: break
    if len(line)>65536 or not line.endswith(b'\\n'): sys.exit(2)
    try:
        request=json.loads(line)
        assert isinstance(request,dict) and request.get('jsonrpc')=='2.0'
        if 'id' not in request: continue
        method=request.get('method')
        with pathlib.Path(__file__).with_name('mcp-events.jsonl').open('a') as file:
            file.write(json.dumps({'method':method if method in ['initialize','ping','tools/list','tools/call'] else 'unsupported'})+'\\n')
        if method=='initialize':
            version=request.get('params',{}).get('protocolVersion')
            import datetime
            assert isinstance(version,str) and len(version)==10
            datetime.date.fromisoformat(version)
            assert version=='2025-11-25'
            with pathlib.Path(__file__).with_name('mcp-events.jsonl').open('a') as file:
                file.write(json.dumps({'requestedProtocolVersion':version})+'\\n')
            result={'protocolVersion':version,'capabilities':{'tools':{}},'serverInfo':{'name':'shared_broker','version':'fixture-only'}}
        elif method=='ping': result={}
        elif method=='tools/list':
            result={'tools':[{'name':'read_fixture','description':'Read one invented configuration canary.',
                'inputSchema':{'type':'object','properties':{'fixture':{'type':'string','enum':['canary']}},'required':['fixture'],'additionalProperties':False},
                'outputSchema':{'type':'object','properties':{'text':{'type':'string','maxLength':128}},'required':['text'],'additionalProperties':False}}]}
        elif method=='tools/call':
            value=request.get('params',{})
            valid=value.get('name')=='read_fixture' and value.get('arguments')=={'fixture':'canary'} and calls==0
            if valid: calls+=1
            with pathlib.Path(__file__).with_name('mcp-events.jsonl').open('a') as file:
                file.write(json.dumps({'exactFixtureCall':valid,'callCount':calls})+'\\n')
            text=CANARY if valid else 'Fixture denied'
            result={'content':[{'type':'text','text':text}],'structuredContent':{'text':text},'isError':not valid}
        else:
            print(json.dumps({'jsonrpc':'2.0','id':request['id'],'error':{'code':-32601,'message':'Unsupported fixture method'}}),flush=True)
            continue
        print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}),flush=True)
    except Exception: sys.exit(2)
''')
        server.chmod(0o400)
    hook = ROOT / 'guard.py'
    hook.write_text('MODE=' + repr(MODE) + '\nCANARY=' + repr(CANARY) + '\n' + '''import json,sys,pathlib
try:
    value=json.load(sys.stdin)
    # Record only a hook name; never tool arguments, transcript paths or data.
    event=sys.argv[1]
    with pathlib.Path(__file__).with_name('hook-events.jsonl').open('a') as file:
        call=value.get('toolCall',{})
        file.write(json.dumps({'event':event,'canaryInHookInput':CANARY in json.dumps(value),
            'topLevelKeys':sorted(value.keys()),'toolCallKeys':sorted(call.keys()) if isinstance(call,dict) else [],
            'ownedCanaryTarget':isinstance(call,dict) and call.get('name')=='view_file' and call.get('args',{}).get('AbsolutePath')==str(pathlib.Path(__file__).with_name('canary.txt')),
            'toolReportedError':bool(value.get('error')),
            'argumentKeys':sorted(call.get('args',{}).keys()) if isinstance(call,dict) and isinstance(call.get('args'),dict) else [],
            'mcpFixtureTarget':isinstance(call,dict) and call.get('name')=='call_mcp_tool' and isinstance(call.get('args'),dict) and call['args'].get('ServerName')=='shared_broker' and call['args'].get('ToolName')=='read_fixture',
            'mcpFixtureName':call.get('name') if isinstance(call,dict) and isinstance(call.get('name'),str) and len(call['name'])<=160 and isinstance(call.get('args'),dict) and call['args'].get('ServerName')=='shared_broker' else None,
            'mcpArgumentType':type(call.get('args',{}).get('Arguments')).__name__ if isinstance(call,dict) and isinstance(call.get('args'),dict) else None,
            'mcpServerMatched':isinstance(call,dict) and isinstance(call.get('args'),dict) and call['args'].get('ServerName')=='shared_broker',
            'mcpToolMatched':isinstance(call,dict) and isinstance(call.get('args'),dict) and call['args'].get('ToolName')=='read_fixture',
            'mcpFixtureArgumentsMatched':isinstance(call,dict) and isinstance(call.get('args'),dict) and call['args'].get('Arguments')=={'fixture':'canary'},
            'mcpFixtureArgumentKeys':sorted(call['args']['Arguments']) if isinstance(call,dict) and isinstance(call.get('args'),dict) and isinstance(call['args'].get('Arguments'),dict) else []})+'\\n')
    if event=='PreInvocation':
        print(json.dumps({}))
    elif event=='PostInvocation':
        print(json.dumps({'terminationBehavior':'terminate'} if MODE=='lifecycle' else {}))
    elif event=='PostToolUse':
        print(json.dumps({}))
    else:
        call=value.get('toolCall',{})
        args=call.get('args',{})
        target=call.get('name')=='view_file' and isinstance(args,dict) and set(args).issubset({'AbsolutePath','toolAction','toolSummary'}) and args.get('AbsolutePath')==str(pathlib.Path(__file__).with_name('canary.txt'))
        if MODE.startswith('mcp_'):
            target=call.get('name')=='call_mcp_tool' and isinstance(args,dict) and args.get('ServerName')=='shared_broker' and args.get('ToolName')=='read_fixture' and args.get('Arguments')=={'fixture':'canary'} and set(args).issubset({'ServerName','ToolName','Arguments','toolAction','toolSummary'})
            with pathlib.Path(__file__).with_name('hook-events.jsonl').open('a') as file:
                file.write(json.dumps({'event':'FixtureMcpDecision','allowed':MODE=='mcp_allow' and target})+'\\n')
            print(json.dumps({'decision':'allow' if MODE=='mcp_allow' and target else 'deny','reason':'Controlled native MCP configuration probe',
                'permissionOverrides':['mcp(shared_broker/read_fixture)'] if MODE=='mcp_allow' and target else []}))
            sys.exit(0)
        if MODE=='timeout' and target:
            import time
            time.sleep(5)
            print(json.dumps({'decision':'deny'}))
        elif MODE=='nonzero' and target:
            sys.exit(7)
        elif MODE=='malformed' and target:
            print('deliberately-invalid-hook-json')
        else:
            print(json.dumps({'decision':'allow' if MODE=='allow' and target else 'deny','reason':'Controlled native configuration probe'}))
except Exception:
    print(json.dumps({'decision':'deny','terminationBehavior':'terminate'}))
    sys.exit(1)
''')
    hook.chmod(0o400)
    handlers = {event: {'type': 'command', 'command': 'python3 ' + str(hook) + ' ' + event, 'timeout': 2}
                for event in ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse']}
    config = {'sharing-probe': {'PreInvocation': [handlers['PreInvocation']], 'PostInvocation': [handlers['PostInvocation']],
        'PreToolUse': [{'matcher': '*', 'hooks': [handlers['PreToolUse']]}],
        'PostToolUse': [{'matcher': '*', 'hooks': [handlers['PostToolUse']]}]}}
    if MODE == 'missing':
        # Only the pre-tool executable is absent. Other hooks still observe
        # whether the exact invented read executes after that failure.
        config['sharing-probe']['PreToolUse'][0]['hooks'][0]['command'] = 'python3 ' + str(ROOT / 'missing-guard.py')
    (ROOT / '.agents' / 'hooks.json').write_text(json.dumps(config))
    (ROOT / '.agents' / 'hooks.json').chmod(0o400)
    definition = agents / (AGENT + '.md')
    mcp_definition = json.dumps([{'name': 'shared_broker', 'command': '/usr/bin/python3', 'args': [str(server)]}]) if mcp else '[]'
    definition.write_text('---\nname: ' + AGENT + '\ndescription: Native configuration observation\nmainAgent: true\nsubagent: false\ntools: ' + ('[]' if MODE=='lifecycle' or mcp else '[view_file]') + '\nmcpServers: ' + mcp_definition + '\nskills: []\nplugins: []\ncommandExecutionPolicy: "off"\n---\nReturn only the requested JSON. Use only the exact requested fixture tool once, then report the result. Never call any other tool, read any other file or delegate.\n')
    definition.chmod(0o400)
    assert len(list(ROOT.iterdir())) == (2 if MODE=='lifecycle' else 4 if mcp else 3)
    schema = {'type': 'object', 'properties': {'text': {'type': 'string', 'maxLength': 128}},
              'required': ['text'], 'additionalProperties': False}
    env = {'HOME': '/home/ubuntu', 'PATH': '/usr/bin:/bin', 'TERM': 'dumb', 'AGY_CLI_DISABLE_AUTO_UPDATE': 'true',
           'XDG_RUNTIME_DIR': '/run/user/1000', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus'}
    prompt = ('Return only {"text":"ready"}. Do not use tools or access files. This is a configuration probe.' if MODE=='lifecycle' else
              'Call the shared_broker MCP read_fixture tool exactly once with {"fixture":"canary"}. Return JSON {"text":"the exact tool response"}, or {"text":"denied"} if denied. Never use native tools, files or other servers.' if mcp else
              'Call view_file exactly once on ' + str(ROOT / 'canary.txt') + '. If denied, return {"text":"denied"}; otherwise return only JSON {"text":"the exact file contents"}. Never use other tools or files. This is an invented configuration canary.')
    command = [str(CLI), '--new-project', '--add-dir', str(ROOT), '--agent', AGENT, '--model', MODEL, '--effort', 'low', '--sandbox',
               '--disable-slash-commands', '--output-format', 'stream-json', '--print-timeout', '20s',
               '--json-schema', json.dumps(schema), '-p',
               prompt]
    child = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(child.stderr, selectors.EVENT_READ, 'stderr')
    output = b''
    size = 0
    reason = None
    began = time.monotonic()
    try:
        while selector.get_map():
            if time.monotonic() - began >= 30 or size > 1000000:
                reason = 'deadline' if size <= 1000000 else 'output-limit'
                break
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                size += len(chunk)
                if key.data == 'stdout' and size <= 1000000:
                    output += chunk
    finally:
        selector.close()
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=2)
        # Also stop descendants if the main process exited before the observer.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.stdout.close()
        child.stderr.close()
    events = []
    for line in output.splitlines():
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                events.append(value)
        except (ValueError, UnicodeError):
            pass
    init = next((value.get('init', {}) for value in events if value.get('event') == 'init'), {})
    result = next((value.get('result', {}) for value in reversed(events) if value.get('event') == 'result'), {})
    usage = result.get('usage', {})
    usage = {key: value for key, value in usage.items() if key in ['input_tokens', 'output_tokens', 'thinking_tokens', 'cache_read_tokens', 'total_tokens']
             and isinstance(value, int) and value >= 0} if isinstance(usage, dict) else {}
    hook_events = ROOT / 'hook-events.jsonl'
    observed = []
    if hook_events.exists():
        metadata = hook_events.lstat()
        assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 1000 and metadata.st_size <= 100000
        observed = [json.loads(line) for line in hook_events.read_text().splitlines()]
    absent = False
    for _ in range(20):
        try:
            os.killpg(child.pid, 0)
        except ProcessLookupError:
            absent = True
            break
        time.sleep(0.05)
    report = {'diagnosticOnly': True, 'mode': MODE, 'cliSha256': digest, 'agentMatched': init.get('agent') == AGENT,
              'modelMatched': init.get('model') == MODEL, 'listedNativeTools': len(init.get('tools', [])),
              'hookEvents': observed, 'resultObserved': bool(result), 'usageObserved': usage, 'canaryObservedInStream': CANARY.encode() in output,
              'exit': child.returncode, 'stopReason': reason, 'processGroupAbsent': absent,
              'elapsedMs': round((time.monotonic() - began) * 1000), 'sharedTaskExecuted': False, 'releaseReady': False}
    report['nativeFixturePermissionsSha256'] = fixture_permission_sha
    report['nativeResultStatus'] = result.get('status') if result.get('status') in ['SUCCESS', 'ERROR', 'TIMEOUT'] else 'unknown'
    report['nativeResultErrorObserved'] = bool(result.get('error'))
    report['mcpFixtureToolNames'] = [name for name in init.get('tools', []) if isinstance(name, str) and 'shared_broker' in name and len(name) <= 160]
    report['mcpToolErrorCategories'] = []
    if mcp:
        for value in events:
            info = value.get('step_update', {}).get('tool_info', {})
            parameters = info.get('parameters', {}) if isinstance(info, dict) else {}
            if not isinstance(parameters, dict) or parameters.get('ServerName') != 'shared_broker' or parameters.get('ToolName') != 'read_fixture':
                continue
            selected = json.dumps({'output': info.get('output'), 'error': info.get('error')}).lower()
            categories = [phrase for phrase in ['not found', 'not connected', 'permission', 'denied', 'not available', 'invalid argument', 'unknown tool', 'unknown server', 'invalid server'] if phrase in selected]
            report['mcpToolErrorCategories'].append({'nativeFixtureStepObserved': True, 'errorPresent': bool(info.get('error')), 'categories': categories})
    report['configurationSha256'] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                    for name in ['guard.py', '.agents/hooks.json', '.agents/agents/' + AGENT + '.md']}
    report['mcpFixtureCalls'] = []
    report['mcpProcessStoppedIndependently'] = None
    if mcp:
        for name in ['mcp-probe.py']:
            report['configurationSha256'][name] = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        events_path = ROOT / 'mcp-events.jsonl'
        if events_path.exists():
            metadata = events_path.lstat()
            assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 1000 and metadata.st_nlink == 1 and metadata.st_size <= 10000
            report['mcpFixtureCalls'] = [json.loads(line) for line in events_path.read_text().splitlines()]
        identity_path = ROOT / 'mcp-identity.json'
        if identity_path.exists():
            metadata = identity_path.lstat()
            assert stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 1000 and metadata.st_nlink == 1 and metadata.st_size <= 512
            identity = json.loads(identity_path.read_text())
            assert type(identity.get('pid')) is int and identity['pid'] > 1 and str(identity.get('startTime', '')).isdigit()
            def live_identity():
                try:
                    fields = pathlib.Path('/proc/' + str(identity['pid']) + '/stat').read_text().rpartition(') ')[2].split()
                    return fields[19] == identity['startTime'] and fields[0] not in ['Z', 'X']
                except FileNotFoundError:
                    return False
            if live_identity():
                os.kill(identity['pid'], signal.SIGTERM)
            for _ in range(20):
                if not live_identity(): break
                time.sleep(0.05)
            report['mcpProcessStoppedIndependently'] = not live_identity()
            report['mcpProcessIdentity'] = identity
            assert report['mcpProcessStoppedIndependently'], 'Exact MCP fixture process stoppage was not confirmed'
    print(json.dumps(report))
    assert absent, 'Probe process group absence was not confirmed'
    with (ROOT / 'report.json').open('x') as file:
        os.chmod(file.fileno(), 0o600)
        json.dump(report, file, indent=2)
        file.write('\n')


if __name__ == '__main__':
    main()
