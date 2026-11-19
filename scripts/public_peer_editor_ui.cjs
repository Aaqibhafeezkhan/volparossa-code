// SPDX-License-Identifier: GPL-3.0-only
// Drive the installed extension through the rendered workbench. The topology owns peer execution.
'use strict';
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {connect} = require('./smoke_editor_ui.cjs');
const {trustWorkspace, invokeCommand, until, button, CHECK} = require('./opencode_editor_ui.cjs');
const {ORIGINAL, TEST, isolatedCheck} = require('./smoke_opencode_inference.cjs');
const {QUESTION} = require('./smoke_public_code_proposal.cjs');
const {capturePublicCodeFile} = require('../src/public-code-file.cjs');
const LABEL = 'VOLPAROSSA: Propose a Replacement for a Public Source File';
const LICENSE = 'GPL-3.0-only';
const OWNER = '/workbench';
const SCRATCH = path.join(OWNER, 'session');
const PROJECT = path.join(SCRATCH, 'project');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const STATE = `(() => {
  const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const text = e => (e?.textContent || '').replaceAll('\\u00a0',' ');
  const center = e => { const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; };
  const quick = [...document.querySelectorAll('.quick-input-widget')].find(visible);
  const input = quick?.querySelector('.quick-input-box input');
  const rows = [...(quick?.querySelectorAll('.monaco-list-row') || [])].filter(visible);
  const choice = rows.filter(r=>text(r.querySelector('.label-name'))==='GPL-3.0-only');
  const files = rows.filter(r=>text(r.querySelector('.label-name'))==='fixture.py');
  const dialogs = [...document.querySelectorAll('.monaco-dialog-box')].filter(visible).map(d=>({
    message:[d.querySelector('.dialog-message-text')?.innerText,d.querySelector('.dialog-message-detail')?.innerText].filter(Boolean).join('\\n\\n'),
    buttons:[...d.querySelectorAll('.dialog-buttons .monaco-button')].filter(visible).map(b=>({label:text(b).trim(),...center(b)}))}));
  const documents = [...document.querySelectorAll('.monaco-editor .view-lines')].filter(visible)
    .map(editor => [...editor.querySelectorAll('.view-line')].filter(visible).map(text));
  const originalLines = ${JSON.stringify(ORIGINAL.trimEnd().split('\n'))};
  const hasSource = lines => lines.some((line, i) => line === originalLines[0] &&
    originalLines.every((expected, offset) => expected === lines[i + offset]));
  const preview = documents.some(lines => lines.includes('Public source proposal — GPL-3.0-only') &&
    lines.includes(${JSON.stringify(QUESTION)}) && lines.includes('Complete selected file:') && hasSource(lines));
  const result = documents.find(lines => lines.includes('VOLPAROSSA public code proposal: applied to the selected file.'));
  const core = result?.find(line => /^Core request: [0-9a-f]{32}$/.test(line));
  const job = result?.find(line => /^Peer job: [0-9a-f]{32}$/.test(line));
  const peer = result?.find(line => /^Peer report SHA-256: [0-9a-f]{64}$/.test(line));
  return {quick:visible(input)?center(input):null,title:text(quick?.querySelector('.quick-input-title')),
    license:choice.length===1?center(choice[0]):null, file:files.length===1?center(files[0]):null, dialogs,
    source:documents.some(hasSource), preview, applied:!!result,
    checked:!!result?.includes('Owner-selected local check: passed; not general correctness.'),
    core:core?.slice('Core request: '.length), job:job?.slice('Peer job: '.length), peer:peer?.slice('Peer report SHA-256: '.length),
    failed:[...document.querySelectorAll('.notification-list-item-message')].filter(visible)
      .some(e=>text(e).includes('VOLPAROSSA could not complete this operation.'))};
})()`;
function wait(cdp, predicate, seconds, failure) {
  return until(cdp, STATE, predicate, Date.now() + seconds * 1000, failure);
}

function containsAll(message, fragments) {
  return fragments.every(fragment => message.includes(fragment));
}

function editDigest(message) {
  const match = /^Replace only fixture\.py with this exact peer proposal\?\s+Expected source SHA-256: ([0-9a-f]{64})\s+Replacement SHA-256: ([0-9a-f]{64})\s+Review the complete proposal first\. This grants one local edit, not peer filesystem or command access\.$/.exec(message.trim());
  assert.ok(match && match[1] === hash(ORIGINAL) && match[2] !== match[1], 'edit_scope');
  return match[2];
}

