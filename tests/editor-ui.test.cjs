// SPDX-License-Identifier: GPL-3.0-only
// Driver policy + real tiny fixture tests. No GUI, native runtime or model executes.
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {options, guestAllowed, approval, completedActions, journal, TASK, SNAPSHOT,
  startupAction, startupObservation} = require('../scripts/smoke_editor_ui.cjs');
const root = path.resolve(__dirname, '..');
const message = command => `Run this command once in .?\n\n${command}\n\nThis permits only this request, not future commands or wider access.`;
const read = {action: 'read', passed: true}, edit = {action: 'edit', passed: true}, passed = {action: 'test', passed: true};

test('UI driver requires explicit execution, loopback CDP and bounded duration; prep has no editor connection', () => {
  const args = ['--execute', '--yes', '--cdp', 'http://127.0.0.1:9222',
    '--project', '/private/editor-ui-project-trial', '--output', '/private/report.json'];
  assert.equal(options(args).seconds, 2400);
  assert.equal(options(['--prepare-project', '--execute', '--yes', '--project', '/private/editor-ui-project-trial',
    '--output', '/private/prep.json']).prepare, true);
  for (const bad of [args.slice(1), args.filter(value => value !== '--yes'), [...args, '--yes'],
    [...args, '--timeout-seconds', '2401'], args.map(value => value === 'http://127.0.0.1:9222' ? 'http://localhost:9222' : value),
    [...args, '--prepare-project'], [...args, '--host-override']]) assert.throws(() => options(bad));
});

test('actual model driver cannot be enabled on the dev host by supplying a path or test flag', () => {
  const guest = {platform: 'linux', hostname: 'volparossa-alpha', username: 'vpci', uid: 1000, virtualization: 'kvm'};
  assert(guestAllowed(guest));
  for (const change of [{hostname: 'desktop'}, {username: 'owner'}, {uid: 0}, {virtualization: 'none'},
    {virtualization: 'docker'}, {platform: 'darwin'}]) assert.equal(guestAllowed({...guest, ...change}), false);
});

test('visible approval permits only exact fixture commands and actual successful prior actions', () => {
  const readCommand = 'python3 -B /workspace/editor_fixture.py read';
  assert.equal(approval(message(readCommand), [], 0), 'read');
  assert.equal(approval(message(`/bin/bash -c '${readCommand}'`), [], 0), 'read');
  assert.equal(approval(message("python3 -B /workspace/editor_fixture.py edit 'a * b'"), [read], 1), 'edit');
  assert.equal(approval(message('python3 -B /workspace/editor_fixture.py test'), [read, edit], 2), 'test');
  for (const command of ['rm -rf /workspace', readCommand + '; id', readCommand + '\ncat /etc/passwd',
    'python3 -B /opt/fixture.py read', 'python3 -B /workspace/editor_fixture.py test',
    "python3 -B /workspace/editor_fixture.py edit 'a + b'", "python3 -B /workspace/editor_fixture.py edit '$(id)'"]) {
    assert.equal(approval(message(command), [], 0), null);
  }
  assert.equal(approval(message(readCommand).replace('in .?', 'in ../?'), [], 0), null);
  assert.equal(approval(message(readCommand), [], 8), null);
});

test('native completion requires observed read, actual edit and later passing test, not approval counts', () => {
  assert(completedActions([read, edit, passed]));
  assert(completedActions([read, edit, {action: 'test', passed: false}, edit, passed]));
  for (const rows of [[], [read], [read, edit], [edit, passed], [read, passed],
    [read, edit, passed, edit], [read, edit, {action: 'test', passed: false}]]) assert.equal(completedActions(rows), false);
  assert.deepEqual(journal(Buffer.from([read, edit, passed].map(row => JSON.stringify(row)).join('\n') + '\n')),
    [read, edit, passed]);
  assert.throws(() => journal(Buffer.from('{"action":"read","passed":true,"payload":"private"}\n')));
  assert.throws(() => journal(Buffer.from(JSON.stringify(read))));
});

