// SPDX-License-Identifier: GPL-3.0-only
// Drive only the rendered VSCodium workbench. No VS Code API or model output is injected.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {connect, openPalette, startupObservation} = require('./smoke_editor_ui.cjs');
const {TEST, ORIGINAL, isolatedCheck, commandKind, guestGuard} = require('./smoke_opencode_inference.cjs');
const {capturePublicCodeFile} = require('../src/public-code-file.cjs');
const TASK = 'Read fixture.py and test_fixture.py. Fix the small bug in fixture.py, '
  + 'then run the existing Python unittest tests. Do not modify tests or install dependencies. '
  + 'This is an explicitly selected disposable project. Keep your final answer concise.';
const README = 'Disposable synthetic Python project. Fix fixture.py; keep test_fixture.py unchanged.\n';
const contents = (workspace, name) => capturePublicCodeFile({workspace,file:path.join(workspace,name)}).context;
const LABEL = 'VOLPAROSSA: Run OpenCode Task (Development)';
const CHECK = [require('node:fs').realpathSync('/usr/bin/python3'), '-B', '-m', 'unittest', '-v', 'test_fixture.py'];
const ORIGIN = 'http://127.0.0.1:9222';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// Only UI labels, geometry, closed counters and one-shot action text enter memory.
const STATE = `(observeTrust => {
  const visible = e => e && e.getBoundingClientRect().width && e.getBoundingClientRect().height;
  const text = e => (e?.innerText || '').replaceAll('\\u00a0', ' ');
  const point = e => { const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; };
  const links = observeTrust ? [...document.querySelectorAll('.part.banner a[href="command:workbench.trust.manage"]')].filter(visible) : [];
  const quick = observeTrust && [...document.querySelectorAll('.quick-input-widget')].find(visible);
  const focused = quick && quick.querySelector('.monaco-list-row.focused .label-name');
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(visible).map(d=>({
    message:[text(d.querySelector('.dialog-message-text')),text(d.querySelector('.dialog-message-detail'))].filter(Boolean).join('\\n\\n'),
    buttons:[...d.querySelectorAll('.dialog-buttons .monaco-button')].filter(visible).map(b=>({label:text(b).trim(),...point(b)}))}));
  const lines = [...document.querySelectorAll('.monaco-editor .view-lines .view-line')].filter(visible)
    .map(e => (e.textContent || '').replaceAll('\\u00a0',' '));
  const head = lines.indexOf('VOLPAROSSA — OpenCode turn finished');
  const checked = head >= 0 && lines.slice(head+1,head+7).some(x=>/^Owner-selected check: passed; checks: [1-4];/.test(x));
  const calls = head >= 0 && lines[head+1]?.match(/^Completed native tools: reads (\\d+), edits (\\d+), shell commands (\\d+)\\.$/);
  const trust = observeTrust ? text(document.body).slice(0,16384) : '';
  return {manage:links.length===1?point(links[0]):null, restricted:trust.includes('Restricted Mode is intended'),
    trustPage:trust.includes('In Restricted Mode') && trust.includes('Trusted Folders & Workspaces'),
    granted:trust.includes('You trust this folder'), paletteLabel:text(focused), dialogs,
    model:head>=0 && lines[head+2]==='Model: qwen3-4b-instruct-2507-v1', checked, tools:calls?calls.slice(1).map(Number):null,
    failed:[...document.querySelectorAll('.notification-list-item-message')].filter(visible)
      .some(e=>text(e).includes('VOLPAROSSA could not complete this operation.'))};
})`;
const STARTUP_STATE = STATE + '(true)';
const TASK_STATE = STATE + '(false)';

