// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Real owner filesystem boundaries; no model-quality or live-peer claim.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {capturePublicCodeFile, applyPublicCodeFile} = require('../src/public-code-file.cjs');
const {fixture: publicCore, INPUT, updateReport} = require('./public-code-fixture.cjs');
function readFixtureBytes(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    assert.ok(info.isFile() && info.uid === process.getuid() && info.size <= 65536);
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    assert.ok(size === info.size && ['size', 'mtimeMs', 'mode', 'uid', 'gid'].every(key => info[key] === after[key]));
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-public-file-'));
  const file = path.join(workspace, 'selected.js');
  fs.writeFileSync(file, 'export const value = 1;\n', {mode: 0o600});
  t.after(() => fs.rmSync(workspace, {recursive: true, force: false}));
  return {workspace, file};
}
test('full selected source and byte hash captured without scanning other files', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'private.secret'), 'NEVER_PUBLISH');
  const source = capturePublicCodeFile(f);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(source.context, fs.readFileSync(f.file, 'utf8'));
  assert.equal(source.sourceSha256, createHash('sha256').update(source.context).digest('hex'));
  assert.equal(source.relativePath, 'selected.js');
  assert(!JSON.stringify(source).includes('NEVER_PUBLISH'));
  fs.writeFileSync(f.file, 'changed');
  assert.equal(source.context, 'export const value = 1;\n');
});
test('linked files, linked ancestor and paths outside selected workspace are rejected', t => {
  const f = fixture(t), linked = path.join(f.workspace, 'linked.js');
  fs.symlinkSync(f.file, linked);
  assert.throws(() => capturePublicCodeFile({...f, file: linked}));
  fs.unlinkSync(linked); fs.linkSync(f.file, linked);
  assert.throws(() => capturePublicCodeFile(f));
  fs.unlinkSync(linked);
  fs.mkdirSync(path.join(f.workspace, 'dir')); fs.symlinkSync('dir', path.join(f.workspace, 'alias'));
  fs.writeFileSync(path.join(f.workspace, 'dir', 'code.js'), 'value', {mode: 0o600});
  assert.throws(() => capturePublicCodeFile({...f, file: path.join(f.workspace, 'alias', 'code.js')}));
  assert.throws(() => capturePublicCodeFile({...f, file: path.join(f.workspace, '..', 'outside.js')}));
});
test('oversize, invalid UTF-8, empty and writable-by-others source is rejected without truncation', t => {
  const f = fixture(t);
  for (const bytes of [Buffer.alloc(4097, 65), Buffer.from([0xff]), Buffer.from(''), Buffer.from('a\0b')]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => capturePublicCodeFile(f));
  }
  fs.writeFileSync(f.file, 'a'); fs.chmodSync(f.file, 0o666);
  assert.throws(() => capturePublicCodeFile(f));
});

async function boundFile(t, options = {}) {
  const f = fixture(t), source = capturePublicCodeFile(f);
  const core = await publicCore(t, {input: {...INPUT, context: source.context}, ...options});
  const response = await core.execute(); await core.client.close();
  return {...f, source, core, response,
    apply: settings => applyPublicCodeFile(source, core.snapshot, response, settings)};
}
test('approved exact raw replacement changes only selected file after validated terminal receipt', async t => {
  const f = await boundFile(t);
  const tests = path.join(f.workspace, 'original-tests.js');
  fs.writeFileSync(tests, 'original independent test bytes', {mode: 0o600});
  const oldIdentity = fs.statSync(f.file).ino;
  let edit;
  const applied = await f.apply({approve: value => {edit = value; return true;}});
  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'export const value = 2;\n');
  assert.equal(readFixtureBytes(tests).toString('utf8'), 'original independent test bytes');
  assert.notEqual(fs.statSync(f.file).ino, oldIdentity); // No write through old inode.
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(edit.replacement, 'export const value = 2;\n');
  assert.equal(edit.coreTaskId, f.response.core_task_id);
  assert.equal(Object.isFrozen(edit), true);
  assert.deepEqual(fs.readdirSync(f.workspace).sort(), ['original-tests.js', 'selected.js']);
  await assert.rejects(f.apply({approve: () => true}));
});
test('changed content, symlink, hardlink or parent swap during approval never receives replacement', async t => {
  for (const change of ['content', 'symlink', 'hardlink', 'workspace']) {
    const f = await boundFile(t), other = path.join(f.workspace, 'other.js');
    fs.writeFileSync(other, 'must stay intact', {mode: 0o600});
    let relocated;
    await assert.rejects(f.apply({approve: () => {
      if (change === 'content') fs.writeFileSync(f.file, 'owner changed it');
      if (change === 'symlink') {fs.unlinkSync(f.file); fs.symlinkSync(other, f.file);}
      if (change === 'hardlink') {fs.unlinkSync(f.file); fs.linkSync(other, f.file);}
      if (change === 'workspace') {
        relocated = f.workspace + '-moved'; fs.renameSync(f.workspace, relocated);
        fs.mkdirSync(f.workspace, {mode: 0o700}); fs.writeFileSync(f.file, f.source.context, {mode: 0o600});
      }
      return true;
    }}));
    if (relocated) {
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.source.context);
      fs.rmSync(f.workspace, {recursive: true}); fs.renameSync(relocated, f.workspace);
    }
    assert.equal(fs.readFileSync(other, 'utf8'), 'must stay intact');
    assert(!fs.readdirSync(f.workspace).some(name => name.startsWith('.volparossa-proposal-')));
  }
});
test('denial, cancellation and incomplete output never write; copied receipts are not write authority', async t => {
  for (const mode of ['denied', 'cancelled', 'incomplete', 'copied']) {
    const f = await boundFile(t, mode === 'incomplete' ? {change: value => updateReport(value, report => {
      report.outputs[0].text_truncated = true; report.proposal_complete = false;
    })} : {});
    const controller = new AbortController();
    if (mode === 'copied') {
      await assert.rejects(applyPublicCodeFile(f.source, f.core.snapshot, structuredClone(f.response), {approve: () => true}));
    } else {
      const outcome = await f.apply({signal: controller.signal, approve: () => {
        assert.notEqual(mode, 'incomplete');
        if (mode === 'cancelled') controller.abort();
        return mode !== 'denied';
      }});
      assert.equal(outcome.applied, false);
    }
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.source.context);
  }
});