test('GUI task gives no repair expression or canned result; DOM observation has no VS Code API injection', () => {
  assert(TASK.includes("edit 'EXPRESSION'")); assert(!TASK.includes("edit 'a + b'"));
  assert(!/acquireVsCodeApi|vscode\.|executeCommand|\.value\s*=/.test(SNAPSHOT));
  for (const selector of ['.quick-input-widget', '.dialog-message-text', '.dialog-buttons .monaco-button',
    '.monaco-editor .view-lines .view-line']) assert(SNAPSHOT.includes(selector));
});

test('startup observes actual workbench DOM before F1 and can retry a lost startup key without approving dialogs', () => {
  const loading = {documentReady:false,workbenchReady:false,dialogs:[],quick:null,errors:false};
  const ready = {...loading,documentReady:true,workbenchReady:true};
  assert.deepEqual(startupObservation(), {document_ready:false,workbench_ready:false,
    dialog_seen:false,palette_attempts:0,palette_seen:false});
  assert.equal(startupAction(loading, 0, true), 'wait');
  assert.equal(startupAction({...loading, documentReady:true}, 0, true), 'wait');
  assert.equal(startupAction({...loading, workbenchReady:true}, 0, true), 'wait');
  assert.equal(startupAction(ready, 0, true), 'open');
  assert.equal(startupAction(ready, 1, false), 'wait');
  assert.equal(startupAction(ready, 1, true), 'open'); // First F1 was lost, not treated as permission.
  assert.equal(startupAction({...ready,quick:{palette:true}}, 2, true), 'ready');
  assert.equal(startupAction(ready, 8, true), 'wait'); // No unbounded input or larger deadline.
  for (const view of [{...ready,dialogs:[{message:'unknown startup dialog'}]},
    {...ready,quick:{palette:false}}, {...ready,errors:true}]) assert.throws(() => startupAction(view, 1, true));
  assert.throws(() => startupAction({...ready,quick:{palette:true}}, 0, true));
  assert.throws(() => startupAction(ready, 9, true));
  for (const selector of ["document.readyState==='complete'", '.monaco-workbench', '.part.editor']) assert(SNAPSHOT.includes(selector));
});

test('fixture really prepares a new private project and independently rejects wrong arithmetic before accepting a supplied repair', () => {
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', String.raw`
import sys,tempfile,os,json,contextlib,io
from pathlib import Path
sys.path.insert(0,'scripts')
import editor_ui_fixture as ui
import native_coding_fixture as actual
with tempfile.TemporaryDirectory(prefix='editor-ui-project-') as temporary:
 p=Path(temporary); p.chmod(0o700)
 assert ui.project(str(p))==p
 inherited_umask=os.umask(0o077)
 os.umask(inherited_umask)
 assert ui.prepare(p)==0
 assert set(x.name for x in p.iterdir())==set(ui.NAMES)
 assert (p/'arithmetic.py').read_text()==actual.ORIGINAL
 for name in ('editor_fixture.py','native_coding_fixture.py'):
  assert (p/name).stat().st_mode & 0o777 == (0o444 & ~inherited_umask)
 try:ui.prepare(p)
 except ValueError:pass
 else:raise AssertionError('overwritten fixture')
 previous=Path.cwd();actual.PROJECT=p;actual.SOURCE=p/'arithmetic.py';os.chdir(p)
 def action(*args):
  sys.argv=['fixture',*args]
  with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):return actual.main()
 try:
  assert action('test')==1
  assert action('read')==0
  assert action('edit','a * b')==0
  assert action('test')==1
  assert action('edit','a + b')==0
  assert action('test')==0
  assert not (p/ui.JOURNAL).exists() # independent tests are not native-action evidence
 finally:os.chdir(previous)
`], {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
});
