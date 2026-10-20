// SPDX-License-Identifier: GPL-3.0-only
// Disposable guest only. Real CDP keyboard/mouse input, never a VS Code API shim.
'use strict';
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {commandKind} = require('../src/native-coding-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const ORIGINAL = 'def add(a, b):\n    return a - b\n';
const ACTIONS = '.editor-ui-actions.jsonl';
const FAILURE = new Set(['guest_required', 'arguments', 'project_scope', 'output_scope',
  'editor_unavailable', 'cdp_failed', 'ui_unrecognized', 'ui_bound', 'deadline',
  'command_refused', 'editor_failed', 'fixture_failed', 'cleanup_unconfirmed',
  'startup_not_ready', 'palette_unavailable', 'startup_dialog']);
function demand(value, reason) { if (!value) throw Error(reason); }
const sha = value => createHash('sha256').update(value).digest('hex');

function guestAllowed({platform, hostname, username, uid, virtualization}) {
  return platform === 'linux' && hostname === 'volparossa-alpha' && username === 'vpci' &&
    Number.isInteger(uid) && uid > 0 && virtualization === 'kvm';
}
function requireGuest() {
  const account = os.userInfo();
  demand(process.platform === 'linux' && os.hostname() === 'volparossa-alpha' &&
    account.username === 'vpci' && account.uid > 0, 'guest_required');
  const checked = spawnSync('/usr/bin/systemd-detect-virt', ['--vm'],
    {encoding: 'utf8', timeout: 5000, env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
  demand(checked.status === 0 && guestAllowed({platform: process.platform, hostname: os.hostname(),
    username: account.username, uid: account.uid, virtualization: checked.stdout.trim()}), 'guest_required');
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    demand(['--execute', '--yes', '--prepare-project', '--cdp', '--project', '--output', '--timeout-seconds'].includes(key) &&
      !Object.hasOwn(result, key), 'arguments');
    result[key] = ['--execute', '--yes', '--prepare-project'].includes(key) ? true : args[++index];
  }
  demand(result['--execute'] === true && result['--yes'] === true, 'arguments');
  if (result['--prepare-project']) demand(result['--cdp'] === undefined && result['--timeout-seconds'] === undefined, 'arguments');
  else demand(typeof result['--cdp'] === 'string' && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(result['--cdp']) &&
    Number(new URL(result['--cdp']).port) <= 65535, 'arguments');
  const seconds = Number(result['--timeout-seconds'] ?? 2400);
  demand(Number.isInteger(seconds) && seconds >= 30 && seconds <= 2400, 'arguments');
  for (const key of ['--project', '--output']) demand(typeof result[key] === 'string' &&
    path.isAbsolute(result[key]) && path.normalize(result[key]) === result[key] &&
    !result[key].includes('\0') && result[key].length <= 4096, 'arguments');
  return {prepare: result['--prepare-project'] === true, cdp: result['--cdp'],
    project: result['--project'], output: result['--output'], seconds};
}

async function privateDirectory(value) {
  const info = await fs.lstat(value);
  demand(await fs.realpath(value) === value && info.isDirectory() && info.uid === process.getuid() &&
    (info.mode & 0o7777) === 0o700, 'project_scope');
}

const checkFixture = value => demand(value, 'fixture_failed');
async function fixtureFile(project, name, max = 65536) {
  const file = path.join(project, name);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    checkFixture(info.isFile() && info.nlink === 1 && info.uid === process.getuid() && info.size <= max && !(info.mode & 0o022));
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    checkFixture(size === info.size && ['size', 'mtimeMs', 'mode', 'uid', 'gid'].every(key => info[key] === after[key]));
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

function journal(bytes) {
  demand(bytes.length <= 2048, 'fixture_failed');
  const lines = bytes.toString('utf8').split('\n');
  demand(lines.pop() === '' && lines.length <= 16, 'fixture_failed');
  return lines.map(line => {
    const value = JSON.parse(line);
    demand(value && Object.keys(value).sort().join(',') === 'action,passed' &&
      ['read', 'edit', 'test'].includes(value.action) && typeof value.passed === 'boolean', 'fixture_failed');
    return value;
  });
}
async function actions(project) {
  try { return journal(await fixtureFile(project, ACTIONS, 2048)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function approval(message, rows, count) {
  const prefix = 'Run this command once in .?\n\n';
  const suffix = '\n\nThis permits only this request, not future commands or wider access.';
  if (typeof message !== 'string' || message.length > 16384 || !message.startsWith(prefix) ||
      !message.endsWith(suffix) || count >= 8) return null;
  const command = message.slice(prefix.length, -suffix.length);
  if (!command.includes('/workspace/editor_fixture.py') || command.includes('/opt/fixture.py')) return null;
  const kind = commandKind(command.replaceAll('/workspace/editor_fixture.py', '/opt/fixture.py'));
  if (!kind || kind !== 'read' && !rows.some(row => row.action === 'read' && row.passed) ||
      kind === 'test' && !rows.some(row => row.action === 'edit' && row.passed)) return null;
  return kind;
}
function completedActions(rows) {
  let read = false, edit = false, test = false;
  for (const row of rows) {
    if (!row.passed) { if (row.action === 'test') test = false; continue; }
    if (row.action === 'read') read = true;
    if (row.action === 'edit') { if (!read) return false; edit = true; test = false; }
    if (row.action === 'test') { if (!edit) return false; test = true; }
  }
  return read && edit && test;
}

const TASK = `Fix add(a,b) in arithmetic.py, then verify it. Read the current source first; do not guess.
Use native exec_command, workdir /workspace, shell /bin/bash, login false, tty false, max_output_tokens 1024.
Only these command forms are authorized, one at a time:
1. python3 -B /workspace/editor_fixture.py read
2. python3 -B /workspace/editor_fixture.py edit 'EXPRESSION' (replace EXPRESSION with your arithmetic expression in a and b)
3. python3 -B /workspace/editor_fixture.py test
The helper writes your proposed expression, not a predetermined repair. It accepts only arithmetic.
Read, inspect the returned source, make the minimal edit, and run the actual tests. Finish only after tests pass.
Do not run other commands, request escalation, modify helpers or tests, use network, or invent tool results.`;

// CDP reads only the actual rendered DOM; all user input uses keyboard/mouse events.
// Selectors checked against installed VSCodium1.135.06055/1a46a584 source:
// out/vs/workbench/workbench.desktop.main.js (quick input and custom dialog widgets).
const SNAPSHOT = `(() => {
 const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden';
 const text = e => (e?.textContent || '').replaceAll('\\u00a0',' ');
 const point = e => { const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; };
 const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(visible).map(e=>({
   message:[text(e.querySelector('.dialog-message-text')),text(e.querySelector('.dialog-message-detail'))].filter(Boolean).join('\\n\\n'),
   buttons:[...e.querySelectorAll('.dialog-buttons .monaco-button')].filter(visible).map(b=>({label:text(b).trim(),...point(b)})) }));
 const q=[...document.querySelectorAll('.quick-input-widget')].find(visible);
 const input=q?.querySelector('.quick-input-box input');
 const result=[...document.querySelectorAll('.monaco-editor .view-lines .view-line')].filter(visible).map(text).join('\\n');
 const errors=[...document.querySelectorAll('.notification-list-item-message')].filter(visible).map(text).some(t=>t.includes('VOLPAROSSA could not complete this operation.'));
 const title=q?text(q.querySelector('.quick-input-title')):'';
 return {dialogs,quick:visible(input)?{title,palette:input.value.startsWith('>'),...point(input)}:null,
  documentReady:document.readyState==='complete',
  workbenchReady:!!visible(document.querySelector('.monaco-workbench'))&&!!visible(document.querySelector('.part.editor')),
  resultShown:result.includes('VOLPAROSSA — native coding turn finished')&&result.includes('Task correctness and tests are not independently verified'),
  resultCommands:result.match(/Native commands observed: ([0-9]+)/)?.[1]??null,errors};
})()`;

class CDP {
  constructor(socket) {
    this.socket = socket; this.pending = new Map(); this.next = 0;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    socket.addEventListener('message', event => {
      try {
        demand(typeof event.data === 'string' && Buffer.byteLength(event.data) <= 262144, 'ui_bound');
        const message = JSON.parse(event.data), item = this.pending.get(message.id);
        if (!item) return;
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Error('cdp_failed')); else item.resolve(message.result);
      } catch { void this.close().catch(() => {}); }
    });
    socket.addEventListener('error', () => { void this.close().catch(() => {}); });
    socket.addEventListener('close', () => { this.rejectPending(); this.resolveClosed(); });
  }
  call(method, params = {}) {
    demand(this.socket.readyState === WebSocket.OPEN && this.pending.size < 8, 'cdp_failed');
    return new Promise((resolve, reject) => {
      const id = ++this.next, timer = setTimeout(() => { this.pending.delete(id); reject(Error('cdp_failed')); }, 10000);
      this.pending.set(id, {resolve, reject, timer}); this.socket.send(JSON.stringify({id, method, params}));
    });
  }
  async snapshot() {
    const value = await this.call('Runtime.evaluate', {expression: SNAPSHOT, returnByValue: true});
    demand(!value.exceptionDetails && value.result?.value && JSON.stringify(value.result.value).length <= 32768, 'ui_bound');
    return value.result.value;
  }
  async key(key, code, virtual, modifiers = 0) {
    const event = {key, code, windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual, modifiers};
    await this.call('Input.dispatchKeyEvent', {type: 'keyDown', ...event});
    await this.call('Input.dispatchKeyEvent', {type: 'keyUp', ...event});
  }
  async click(point) {
    demand(point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.y >= 0, 'ui_unrecognized');
    for (const type of ['mousePressed', 'mouseReleased']) await this.call('Input.dispatchMouseEvent',
      {type, x: point.x, y: point.y, button: 'left', clickCount: 1});
  }
  rejectPending() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Error('cdp_failed')); }
    this.pending.clear();
  }
  async close() {
    this.rejectPending(); this.socket.close();
    let timer;
    try {
      await Promise.race([this.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('cleanup_unconfirmed')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
}

async function connect(origin) {
  const response = await fetch(origin + '/json/list', {redirect: 'error', signal: AbortSignal.timeout(5000)});
  demand(response.ok && Number(response.headers.get('content-length') ?? 0) <= 65536, 'editor_unavailable');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; demand(size <= 65536, 'ui_bound'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  const pages = JSON.parse(bytes).filter(item => item.type === 'page' && typeof item.url === 'string' &&
    item.url.startsWith('vscode-file://') && new URL(item.url).pathname.endsWith('/vs/code/electron-browser/workbench/workbench.html'));
  demand(pages.length === 1, 'editor_unavailable');
  const target = new URL(pages[0].webSocketDebuggerUrl), base = new URL(origin);
  demand(target.protocol === 'ws:' && target.hostname === '127.0.0.1' && target.port === base.port &&
    !target.username && !target.password, 'editor_unavailable');
  const socket = new WebSocket(target);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('cdp_failed')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, {once: true});
    socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('cdp_failed')); }, {once: true});
  });
  const cdp = new CDP(socket);
  try { await cdp.call('Page.bringToFront'); return cdp; }
  catch (error) { await cdp.close(); throw error; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function startupObservation() {
  return {document_ready:false,workbench_ready:false,dialog_seen:false,palette_attempts:0,palette_seen:false};
}
function startupAction(view, attempts, retryDue) {
  demand(view && typeof view.documentReady === 'boolean' && typeof view.workbenchReady === 'boolean' &&
    Array.isArray(view.dialogs) && Number.isInteger(attempts) && attempts >= 0 && attempts <= 8, 'ui_unrecognized');
  demand(!view.errors, 'editor_failed');
  if (view.dialogs.length) throw Error('startup_dialog'); // Never dismiss or approve an unknown dialog.
  if (view.quick) {
    demand(attempts > 0 && view.quick.palette === true, 'ui_unrecognized');
    return 'ready';
  }
  if (!view.documentReady || !view.workbenchReady || !retryDue || attempts === 8) return 'wait';
  return 'open';
}
async function openPalette(cdp, deadline, observed) {
  let retryAt = 0;
  while (Date.now() < deadline) {
    const view = await cdp.snapshot();
    observed.document_ready ||= view.documentReady === true;
    observed.workbench_ready ||= view.workbenchReady === true;
    observed.dialog_seen ||= Array.isArray(view.dialogs) && view.dialogs.length > 0;
    const action = startupAction(view, observed.palette_attempts, Date.now() >= retryAt);
    if (action === 'ready') { observed.palette_seen = true; return view; }
    if (action === 'open') {
      // A CDP page can exist before keybindings. Retry only an unobserved palette,
      // never consent/tool actions, and never extend the original 15-second window.
      await cdp.call('Page.bringToFront'); await cdp.key('F1', 'F1', 112);
      observed.palette_attempts++; retryAt = Date.now() + 750;
    }
    await pause(200); // DOM polling, not an unconditional startup sleep.
  }
  throw Error(observed.document_ready && observed.workbench_ready ? 'palette_unavailable' : 'startup_not_ready');
}
async function until(cdp, predicate, deadline) {
  while (Date.now() < deadline) {
    const view = await cdp.snapshot(); demand(!view.errors, 'editor_failed');
    if (predicate(view)) return view;
    await pause(200);
  }
  throw Error('deadline');
}

async function drive(cdp, project, seconds, report) {
  const deadline = Date.now() + seconds * 1000;
  let view = await openPalette(cdp, Math.min(deadline, Date.now() + 15000), report.startup);
  await cdp.click(view.quick); await cdp.key('a', 'KeyA', 65, 2);
  await cdp.call('Input.insertText', {text: '>VOLPAROSSA: Run Native Coding Task (Private, Local)'});
  await pause(400); await cdp.key('Enter', 'Enter', 13);
  report.phase = 'task-input';
  view = await until(cdp, v => v.quick?.title === 'VOLPAROSSA native coding task', Math.min(deadline, Date.now() + 30000));
  await cdp.click(view.quick); await cdp.call('Input.insertText', {text: TASK.replaceAll('\n', ' ')});
  await cdp.key('Enter', 'Enter', 13);
  report.phase = 'consent';
  view = await until(cdp, v => v.dialogs.length > 0, Math.min(deadline, Date.now() + 15000));
  demand(view.dialogs.length === 1, 'ui_unrecognized');
  const consent = view.dialogs[0];
  demand(consent.message.startsWith(`Allow a native coding task in ${project}?\n\n`) &&
    consent.message.endsWith('changes are not automatically rolled back.'), 'ui_unrecognized');
  await cdp.click(consent.buttons.find(button => button.label === 'Start local coding'));
  report.start_clicked = true; report.phase = 'native-turn';
  let previous = consent.message; // The just-clicked consent may still be animating away.
  while (Date.now() < deadline) {
    view = await cdp.snapshot(); demand(!view.errors, 'editor_failed');
    if (view.resultShown) {
      report.ui_result_shown = true;
      demand(/^[0-9]{1,2}$/.test(view.resultCommands), 'ui_unrecognized');
      report.native_commands_observed = Number(view.resultCommands);
      return;
    }
    if (view.dialogs.length) {
      demand(view.dialogs.length === 1, 'ui_unrecognized');
      const dialog = view.dialogs[0];
      // Wait for the already-clicked dialog to disappear; never double-approve it.
      if (dialog.message !== previous) {
        const kind = approval(dialog.message, await actions(project), report.approved_commands);
        if (!kind) {
          report.declined_commands++;
          const cancel = dialog.buttons.find(button => button.label === 'Cancel');
          if (cancel) await cdp.click(cancel); else await cdp.key('Escape', 'Escape', 27);
          throw Error('command_refused');
        }
        await cdp.click(dialog.buttons.find(button => button.label === 'Run once'));
        report.approved_commands++; previous = dialog.message;
      }
    } else previous = null;
    await pause(200);
  }
  throw Error('deadline');
}

async function run(config) {
  requireGuest(); // Before files, connections or any input into an editor.
  await privateDirectory(config.project);
  demand(/^editor-ui-project-[A-Za-z0-9_-]{1,32}$/.test(path.basename(config.project)), 'project_scope');
  await privateDirectory(path.dirname(config.output));
  demand(!config.output.startsWith(config.project + '/') &&
    !(await fs.lstat(config.output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })), 'output_scope');
  if (config.prepare) {
    demand((await fs.readdir(config.project)).length === 0, 'project_scope');
    const prepared = spawnSync('/usr/bin/python3', ['-B', path.join(__dirname, 'editor_ui_fixture.py'),
      '--prepare-project', config.project], {stdio: 'ignore', timeout: 10000,
      env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
    const report = {version: 1, kind: 'native-editor-ui-project-prepared', passed: prepared.status === 0,
      phase: 'prepare', failure: prepared.status === 0 ? null : 'fixture_failed',
      before_sha256: sha(ORIGINAL), model_executed: false, editor_contacted: false};
    await fs.writeFile(config.output, JSON.stringify(report) + '\n', {flag: 'wx', mode: 0o600});
    return report;
  }
  const report = {version: 2, kind: 'native-editor-ui-smoke', passed: false, phase: 'prepare', startup: startupObservation(),
    failure: null, start_clicked: false, approved_commands: 0, declined_commands: 0,
    native_commands_observed: 0, read: false, edit: false, test: false, independent_test_passed: false,
    ui_result_shown: false, runtime_cleanup_confirmed_by_ui: false, cdp_closed: false,
    before_sha256: sha(ORIGINAL), after_sha256: null,
    synthetic_model: false, private_peer_execution_claimed: false, general_coding_quality_claimed: false,
    guest_cleanup_owned_by_parent: true};
  let cdp;
  try {
    demand(JSON.stringify((await fs.readdir(config.project)).sort()) === JSON.stringify(
      ['arithmetic.py', 'editor_fixture.py', 'native_coding_fixture.py'].sort()), 'fixture_failed');
    demand(sha(await fixtureFile(config.project, 'arithmetic.py', 256)) === sha(ORIGINAL), 'fixture_failed');
    for (const [name, source] of [['editor_fixture.py', 'editor_ui_fixture.py'], ['native_coding_fixture.py', 'native_coding_fixture.py']]) {
      demand(sha(await fixtureFile(config.project, name)) === sha(await fs.readFile(path.join(__dirname, source))), 'fixture_failed');
    }
    report.phase = 'editor-connect'; cdp = await connect(config.cdp);
    await drive(cdp, config.project, config.seconds, report);
    report.phase = 'independent-check';
    const rows = await actions(config.project);
    report.read = rows.some(row => row.action === 'read' && row.passed);
    report.edit = rows.some(row => row.action === 'edit' && row.passed);
    report.test = completedActions(rows);
    demand(report.test && rows.length === report.approved_commands &&
      report.native_commands_observed === rows.length, 'fixture_failed');
    demand(JSON.stringify((await fs.readdir(config.project)).sort()) === JSON.stringify(
      [ACTIONS, 'arithmetic.py', 'editor_fixture.py', 'native_coding_fixture.py'].sort()), 'fixture_failed');
    for (const [name, source] of [['editor_fixture.py', 'editor_ui_fixture.py'], ['native_coding_fixture.py', 'native_coding_fixture.py']]) {
      demand(sha(await fixtureFile(config.project, name)) === sha(await fs.readFile(path.join(__dirname, source))), 'fixture_failed');
    }
    report.after_sha256 = sha(await fixtureFile(config.project, 'arithmetic.py', 256));
    demand(report.after_sha256 !== report.before_sha256, 'fixture_failed');
    const checked = spawnSync('/usr/bin/python3', ['-B', path.join(__dirname, 'editor_ui_fixture.py'),
      '--verify-project', config.project], {encoding: 'utf8', timeout: 10000, maxBuffer: 4096,
      env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}});
    demand(checked.status === 0 && JSON.stringify(JSON.parse(checked.stdout)) ===
      JSON.stringify({action: 'test', passed: true, tests: 3}), 'fixture_failed');
    report.independent_test_passed = true;
    // The actual extension displays this result only after awaiting runtime.close().
    report.runtime_cleanup_confirmed_by_ui = true;
    report.passed = true; report.phase = 'complete';
  } catch (error) { report.failure = FAILURE.has(error.message) ? error.message : 'fixture_failed'; }
  finally {
    try { if (cdp) await cdp.close(); report.cdp_closed = true; }
    catch { report.passed = false; report.failure = 'cleanup_unconfirmed'; }
    await fs.writeFile(config.output, JSON.stringify(report) + '\n', {flag: 'wx', mode: 0o600});
  }
  return report;
}

if (require.main === module) (async () => {
  const report = await run(options(process.argv.slice(2)));
  console.log(JSON.stringify({kind: report.kind, passed: report.passed, phase: report.phase, failure: report.failure}));
  if (!report.passed) process.exitCode = 1;
})().catch(() => { console.error('native_editor_ui_trial_unavailable'); process.exitCode = 1; });

// Component probes may inspect real rendered UI without starting a model task.
// There is deliberately no CLI switch bypassing the disposable-guest guard.
module.exports = {options, guestAllowed, approval, completedActions, journal, TASK, SNAPSHOT, CDP, connect,
  startupObservation, startupAction, openPalette};