function decision(message, project, count) {
  if (typeof message !== 'string' || message.length > 16384 || count >= 12) return null;
  // Chromium may normalize line breaks between the original text and detail.
  const clean = message.replaceAll('\r', '').trim();
  const suffix = 'This permits only this request, not future actions or wider access.';
  for (const [prefix, type] of [['Run this command once in /workspace?', 'command'],
    ['Apply this edit once in /workspace?', 'edit']]) {
    if (clean.startsWith(prefix) && clean.endsWith(suffix)) {
      const action = clean.slice(prefix.length, -suffix.length).trim();
      return type === 'edit' ? (action === 'Edit fixture.py' ? 'edit' : null) : commandKind(action);
    }
  }
  const plan = JSON.stringify(CHECK);
  for (let round = 1; round <= 4; round++) {
    const prefix = `Run owner-selected check ${round}/4 once in ${project}?`;
    const detail = 'Read-only workspace sandbox, no network or core credentials. A failed check may send its bounded output '
      + 'to the same local model session for another attempt. This does not authorize future checks or tools.';
    if (clean.startsWith(prefix) && clean.endsWith(detail) && clean.slice(prefix.length, -detail.length).trim() === plan) return 'check';
  }
  return null;
}

async function until(cdp, expression, predicate, deadline, failure) {
  while (Date.now() < deadline) {
    const state = await cdp.snapshot(expression);
    assert.ok(!state.failed && !state.errors, 'editor_failed');
    if (predicate(state)) return state;
    await pause(175);
  }
  throw Error(failure);
}

async function button(cdp, dialog, label) {
  const choices = dialog.buttons.filter(item => item.label === label);
  assert.equal(choices.length, 1, 'unknown_dialog');
  await cdp.click(choices[0]);
}

async function trustWorkspace(cdp, evidence) {
  const start = Date.now();
  // A fresh editor profile must grant trust to the only disposable folder.
  const initial = await until(cdp, STARTUP_STATE, state => state.manage !== null, start + 60000, 'trust_banner');
  await cdp.click(initial.manage);
  await until(cdp, STARTUP_STATE, state => state.trustPage, Date.now()+15000, 'trust_page');
  await cdp.key('Enter', 'Enter', 13, 2);
  await until(cdp, STARTUP_STATE, state => state.granted, Date.now()+15000, 'trust_grant');
  evidence.workspace_trust_granted = true;
  await cdp.key('Escape','Escape',27);
  await until(cdp, STARTUP_STATE, state => !state.trustPage, Date.now()+15000, 'trust_close');
}

async function invokeCommand(cdp, label) {
  const palette = await openPalette(cdp, Date.now()+30000, startupObservation());
  await cdp.click(palette.quick); await cdp.key('a','KeyA',65,2);
  await cdp.call('Input.insertText', {text:'>'+label});
  await until(cdp, STARTUP_STATE, state => state.paletteLabel === label, Date.now()+15000, 'command_palette');
  await cdp.key('Enter','Enter',13);
}

async function drive(cdp, project, evidence, stopAtConsent = false) {
  await trustWorkspace(cdp, evidence);
  await invokeCommand(cdp, LABEL);
  const prompt = await until(cdp, undefined, v => v.quick?.title === 'VOLPAROSSA OpenCode task',
    Date.now()+30000, 'task_input');
  await cdp.click(prompt.quick); await cdp.call('Input.insertText', {text:TASK});
  await cdp.key('Enter','Enter',13);
  const one = await until(cdp, STARTUP_STATE, v => v.dialogs.length === 1, Date.now()+15000, 'consent');
  const consent = one.dialogs[0];
  assert.ok(consent.message.startsWith(`Allow an OpenCode coding task in ${project}?`)
    && consent.message.includes('no public-peer or Internet access')
    && consent.message.includes('Owner-selected check: '+JSON.stringify(CHECK)), 'scope_mismatch');
  evidence.command_and_consent_rendered = true;
  if (stopAtConsent) { await button(cdp,consent,'Cancel'); return; }
  await button(cdp,consent,'Start local coding');
  evidence.started_from_editor = true;
  let previous = consent.message;
  const limit = Date.now() + 2410000;
  while (Date.now() < limit) {
    const view = await cdp.snapshot(TASK_STATE);
    assert.ok(!view.failed, 'editor_failed');
    if (view.checked && view.tools) {
      assert.ok(view.model, 'model_profile');
      const [reads, edits, commands] = view.tools;
      assert.ok(reads >= 1 && edits >= 1 && commands >= 1, 'native_tool_evidence');
      Object.assign(evidence, {completed_reads:reads,completed_edits:edits,completed_shell_commands:commands,
        model_profile:'qwen3-4b-instruct-2507-v1', editor_result_shown:true, owner_check_passed:true});
      return;
    }
    assert.ok(view.dialogs.length <= 1, 'unknown_dialog');
    const dialog = view.dialogs[0];
    if (dialog && dialog.message !== previous) {
      const kind = decision(dialog.message, project, evidence.approvals);
      if (!kind || hash(contents(project,'test_fixture.py')) !== hash(TEST)) {
        await button(cdp,dialog,'Cancel'); throw Error('action_refused');
      }
      await button(cdp, dialog, kind === 'check' ? 'Run check once' : 'Approve once');
      evidence.approvals++; evidence['approved_'+kind]++;
    }
    previous = dialog?.message ?? null;
    // The model can spend minutes on a turn. Leave CPU time to inference
    // between appearances of the persistent owner approval dialogs.
    await pause(1500);
  }
  throw Error('model_deadline');
}

