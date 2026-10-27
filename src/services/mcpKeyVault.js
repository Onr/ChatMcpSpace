const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function masterKey(create = false) {
  if (process.env.MCP_HOSTED_WRAPPING_KEY) {
    const key = Buffer.from(process.env.MCP_HOSTED_WRAPPING_KEY, 'base64');
    if (key.length !== 32 || key.toString('base64') !== process.env.MCP_HOSTED_WRAPPING_KEY) throw new Error('MCP_HOSTED_WRAPPING_KEY must encode exactly 32 random bytes.');
    return key;
  }
  // A durable, private file supplies a restart-stable default for a single host.
  // Replicas/ephemeral hosts must configure the same secret or a shared volume.
  const file = process.env.MCP_HOSTED_KEY_FILE || path.join(os.homedir(), '.chatmcpspace', 'mcp-hosted', 'wrapping-key');
  const directory = path.dirname(file);
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = fs.lstatSync(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077)) throw new Error('The MCP hosted key directory must be private (mode 0700).');
  if (create) try {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, crypto.randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { if (error.code !== 'EEXIST') throw new Error('The MCP hosted wrapping key could not be created.'); }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.size !== 32 || info.uid !== process.getuid?.()) throw new Error('The MCP hosted wrapping key file must be private and owned by this service.');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function seal(bytes, key, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(item => item.toString('base64')).join(':');
}
function open(value, key, aad = '') {
  const parts = String(value).split(':');
  if (parts.length !== 3) throw new Error('Encrypted content is invalid.');
  const [iv, tag, data] = parts.map(item => Buffer.from(item, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Encrypted content is invalid.');
  const cipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function identity(grant) { return `chatmcp.hosted.v1:${grant.user_id}:${grant.agent_id}:${grant.grant_id}`; }
function wrap(key, grant) {
  const master = masterKey(true);
  try { return seal(key, master, identity(grant)); } finally { master.fill(0); }
}
function unwrap(value, grant) {
  const master = masterKey();
  try {
    const key = open(value, master, identity(grant));
    if (key.length !== 32) { key.fill(0); throw new Error('Hosted encryption key is invalid.'); }
    return key;
  } finally { master.fill(0); }
}
module.exports = { seal, open, wrap, unwrap };
