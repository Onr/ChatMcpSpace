const fs = require('fs');
const { assertSafeCoreDumpPolicy } = require('../../src/shared/executorHostPolicy');

afterEach(() => jest.restoreAllMocks());

function modeledPolicy(text) {
  let cursor = 0;
  const open = jest.spyOn(fs, 'openSync').mockReturnValue(87);
  const stat = jest.spyOn(fs, 'fstatSync').mockReturnValue({ isFile: () => true, uid: 0 });
  const statfs = jest.spyOn(fs, 'statfsSync').mockReturnValue({ type: 0x9fa0 });
  const read = jest.spyOn(fs, 'readSync').mockImplementation((_fd, bytes, offset, length) => {
    const source = Buffer.from(text), n = Math.min(7, length, source.length - cursor);
    if (n) source.copy(bytes, offset, cursor, cursor + n);
    cursor += n; return n;
  });
  const close = jest.spyOn(fs, 'closeSync').mockImplementation(() => {});
  return {open,stat,statfs,read,close};
}

test.each(['core\n', 'core.%p\n', '/tmp/core.%p\n', '\n'])('accepts bounded non-piped kernel patterns %j', text => {
  const fixture = modeledPolicy(text);
  expect(() => assertSafeCoreDumpPolicy()).not.toThrow();
  expect(fixture.open).toHaveBeenCalledWith('/proc/sys/kernel/core_pattern',
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  expect(fixture.close).toHaveBeenCalledWith(87);
});

test.each(['|/fake/handler %p\n', '|/fake/handler\n', 'x'.repeat(129) + '\n', 'core', 'core\nother\n', 'core\0\n', 'core\r\n', 'cöré\n'])('denies external, oversized or ambiguous patterns %j', text => {
  const fixture = modeledPolicy(text);
  expect(() => assertSafeCoreDumpPolicy()).toThrow('without external crash handlers');
  expect(fixture.close).toHaveBeenCalledWith(87);
});

test.each(['owner', 'type', 'filesystem', 'read', 'stat'])('fails closed on uncertain %s metadata', kind => {
  const f = modeledPolicy('core\n');
  if (kind === 'owner') f.stat.mockReturnValue({isFile:()=>true,uid:1000});
  if (kind === 'type') f.stat.mockReturnValue({isFile:()=>false,uid:0});
  if (kind === 'filesystem') f.statfs.mockReturnValue({type:0xef53});
  if (kind === 'read') f.read.mockImplementation(()=>{throw Object.assign(Error('fake private diagnostic'),{code:'EIO'})});
  if (kind === 'stat') f.stat.mockImplementation(()=>{throw Error('fake private diagnostic')});
  expect(() => assertSafeCoreDumpPolicy()).toThrow('verified host core policy');
  expect(f.close).toHaveBeenCalledWith(87);
});

test('actual host procfs policy is refused when it pipes to a collector', () => {
  const pattern = fs.readFileSync('/proc/sys/kernel/core_pattern','utf8');
  if (pattern.startsWith('|')) expect(() => assertSafeCoreDumpPolicy()).toThrow('external crash handlers');
  else expect(() => assertSafeCoreDumpPolicy()).not.toThrow();
});
