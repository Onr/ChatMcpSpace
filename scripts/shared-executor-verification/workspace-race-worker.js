#!/usr/bin/env node
'use strict';

// Disposable fixture worker only: no executor import, engine command or evidence
// stream from the main driver. The live parent must hold the private round lock.
const fs = require('fs');
const path = require('path');
const { joinDriver, publishJSON, processIdentity } = require('./protocol');
joinDriver(__dirname);
if (process.argv.length !== 6 || process.argv[2] !== '--workspace-race-worker') throw Error('Invalid workspace worker arguments');
const target = path.resolve(process.argv[3]);
const canary = path.resolve(process.argv[4]);
const stop = path.resolve(process.argv[5]);
const fixture = path.dirname(target);
if (fixture === __dirname || path.relative(__dirname, fixture).startsWith('..') ||
    path.dirname(canary) !== fixture || path.dirname(stop) !== fixture || target === canary || target === stop || canary === stop) {
  throw Error('Worker paths must be distinct fixtures inside the private round');
}
for (const directory of [fixture, target, canary]) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Worker fixture is not a private directory');
}
const held = target + '.round4-held';
for (const file of [held, stop, stop + '.ready', stop + '.counts']) {
  try { fs.lstatSync(file); throw Error('Worker fixture control path already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const delay = new Int32Array(new SharedArrayBuffer(4));
let loops = 0, replacements = 0;
publishJSON(stop + '.ready', { ready: true, ...processIdentity(process.pid) });
while (!fs.existsSync(stop) && loops < 50000) {
  loops++;
  try { fs.renameSync(target, held); } catch (_) { Atomics.wait(delay, 0, 0, 1); continue; }
  try {
    fs.symlinkSync(canary, target, 'dir'); replacements++;
    Atomics.wait(delay, 0, 0, 2);
    fs.unlinkSync(target);
    fs.renameSync(held, target);
  } catch (error) {
    try { if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target); } catch (_) {}
    try { if (fs.existsSync(held) && !fs.existsSync(target)) fs.renameSync(held, target); } catch (_) {}
  }
}
publishJSON(stop + '.counts', { loops, replacements, completed: true });
