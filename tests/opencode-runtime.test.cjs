// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Synthetic framing and lifecycle only: no OpenCode binary, model or real workspace.
const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {PassThrough, Writable} = require('node:stream');
const {configuration, ownedOpenCode} = require('../src/opencode-runtime.cjs');
const {readFrames, writeFrame, emptyProviderDiagnostic, emptyTaskDiagnostic,
  validProviderDiagnostic} = require('../src/opencode-bridge.cjs');
const READY = {type: 'ready', version: 1, execution: 'private_local', confidentialRemoteAvailable: false};
const RESULT = {text: 'Synthetic answer.', commands: 1, nativeTurnCompleted: true, taskVerified: false};
test('provider counter schema accepts exact historical receipts and the new bounded terminal code', () => {
  const current = emptyProviderDiagnostic();
  current.request_errors.execution_budget_exceeded = 1;
  assert.equal(validProviderDiagnostic(current), true);
  const old = structuredClone(current);
  delete old.request_errors.execution_budget_exceeded;
  assert.equal(validProviderDiagnostic(old), true);
  assert.equal(Object.hasOwn(old.request_errors, 'execution_budget_exceeded'), false);
  for (const changed of [true, -1, 65536, 'PRIVATE_CANARY']) {
    const invalid = structuredClone(current);
    invalid.request_errors.execution_budget_exceeded = changed;
    assert.equal(validProviderDiagnostic(invalid), false);
  }
  old.request_errors.private_detail = 'PRIVATE_CANARY';
  assert.equal(validProviderDiagnostic(old), false);
});
function child(t, program) {
  const process = spawn(require('node:process').execPath, ['-e', program], {stdio: ['pipe', 'pipe', 'pipe'],
    env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ELECTRON_RUN_AS_NODE: '1'}});
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  return process;
}
function script(onFrame, {ready = READY, exitCode = 0} = {}) {
  return `const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
send(${JSON.stringify(ready)});
const lines=require('node:readline').createInterface({input:process.stdin});
lines.on('line',line=>{const frame=JSON.parse(line);${onFrame}});
lines.on('close',()=>{process.exitCode=${exitCode};});`;
}
test('OpenCode runtime config accepts only exact explicit pinned inputs', () => {
  const config = {version: 1, opencode: '/fixture/opencode', opencodeSha256: 'a'.repeat(64),
    buildReport: '/fixture/BUILD_REPORT.json', node: '/fixture/node', nodeSha256: 'b'.repeat(64), socketPath: '/fixture/private/core.sock'};
  assert.deepEqual(configuration(config, '/fixture/project'), config);
  const constrained = {...config, outputConstraint: 'qwen_tagged_tool_json_v1'};
  assert.deepEqual(configuration(constrained, '/fixture/project'), constrained);
  for (const outputConstraint of [null, undefined, false, 'grammar']) {
    assert.throws(() => configuration({...config, outputConstraint}, '/fixture/project'), /opencode_runtime/);
  }
  for (const changed of [{...config, appServer: '/fixture/codex'}, {...config, opencodeSha256: 'bad'},
    {...config, socketPath: 'relative'}, {...config, version: 2}]) {
    assert.throws(() => configuration(changed, '/fixture/project'), /opencode_runtime/);
  }
  assert.throws(() => configuration(config, 'relative'), /opencode_runtime/);
});
test('framing handles split UTF8 and rejects malformed or trailing input', () => {
  const input = new PassThrough(), got = []; let bad = 0;
  const unbind = readFrames(input, value => got.push(value), () => bad++);
  const bytes = Buffer.from('{"type":"synthetic","text":"café"}\r\n');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  input.write(bytes.subarray(0, split)); input.write(bytes.subarray(split));
  assert.deepEqual(got, [{type: 'synthetic', text: 'café'}]);
  input.write('not-json\n'); input.write('{"type":"ignored"}\n'); assert.equal(bad, 1); assert.equal(got.length, 1);
  unbind(); assert.equal(input.listenerCount('data'), 0);
  const truncated = new PassThrough(); readFrames(truncated, () => assert.fail(), () => bad++);
  truncated.end('{"type":');
  return new Promise(resolve => truncated.once('end', () => { assert.equal(bad, 2); resolve(); }));
});
test('ready, task, one-shot approval and status roundtrip; clean owner exit required', async t => {
  const process = child(t, script(`
if(frame.type==='run') {
 if(frame.prompt!=='Synthetic task') process.exit(2);
 send({type:'approval',id:1,proposal:{permission:'bash',command:'synthetic-command',directory:'/workspace'}});
} else if(frame.type==='approval') {
 if(frame.id!==1 || frame.accepted!==true) process.exit(3);
 send({type:'status',commands:1,status:'completed'}); send({type:'result',result:${JSON.stringify(RESULT)}});
} else process.exit(4);`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  const proposals = [], statuses = [];
  const result = await runtime.run('Synthetic task', {approve: async p => { proposals.push(p); return true; }, onStatus: s => statuses.push(s)});
  assert.deepEqual(result, RESULT); assert.equal(proposals[0].permission, 'bash');
  assert.deepEqual(statuses, [{commands: 1, status: 'completed'}]);
  assert.equal(runtime.execution, 'private_local'); assert.equal(runtime.confidentialRemoteAvailable, false);
  assert.equal(runtime.modelProfile, 'qwen3-0.6b-v1'); // Compatibility with the fixed-model version-1 owner.
  await Promise.all([runtime.close(), runtime.close()]); assert.equal(process.exitCode, 0);
  await assert.rejects(runtime.run('Again'), /opencode_runtime/);
});
test('readiness accepts only closed core-bound model identities and never guesses 4B', async t => {
  for (const modelProfile of ['qwen3-0.6b-v1', 'qwen3-4b-instruct-2507-v1', null, 'unreviewed-model']) {
    const process = child(t, script('', {ready: {...READY, modelProfile}}));
    if (modelProfile == null || modelProfile === 'unreviewed-model') {
      await assert.rejects(ownedOpenCode(process, {startupMs: 1000, closeMs: 1000}), /opencode_runtime/);
    } else {
      const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
      assert.equal(runtime.modelProfile, modelProfile); await runtime.close();
    }
  }
});
test('cancel sends cancellation, declines late UI answers, and returns only generic failure', async t => {
  const process = child(t, script(`
if(frame.type==='run') send({type:'approval',id:1,proposal:{permission:'edit',command:'Edit synthetic.txt',directory:'/workspace'}});
else if(frame.type==='cancel') send({type:'failed'});
else if(frame.type==='approval' && frame.accepted===true) process.exit(7);`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  const controller = new AbortController(); let finish;
  const pending = runtime.run('Synthetic task', {signal: controller.signal, approve: () => {
    queueMicrotask(() => controller.abort()); return new Promise(resolve => { finish = resolve; });
  }});
  await assert.rejects(pending, error => error.message === 'opencode_runtime_unavailable_or_cleanup_unconfirmed');
  finish(true); await runtime.close(); assert.equal(process.exitCode, 0);
});
test('foreign readiness and replayed permissions fail closed', async t => {
  const wrong = child(t, script('', {ready: {...READY, confidentialRemoteAvailable: true}}));
  await assert.rejects(ownedOpenCode(wrong, {startupMs: 1000, closeMs: 1000}), /opencode_runtime/);
  const replay = child(t, script(`if(frame.type==='run') {
    const event={type:'approval',id:1,proposal:{permission:'bash',command:'synthetic'}}; send(event); send(event);
  }`));
  const runtime = await ownedOpenCode(replay, {startupMs: 1000, closeMs: 1000});
  await assert.rejects(runtime.run('Task', {approve: async () => false}), /opencode_runtime/);
  await assert.rejects(runtime.close(), /opencode_runtime/);
});
test('result text does not conceal failed cleanup or forced process termination', async t => {
  const failed = child(t, script(`if(frame.type==='run') send({type:'result',result:${JSON.stringify(RESULT)}});`, {exitCode: 1}));
  const runtime = await ownedOpenCode(failed, {startupMs: 1000, closeMs: 1000});
  assert.deepEqual(await runtime.run('Task'), RESULT);
  await assert.rejects(runtime.close(), /cleanup_unconfirmed/);
  const stuck = child(t, `process.stdout.write(${JSON.stringify(JSON.stringify(READY) + '\n')});setInterval(()=>{},1000);`);
  const other = await ownedOpenCode(stuck, {startupMs: 1000, closeMs: 20, killMs: 20});
  await assert.rejects(other.close(), /cleanup_unconfirmed/); assert.ok(stuck.signalCode);
});
test('writeFrame refuses closed streams and excessive single frames', () => {
  const stream = new PassThrough(); stream.resume();
  assert.throws(() => writeFrame(stream, {type: 'huge', text: 'x'.repeat(524288)}), /bridge/);
  stream.end(); assert.throws(() => writeFrame(stream, {type: 'closed'}), /bridge/);
});
test('terminal response prevents acceptance of an unresolved approval', async t => {
  const process = child(t, script(`if(frame.type==='run') {
    send({type:'approval',id:1,proposal:{permission:'bash',command:'synthetic'}});
    send({type:'result',result:${JSON.stringify(RESULT)}});
  } else if(frame.type==='approval') process.exit(9);`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  let accept;
  const result = await runtime.run('Task', {approve: () => new Promise(resolve => { accept = resolve; })});
  assert.deepEqual(result, RESULT); accept(true);
  await runtime.close(); assert.equal(process.exitCode, 0);
});
test('unexpected complete stdout EOF rejects an active task promptly', async t => {
  const process = child(t, script(`if(frame.type==='run') process.stdout.end();`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  await assert.rejects(runtime.run('Task'), /opencode_runtime/);
  await assert.rejects(runtime.close(), /opencode_runtime/);
});
test('ignored cancellation has a separate bounded deadline', async t => {
  const process = child(t, script('')); // Intentionally ignores run/cancel.
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000, cancelMs: 20});
  const controller = new AbortController();
  const pending = runtime.run('Task', {signal: controller.signal}); controller.abort();
  await assert.rejects(pending, /opencode_runtime/);
  await assert.rejects(runtime.close(), /opencode_runtime/);
});
test('outbound buffered frames cannot grow beyond the aggregate limit', () => {
  const blocked = new Writable({write(_chunk, _encoding, _callback) {}});
  try {
    writeFrame(blocked, {type: 'synthetic', text: 'x'.repeat(300000)});
    assert.throws(() => writeFrame(blocked, {type: 'synthetic', text: 'y'.repeat(300000)}), /bridge/);
    assert.ok(blocked.writableLength < 524288);
  } finally { blocked.destroy(); }
});
test('second terminal response invalidates the owner receipt', async t => {
  const process = child(t, script(`if(frame.type==='run') {
    send({type:'result',result:${JSON.stringify(RESULT)}});
    send({type:'result',result:${JSON.stringify(RESULT)}});
  }`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  await runtime.run('Task');
  await assert.rejects(runtime.close(), /opencode_runtime/);
});
test('closed primary failure and provider counters survive nonzero owner cleanup', async t => {
  const diagnostics = emptyProviderDiagnostic();
  diagnostics.submitted = 1; diagnostics.request_errors.execution_failed = 1;
  const process = child(t, script(`if(frame.type==='run') send({type:'failed',reason:'opencode_task_native_error',
    task_cleanup_failure:'session_cleanup_unconfirmed',
    diagnostics:${JSON.stringify(diagnostics)}});`, {exitCode: 1}));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  await assert.rejects(runtime.run('Task'), error => error.code === 'opencode_task_native_error'
    && error.taskCleanupFailure === 'session_cleanup_unconfirmed');
  assert.deepEqual(runtime.diagnostics, diagnostics);
  runtime.diagnostics.request_errors.execution_failed = 99;
  assert.equal(runtime.diagnostics.request_errors.execution_failed, 1);
  await assert.rejects(runtime.close(), /cleanup_unconfirmed/);
});
test('diagnostic frames reject private extra fields, unknown reasons and unbounded counts', async t => {
  const diagnostics = emptyProviderDiagnostic();
  for (const extra of [{reason: 'PRIVATE_CANARY'}, {task_cleanup_failure: 'PRIVATE_CANARY'},
    {diagnostics: {...diagnostics, prompt: 'PRIVATE_CANARY'}},
    {diagnostics: {...diagnostics, submitted: 65536}}]) {
    const frame = {type: 'failed', reason: 'opencode_task_native_error', diagnostics, ...extra};
    const process = child(t, script(`if(frame.type==='run') send(${JSON.stringify(frame)});`));
    const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
    await assert.rejects(runtime.run('Task'), error => error.code === 'runtime_failed' && !error.message.includes('CANARY'));
    await assert.rejects(runtime.close(), /cleanup_unconfirmed/);
  }
});
test('closed native lifecycle facts cross the owner bridge in results and failures', async t => {
  const diagnostic = emptyTaskDiagnostic();
  diagnostic.observed_calls = 1; diagnostic.tools.read.running = 1; diagnostic.tools.read.error = 1;
  for (const type of ['result', 'failed']) {
    const frame = type === 'result' ? {type, result: RESULT, task_diagnostics: diagnostic}
      : {type, reason: 'opencode_task_native_error', task_diagnostics: diagnostic};
    const process = child(t, script(`if(frame.type==='run') send(${JSON.stringify(frame)});`));
    const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
    if (type === 'result') assert.deepEqual((await runtime.run('Task')).taskDiagnostics, diagnostic);
    else await assert.rejects(runtime.run('Task'), error => error.code === 'opencode_task_native_error');
    assert.deepEqual(runtime.taskDiagnostics, diagnostic);
    runtime.taskDiagnostics.tools.read.error = 20;
    assert.equal(runtime.taskDiagnostics.tools.read.error, 1);
    await runtime.close();
  }
});
test('native lifecycle bridge rejects raw text, arbitrary tools and malformed counters', async t => {
  const diagnostic = emptyTaskDiagnostic();
  for (const changed of [{...diagnostic, text: 'PRIVATE_CANARY'},
    {...diagnostic, version: 2}, {...diagnostic, observed_calls: -1},
    {...diagnostic, tools: {...diagnostic.tools, PRIVATE_CANARY: {completed: 1}}},
    {...diagnostic, permissions: {...diagnostic.permissions, accepted: 65536}}]) {
    const frame = {type: 'result', result: RESULT, task_diagnostics: changed};
    const process = child(t, script(`if(frame.type==='run') send(${JSON.stringify(frame)});`));
    const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
    await assert.rejects(runtime.run('Task'), error => error.code === 'runtime_failed');
    assert.equal(runtime.taskDiagnostics, null);
    await assert.rejects(runtime.close(), /cleanup_unconfirmed/);
  }
});
test('verification bridge carries actual owner feedback and scoped selected-check status', async t => {
  const verified = {...RESULT, verification: {status: 'passed', checks: 2, continuations: 1}};
  const process = child(t, script(`if(frame.type==='run') {
    if(frame.verification.version!==1 || frame.verification.maxRounds!==2) process.exit(4);
    send({type:'verification',id:1,round:1,remainingMs:1000});
  } else if(frame.type==='verification' && frame.id===1) {
    if(frame.status!=='failed' || frame.feedback!=='Exact check output') process.exit(5);
    send({type:'verification',id:2,round:2,remainingMs:900});
  } else if(frame.type==='verification' && frame.id===2) {
    if(frame.status!=='passed') process.exit(6);
    send({type:'result',result:${JSON.stringify(verified)}});
  } else process.exit(7);`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000});
  const checks = [];
  assert.deepEqual(await runtime.run('Task', {maxVerificationRounds: 2, verify: async context => {
    checks.push(context); return context.round === 1 ? {status: 'failed', feedback: 'Exact check output'}
      : {status: 'passed', feedback: ''};
  }}), verified);
  assert.deepEqual(checks.map(check => [check.round, check.remainingMs]), [[1, 1000], [2, 900]]);
  await runtime.close();
});
test('native owner cannot invent a passing receipt, change its status or continue after unavailable', async t => {
  const claimed = {...RESULT, verification: {status: 'passed', checks: 1, continuations: 0}};
  for (const mode of ['premature', 'rewrite', 'after-unavailable']) {
    const process = child(t, script(`if(frame.type==='run') {
      send({type:'verification',id:1,round:1,remainingMs:1000});
      if(${JSON.stringify(mode)}==='premature') send({type:'result',result:${JSON.stringify(claimed)}});
    } else if(frame.type==='verification') {
      if(${JSON.stringify(mode)}==='after-unavailable') send({type:'verification',id:2,round:2,remainingMs:900});
      else send({type:'result',result:${JSON.stringify(claimed)}});
    }`));
    const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000, cancelMs: 1000});
    await assert.rejects(runtime.run('Task', {verify: async ({signal}) => {
      if (mode === 'premature' && !signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
      return {status: mode === 'rewrite' ? 'failed' : 'unavailable', feedback: 'Actual check status'};
    }}), /opencode_runtime/);
    await assert.rejects(runtime.close(), /opencode_runtime/);
  }
});
test('cancellation joins an active owner verifier before returning, with no late feedback', async t => {
  const process = child(t, script(`if(frame.type==='run') send({type:'verification',id:1,round:1,remainingMs:1000});
    else if(frame.type==='cancel') send({type:'failed',reason:'opencode_task_cancelled'});
    else if(frame.type==='verification') process.exit(8);`));
  const runtime = await ownedOpenCode(process, {startupMs: 1000, closeMs: 1000, cancelMs: 1000});
  const controller = new AbortController(); let joined = false;
  const pending = runtime.run('Task', {signal: controller.signal, verify: ({signal}) => new Promise(resolve => {
    signal.addEventListener('abort', () => setTimeout(() => {
      joined = true; resolve({status: 'unavailable', feedback: ''});
    }, 15), {once: true});
    queueMicrotask(() => controller.abort());
  })});
  await assert.rejects(pending, /opencode_runtime/); assert.equal(joined, true);
  await runtime.close(); assert.equal(process.exitCode, 0);
});
