const fs = require('fs');
const os = require('os');
const path = require('path');
const { options, metadataSession, bundledGeminiModels } = require('../../scripts/discover-provider-models');
test('catalog normalization keeps IDs separate from labels and rejects terminal formatting', () => {
  expect(options([{ slug: 'gpt-future', display_name: 'Future model' }, { id: '--header--' }]))
    .toEqual([{ value: 'gpt-future', label: 'Future model' }]);
});
test('framed metadata discovery never sends a user prompt and closes its child after a bounded response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-metadata-'));
  const file = path.join(dir, 'fixture.js');
  fs.writeFileSync(file, `process.stdin.once('data', data => {
    const text=data.toString(); const request=JSON.parse(text.slice(text.indexOf('\\r\\n\\r\\n')+4));
    if(request.method!=='models.list'||request.prompt)process.exit(2);
    const body=JSON.stringify({jsonrpc:'2.0',id:request.id,result:{models:[{id:'future-model',name:'Future'}]}});
    const frame='Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body;
    process.stdout.write(frame.slice(0,12));setTimeout(()=>process.stdout.write(frame.slice(12)),10);
  });`);
  try {
    await expect(metadataSession(process.execPath, [file], 'framed', [{ jsonrpc: '2.0', id: 1, method: 'models.list', params: {} }],
      message => message.result.models)).resolves.toEqual([{ value: 'future-model', label: 'Future' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Gemini metadata can be read without executing the CLI or starting OAuth', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-catalog-'));
  const cli = path.join(dir, 'cli'), bin = path.join(dir, 'bin');
  const core = path.join(cli, 'node_modules/@google/gemini-cli-core');
  try {
    fs.mkdirSync(path.join(cli, 'dist'), { recursive: true }); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ name: '@google/gemini-cli' }));
    fs.writeFileSync(path.join(cli, 'dist/index.js'), 'throw Error("This must never execute");');
    fs.symlinkSync(path.join(cli, 'dist/index.js'), path.join(bin, 'gemini'));
    fs.mkdirSync(path.join(core, 'dist/src/config'), { recursive: true });
    fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ main: 'dist/index.js' }));
    fs.writeFileSync(path.join(core, 'dist/index.js'), 'throw Error("Do not execute");');
    fs.writeFileSync(path.join(core, 'dist/src/config/models.js'), "export const MODEL = 'gemini-future'; const prefix='gemini-3-'; const embedding='gemini-embedding-001';");
    expect(bundledGeminiModels(bin)).toEqual([{ value: 'gemini-future', label: 'gemini-future' }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
