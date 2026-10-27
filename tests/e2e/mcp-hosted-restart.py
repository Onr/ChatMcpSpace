"""Isolated PostgreSQL + two fresh Node processes; never uses a real account.

Run with python3 tests/e2e/mcp-hosted-restart.py on a host with PostgreSQL 16.
The downstream agent HTTP/storage API is a scoped, local contract fixture.
"""
import email.parser
import email.policy
import hashlib
import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parents[2]
PG = pathlib.Path('/usr/lib/postgresql/16/bin')
OWNER = '10000000-0000-4000-8000-000000000001'
AGENT = '10000000-0000-4000-8000-000000000002'
GRANT = '10000000-0000-4000-8000-000000000003'
SEND = '10000000-0000-4000-8000-000000000004'
UPLOAD = '10000000-0000-4000-8000-000000000005'


def run(command, **kwargs):
    result = subprocess.run([str(part) for part in command], check=True, capture_output=True, text=True, **kwargs)
    return result.stdout


with tempfile.TemporaryDirectory(prefix='mcp-hosted-restart-') as temporary:
    directory = pathlib.Path(temporary)
    data = directory / 'postgres'
    with socket.socket() as available:
        available.bind(('127.0.0.1', 0))
        port = available.getsockname()[1]
    run([PG / 'initdb', '-D', data, '-A', 'trust', '-U', 'fixture', '--no-locale'])
    run([PG / 'pg_ctl', '-D', data, '-l', directory / 'postgres.log', '-o', f"-k {directory} -p {port} -h ''", '-w', 'start'])
    server = None
    try:
        psql = ['psql', '-h', directory, '-p', str(port), '-U', 'fixture', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt']
        for script in ['src/db/schema.sql', 'src/db/migrations/016_add_hidden_from_agent_to_messages.sql', 'src/db/migrations/018_add_agent_messages.sql', 'src/db/migrations/059_add_mcp_oauth.sql', 'src/db/migrations/061_add_mcp_message_grants.sql', 'src/db/migrations/062_add_hosted_mcp.sql']:
            run(psql + ['-f', ROOT / script])
        run(psql, input=f"""
INSERT INTO users(user_id,email,api_key,script_token,encryption_salt,email_verified)
 VALUES('{OWNER}','restart-fixture@example.test','fixture-api-key','fixture-script','fixture-salt',TRUE);
INSERT INTO agents(agent_id,user_id,agent_name,position) VALUES('{AGENT}','{OWNER}','Restart Agent',1);
INSERT INTO mcp_oauth_clients(client_id,client_name,redirect_uris) VALUES('fixture','Restart fixture','[]');
INSERT INTO mcp_oauth_tokens(access_token_hash,refresh_token_hash,client_id,user_id,resource,scope,expires_at,refresh_expires_at,grant_id,agent_id,hosted_approved)
 VALUES('fixture-access','fixture-refresh','fixture','{OWNER}','https://fixture.invalid/mcp','agents.read messages.read messages.write attachments.read attachments.write',NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '30 days','{GRANT}','{AGENT}',TRUE);
""")
        state = {'message': None, 'file': None, 'metadata': None}

        class Fixture(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def reply(self, value, status=200):
                body = value if isinstance(value, bytes) else json.dumps(value).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/octet-stream' if isinstance(value, bytes) else 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def authorized(self, scope):
                digest = hashlib.sha256(self.headers.get('X-Agent-Token', '').encode()).hexdigest()
                found = run(psql, input=f"SELECT COUNT(*) FROM agent_api_credentials WHERE token_hash='{digest}' AND agent_id='{AGENT}' AND revoked_at IS NULL AND expires_at>NOW() AND scopes_json ? '{scope}';").strip()
                if found != '1' or self.headers.get('X-Agent-Name') != 'Restart Agent':
                    self.reply({'error': {'code': 'NOT_AUTHORIZED'}}, 403)
                    return False
                return True

            def do_POST(self):
                scope = 'agent.attachments.write' if self.path.endswith('/attachments') else 'agent.messages.write'
                if not self.authorized(scope):
                    return
                body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
                if self.path.endswith('/attachments'):
                    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
                    fields = {part.get_param('name', header='content-disposition'): part.get_payload(decode=True) for part in message.iter_parts()}
                    state['file'] = fields['file']
                    state['metadata'] = {'attachmentId': UPLOAD, 'fileName': 'restart.pdf', 'contentType': 'application/pdf', 'encrypted': True, 'encryption': {'ivBase64': fields['ivBase64'].decode(), 'tagBase64': fields['authTagBase64'].decode()}}
                    self.reply(state['metadata'], 201)
                else:
                    payload = json.loads(body)
                    if state['message'] and state['message']['content'] != payload['content']:
                        self.reply({'error': {'code': 'IDEMPOTENCY_CONFLICT'}}, 409)
                        return
                    state['message'] = payload
                    self.reply({'messageId': SEND, 'status': 'sent'})

            def do_GET(self):
                if self.path.startswith('/api/agent/responses'):
                    if self.authorized('agent.responses.read'):
                        self.reply({'responses': [{'messageId': SEND, 'responseType': 'text', 'content': state['message']['content'], 'encrypted': True, 'timestamp': '2026-01-01T00:00:00Z', 'attachments': [state['metadata']]}]})
                elif self.authorized('agent.attachments.read'):
                    self.reply(state['metadata'] if self.path.endswith('/metadata') else state['file'])

        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        environment = os.environ.copy()
        environment.update(DB_HOST=str(directory), DB_PORT=str(port), DB_USER='fixture', DB_NAME='postgres', DB_PASSWORD='fixture-only', NODE_ENV='test', MCP_HOSTED_KEY_FILE=str(directory / 'wrapping-key'))
        environment.pop('MCP_HOSTED_WRAPPING_KEY', None)
        options = json.dumps({'grantId': GRANT, 'ownerId': OWNER, 'origin': f'http://127.0.0.1:{server.server_port}'})
        common = f"const service=require('./src/services/mcpHostedService'); const db=require('./src/db/connection'); const options={options};"
        first = common + f"""
(async()=>{{
 await service.enable(options.grantId,options.ownerId,Buffer.alloc(32,7).toString('base64'));
 await service.execute(options,'send_message',{{text:'Recovered after process restart',idempotencyId:'{SEND}'}});
 await service.execute(options,'upload_attachment',{{fileName:'restart.pdf',contentType:'application/pdf',dataBase64:Buffer.from('%PDF-1.7 restart file').toString('base64'),idempotencyId:'{UPLOAD}'}});
 await db.pool.end();
}})().catch(async()=>{{await db.pool.end();process.exitCode=1;}});
"""
        run(['node', '-e', first], cwd=ROOT, env=environment)
        second = common + f"""
(async()=>{{
 const inbox=await service.execute(options,'read_inbox',{{limit:10}});
 if(inbox.messages[0].content!=='Recovered after process restart')throw Error('history');
 await service.execute(options,'send_message',{{text:'Recovered after process restart',idempotencyId:'{SEND}'}});
 const file=await service.execute(options,'read_attachment',{{attachmentId:'{UPLOAD}'}});
 if(Buffer.from(file.dataBase64,'base64').toString()!=='%PDF-1.7 restart file')throw Error('file');
 await db.query('UPDATE mcp_oauth_tokens SET revoked_at=NOW() WHERE grant_id=$1',[options.grantId]);
 await service.cleanupExpired();
 if((await db.query('SELECT grant_id FROM mcp_hosted_connections')).rows.length)throw Error('key cleanup');
 let denied=false;try{{await service.execute(options,'read_inbox',{{limit:10}})}}catch(_){{denied=true}}
 if(!denied)throw Error('revocation');
 await db.pool.end();
}})().catch(async()=>{{await db.pool.end();process.exitCode=1;}});
"""
        run(['node', '-e', second], cwd=ROOT, env=environment)
        environment['SHARED_TEST_DATABASE_URL'] = f'postgresql://fixture@localhost:{port}/postgres?host={urllib.parse.quote(str(directory), safe="")}'
        run(['node', 'node_modules/jest/bin/jest.js', '--runInBand', 'tests/integration/sharedA2a.test.js'], cwd=ROOT, env=environment)
        print('PASS: PostgreSQL migrations; hosted message/file recovery in two fresh Node processes; stable retry; revoked-key cleanup; real shared-peer authorization suite.')
    except subprocess.CalledProcessError as error:
        print(error.stdout)
        print(error.stderr)
        raise
    finally:
        if server:
            server.shutdown()
            server.server_close()
        run([PG / 'pg_ctl', '-D', data, '-m', 'immediate', '-w', 'stop'])