async function exercise(cdp, evidence, intactTests, {stopBeforeEnrollment = false} = {}) {
  await trustWorkspace(cdp, evidence);
  await cdp.key('p', 'KeyP', 80, 2);
  let ui = await wait(cdp, view => view.quick, 15, 'file_picker');
  await cdp.click(ui.quick);
  await cdp.call('Input.insertText', {text: 'fixture.py'});
  ui = await wait(cdp, view => view.file, 15, 'file_picker');
  await cdp.click(ui.file);
  await wait(cdp, view => !view.quick && view.source, 15, 'selected_file');
  await invokeCommand(cdp, LABEL);
  ui = await wait(cdp, view => view.quick && view.title === 'Public single-file code proposal', 30, 'public_task');
  await cdp.click(ui.quick);
  await cdp.call('Input.insertText', {text: QUESTION});
  await cdp.key('Enter', 'Enter', 13);
  ui = await wait(cdp, view => view.license && view.title.startsWith('Select the license'), 15, 'license');
  await cdp.click(ui.license);
  ui = await wait(cdp, view => view.dialogs.length === 1 && view.preview, 30, 'publication_preview');
  assert.ok(containsAll(ui.dialogs[0].message, [
    'Publish this exact task and complete source file to VOLPAROSSA peers',
    'Confirm that both are public and that you have sharing rights.',
    'Any local edit needs separate approval.',
  ]), 'publication_scope');
  evidence.previewed_exact_public_source = true;
  if (stopBeforeEnrollment) {
    await button(cdp, ui.dialogs[0], 'Cancel');
    return;
  }
  await button(cdp, ui.dialogs[0], 'Enroll public source');
  evidence.owner_enrolled_public_source = true;
  const deadline = Date.now() + 2400000;
  while (Date.now() < deadline) {
    ui = await cdp.snapshot(STATE);
    assert.ok(!ui.failed && ui.dialogs.length <= 1, 'peer_operation');
    if (ui.applied && ui.checked && ui.core && ui.job && ui.peer) {
      assert.ok(evidence.owner_edit_approved && evidence.owner_test_approved, 'owner_result');
      evidence.core_task_id = ui.core;
      evidence.peer_job_id = ui.job;
      evidence.report_sha256 = ui.peer;
      evidence.owner_check_status = 'passed';
      evidence.result_shown = true;
      return;
    }
    const dialog = ui.dialogs[0];
    if (dialog) {
      assert.ok(await intactTests(), 'original_tests');
      if (dialog.message.startsWith('Replace only')) {
        assert.ok(!evidence.owner_edit_approved, 'edit_scope');
        evidence.replacement_sha256 = editDigest(dialog.message);
        await button(cdp, dialog, 'Apply replacement once');
        evidence.owner_edit_approved = true;
      } else {
        assert.ok(evidence.owner_edit_approved && !evidence.owner_test_approved && containsAll(dialog.message, [
          'Run the owner-selected check once?', JSON.stringify(CHECK),
          'Read-only workspace sandbox, no network. Its output is not sent to peers.',
        ]), 'check_scope');
        await button(cdp, dialog, 'Run check once');
        evidence.owner_test_approved = true;
      }
      await wait(cdp, view => !view.dialogs.some(item => item.message === dialog.message), 15, 'dialog_closed');
    }
    await sleep(1500);
  }
  throw Error('peer_deadline');
}
function guard() {
  assert.deepEqual(process.argv.slice(2),['--execute','--yes']);
  assert.ok(process.platform==='linux' && process.getuid()>0 && os.userInfo().username==='volparossa');
  assert.deepEqual(Object.keys(os.networkInterfaces()),['lo']);
  const virt=spawnSync('/usr/bin/systemd-detect-virt',['--vm'],{encoding:'utf8',timeout:5000});
  assert.ok(virt.status===0 && virt.stdout.trim()==='kvm');
}
async function run() {
  guard();
  process.umask(0o077);
  const uid=process.getuid(), socket=await fs.lstat(OWNER+'/public.sock');
  assert.ok(socket.isSocket() && socket.uid===uid && (socket.mode&0o777)===0o600);
  assert.equal((await fs.lstat('/usr/bin')).uid,0);
  const receipt = await fs.open(path.join(OWNER, 'report.json'), 'wx', 0o600);
  try { await runInWorkspace(receipt); }
  finally { await receipt.close(); }
}
async function runInWorkspace(receipt) {
  await fs.mkdir(SCRATCH,{mode:0o700});
  const evidence={version:1,kind:'vscodium-public-peer-workbench',passed:false,phase:'prepare',
    workspace_trust_granted:false,previewed_exact_public_source:false,owner_enrolled_public_source:false,
    owner_edit_approved:false,owner_test_approved:false,result_shown:false,owner_check_status:null,
    original_source_sha256:hash(ORIGINAL),original_tests_sha256:hash(TEST),question_sha256:hash(QUESTION),
    license:LICENSE,original_baseline_failed:false,original_tests_unchanged:false,independent_test_passed:false,
    only_selected_file_present:false,actual_applied_sha256:null,replacement_sha256:null,core_task_id:null,
    peer_job_id:null,report_sha256:null,editor_joined:false,project_removed:false,failure:null};
  let editor, closed, cdp;
  try {
    await fs.mkdir(PROJECT,{mode:0o700});
    for(const [name,data] of [['fixture.py',ORIGINAL],['test_fixture.py',TEST]])
      await fs.writeFile(path.join(PROJECT,name),data,{flag:'wx',mode:0o600});
    evidence.original_baseline_failed=await isolatedCheck(PROJECT,SCRATCH)===false;
    assert.ok(evidence.original_baseline_failed,'baseline');
    await fs.mkdir(SCRATCH+'/home', {mode: 0o700});
    await fs.mkdir(SCRATCH+'/extensions', {mode: 0o700});
    await fs.mkdir(SCRATCH+'/profile/User',{recursive:true,mode:0o700});
    await fs.writeFile(SCRATCH+'/profile/User/settings.json',JSON.stringify({
      'window.dialogStyle':'custom','workbench.startupEditor':'none','telemetry.telemetryLevel':'off',
      'update.mode':'none','extensions.autoUpdate':'off','extensions.autoCheckUpdates':false,
      'security.workspace.trust.enabled':true,'volparossaCode.publicSocket':OWNER+'/public.sock',
      'volparossaCode.ownerVerification':{executable:CHECK[0],args:CHECK.slice(1),timeoutMs:15000,maxRounds:1}
    }),{mode:0o600,flag:'wx'});
    evidence.phase='workbench';
    editor=spawn('/opt/volparossa-editor/codium',['--new-window','--ozone-platform=headless','--disable-gpu',
      '--disable-updates','--disable-telemetry','--disable-crash-reporter','--locale=en',
      '--user-data-dir='+SCRATCH+'/profile','--extensions-dir='+SCRATCH+'/extensions',
      '--extensionDevelopmentPath=/opt/volparossa-code','--skip-welcome','--skip-release-notes',
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port=9222',PROJECT],
      {cwd:SCRATCH,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',HOME:SCRATCH+'/home'},stdio:'ignore'});
    closed = new Promise(resolve => {
      editor.once('error', () => resolve(null));
      editor.once('exit', code => resolve(code));
    });
    for (let attempt = 0; attempt < 100 && !cdp; attempt++) {
      try { cdp = await connect('http://127.0.0.1:9222'); }
      catch { await sleep(400); }
    }
    assert.ok(cdp,'workbench');
    const contents=name=>capturePublicCodeFile({workspace:PROJECT,file:path.join(PROJECT,name)}).context;
    const intactTests=()=>hash(contents('test_fixture.py'))===evidence.original_tests_sha256;
    await exercise(cdp,evidence,intactTests);
    evidence.phase='independent_check';
    evidence.actual_applied_sha256=hash(contents('fixture.py'));
    assert.equal(evidence.actual_applied_sha256,evidence.replacement_sha256,'replacement_binding');
    evidence.original_tests_unchanged=intactTests();
    evidence.only_selected_file_present=JSON.stringify((await fs.readdir(PROJECT)).sort())===JSON.stringify(['fixture.py','test_fixture.py']);
    evidence.independent_test_passed=await isolatedCheck(PROJECT,SCRATCH)===true;
    assert.ok(evidence.original_tests_unchanged && evidence.only_selected_file_present && evidence.independent_test_passed,'independent_check');
    await cdp.key('q', 'KeyQ', 81, 2);
    await cdp.close();
    cdp = null;
    assert.equal(await Promise.race([closed,sleep(15000).then(()=>-1)]),0,'editor_exit');
    evidence.editor_joined = true;
    evidence.phase = 'complete';
  } catch(error) {
    const allowed=new Set(['baseline','workbench','file_picker','selected_file','public_task','license','publication_preview',
      'publication_scope','original_tests','peer_operation','owner_result','edit_scope','check_scope','dialog_closed','peer_deadline',
      'replacement_binding','independent_check','editor_exit','trust_banner','trust_page','trust_grant','trust_close']);
    evidence.failure=allowed.has(error.message)?error.message:'workbench_failed';
  } finally {
    if(cdp) await cdp.close().catch(()=>{});
    if(editor && editor.exitCode===null && editor.signalCode===null){
      editor.kill('SIGTERM');
      if(await Promise.race([closed.then(()=>true),sleep(5000).then(()=>false)])===false) editor.kill('SIGKILL');
      await closed;
    }
    await fs.rm(SCRATCH, {recursive:true, force:false});
    evidence.project_removed = true;
  }
  evidence.passed=evidence.phase==='complete' && evidence.editor_joined && evidence.project_removed;
  await receipt.writeFile(JSON.stringify(evidence)+'\n');
  if(!evidence.passed) process.exitCode=1;
}
if(require.main===module) run().catch(()=>{process.exitCode=1;});
module.exports={exercise,editDigest,STATE,LABEL};