async function main() {
  guestGuard();
  const args = process.argv.slice(2);
  const projectRoot = '/home/vpci/opencode-projects/ui/project';
  if (args.length === 2 && args[0] === '--fixture' && ['prepare','verify'].includes(args[1])) {
    const directory = path.dirname(projectRoot);
    if (args[1] === 'prepare') {
      await fs.mkdir(projectRoot, {mode:0o700});
      for (const [name, bytes] of [['README.txt',README],['fixture.py',ORIGINAL],['test_fixture.py',TEST]]) {
        await fs.writeFile(path.join(projectRoot,name),bytes,{flag:'wx',mode:0o600});
      }
      assert.equal(await isolatedCheck(projectRoot,directory),false);
    } else {
      const source=contents(projectRoot,'fixture.py');
      assert.equal(hash(contents(projectRoot,'test_fixture.py')),hash(TEST));
      assert.notEqual(hash(source),hash(ORIGINAL));
      assert.equal(await isolatedCheck(projectRoot,directory),true);
      console.log(JSON.stringify({original_sha256:hash(ORIGINAL),resulting_sha256:hash(source),tests_sha256:hash(TEST)}));
    }
    return;
  }
  const [project, output] = args;
  assert.equal(project,'/home/vpci/opencode-projects/ui/project');
  assert.equal(output,'/home/vpci/opencode-projects/ui/rendered.json');
  const evidence = {workspace_trust_granted:false,command_and_consent_rendered:false,started_from_editor:false,
    editor_result_shown:false,owner_check_passed:false,approvals:0,approved_read:0,approved_edit:0,approved_test:0,
    approved_check:0,completed_reads:0,completed_edits:0,completed_shell_commands:0,cdp_closed:false,passed:false};
  let cdp;
  try {
    for (let i=0; i<100 && !cdp; i++) {
      try { cdp=await connect(ORIGIN); } catch { await pause(400); }
    }
    assert.ok(cdp, 'workbench_unavailable');
    await drive(cdp,project,evidence);
    assert.ok(evidence.approved_edit && evidence.approved_test && evidence.approved_check, 'tool_approvals');
    await cdp.key('q','KeyQ',81,2);
    evidence.passed=true;
  } catch (error) {
    const safe = new Set(['workbench_unavailable','trust_banner','trust_page','trust_grant','trust_close','command_palette',
      'task_input','consent','scope_mismatch','model_deadline','action_refused','editor_failed','tool_approvals',
      'native_tool_evidence','model_profile','unknown_dialog','palette_unavailable','startup_not_ready']);
    evidence.failure=safe.has(error.message)?error.message:'editor_operation';
  } finally {
    if (cdp) { await cdp.close(); evidence.cdp_closed=true; }
    await fs.writeFile(output, JSON.stringify(evidence)+'\n', {flag:'wx',mode:0o600});
  }
  if (!evidence.passed) process.exitCode=1;
}
if (require.main===module) main().catch(()=>{process.exitCode=1;});
module.exports={CHECK, LABEL, drive, decision, trustWorkspace, invokeCommand, until, button};
