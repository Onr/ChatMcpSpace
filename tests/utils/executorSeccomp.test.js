const profile = require('../../src/shared/restricted-seccomp.json');
// Complete actual no-capability Podman 4.9.3 OCI filter, independently retained
// from Round13 before the new restriction. This is provenance, not engine proof.
const baseline = require('../fixtures/sharedSeccompBaseline.json');

function socketAction(policy, domain, protocol) {
  const values = [domain, 1, protocol];
  const matches = policy.syscalls.filter(rule => rule.names.includes('socket') &&
    (rule.args || []).every(arg => arg.op === 'SCMP_CMP_EQ' ? values[arg.index] === arg.value :
      arg.op === 'SCMP_CMP_NE' && values[arg.index] !== arg.value));
  // The reviewed rules contain only allow/errno, with errno taking precedence.
  return matches.some(rule => rule.action === 'SCMP_ACT_ERRNO') ? 'SCMP_ACT_ERRNO' :
    matches.some(rule => rule.action === 'SCMP_ACT_ALLOW') ? 'SCMP_ACT_ALLOW' : policy.defaultAction;
}

test('keeps default denial and narrows only socket creation and the multiplexed ABI', () => {
  expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
  expect(profile.defaultErrnoRet).toBe(baseline.defaultErrnoRet);
  expect(profile.architectures).toEqual(['SCMP_ARCH_X86_64']);
  const unrelated = policy => policy.syscalls.map(rule => ({ ...rule,
    names: rule.names.filter(name => !['socket', 'socketcall'].includes(name))
  })).filter(rule => rule.names.length);
  expect(unrelated(profile)).toEqual(unrelated(baseline));
  expect(profile.syscalls.some(rule => rule.names.includes('socketcall'))).toBe(false);
  expect(profile.syscalls.some(rule => rule.names.some(name => name.startsWith('io_uring')))).toBe(false);
  expect(profile.syscalls.some(rule => rule.action === 'SCMP_ACT_ALLOW' && rule.names.includes('socketpair'))).toBe(true);
  for (let domain = 0; domain <= 64; domain++) for (let protocol = 0; protocol <= 10; protocol++) {
    if (socketAction(profile, domain, protocol) === 'SCMP_ACT_ALLOW') {
      expect(socketAction(baseline, domain, protocol)).toBe('SCMP_ACT_ALLOW');
    }
  }
});

test.each([1, 17, 38, 40])('denies Unix/packet/crypto/host-vsock family %s regardless of protocol', domain => {
  for (let protocol = 0; protocol <= 10; protocol++) expect(socketAction(profile, domain, protocol)).toBe('SCMP_ACT_ERRNO');
});

test('retains isolated IP and netlink queries without granting the audit channel', () => {
  expect(socketAction(profile, 2, 0)).toBe('SCMP_ACT_ALLOW');
  expect(socketAction(profile, 10, 0)).toBe('SCMP_ACT_ALLOW');
  expect(socketAction(profile, 16, 0)).toBe('SCMP_ACT_ALLOW');
  expect(socketAction(profile, 16, 9)).toBe('SCMP_ACT_ERRNO');
});
