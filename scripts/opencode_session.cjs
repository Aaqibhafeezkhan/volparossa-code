// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Runs only inside the owner-selected disposable namespace. Stdio is the
// editor bridge; OpenCode HTTP, credentials and model transport stay inside.
const fs = require('node:fs');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {setTimeout: delay} = require('node:timers/promises');
const {OpenCodeClient} = require('../src/opencode-client.cjs');
const {OpenCodeTask} = require('../src/opencode-task.cjs');
const {PrivateConversation, capabilities, OUTPUT_CONSTRAINT} = require('../src/private-conversation.cjs');
const {startChatCompletionsProvider} = require('../src/chat-completions-provider.cjs');
const {runtimeSettings, isCodingModel} = require('../src/opencode-config.cjs');
const {readFrames, writeFrame, taskFailure, record, validVerification} = require('../src/opencode-bridge.cjs');
const COOPERATIVE_SOCKET = '/opt/core/cooperative.sock';
const TERMINAL_TASK_ERRORS = new Set(['opencode_task_native_error', 'opencode_task_incomplete',
  'opencode_task_cancelled', 'opencode_cancelled']);

function cooperativeMounted() {
  let info;
  try { info = fs.lstatSync(COOPERATIVE_SOCKET); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const parent = fs.lstatSync('/opt/core');
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600 ||
      !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700) throw Error('cooperative-scope');
  return true;
}

function prepareState(cooperative) {
  for (const name of ['config', 'cache', 'data', 'state']) fs.mkdirSync(`/opt/state/${name}`, {recursive: true, mode: 0o700});
  if (!cooperative) return;
  const directory = '/opt/state/config/opencode/tools';
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.copyFileSync('/opt/src/opencode-cooperative-tool.js', `${directory}/volparossa.js`, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(`${directory}/volparossa.js`, 0o400);
  fs.chmodSync(directory, 0o500);
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return value;
}
async function runSession({input, output, events = process, outputConstraint}, hooks = {}) {
  if (outputConstraint !== undefined && outputConstraint !== OUTPUT_CONSTRAINT) return 1;
  const spawnServer = hooks.spawn ?? spawn;
  let provider, child, exited, client, task, running, closing = false, bad = false, requested = false;
  let nativeSession = false, providerClosing;
  const closeProvider = () => providerClosing ??= provider.close();
  let seq = 0, verificationSeq = 0, pendingApproval, pendingVerification, finish;
  const expiredApprovals = new Set();
  const expiredVerifications = new Set();
  const ended = new Promise(resolve => { finish = resolve; });
  const abort = new AbortController();
  const send = value => { try { writeFrame(output, value); } catch { broken(); } };
  const stop = () => {
    closing = true; abort.abort(); pendingApproval?.resolve(false); pendingApproval = null;
    pendingVerification?.cancel(); finish();
  };
  const broken = () => { bad = true; stop(); };
  const approve = proposal => new Promise(resolve => {
    if (closing || abort.signal.aborted || pendingApproval) { resolve(false); return; }
    const id = ++seq;
    if (id > 1024) { resolve(false); broken(); return; }
    const timer = setTimeout(() => {
      expiredApprovals.add(id); pendingApproval?.resolve(false);
    }, hooks.approvalMs ?? 29000);
    pendingApproval = {id, resolve(value) {
      clearTimeout(timer); if (pendingApproval?.id === id) pendingApproval = null;
      resolve(value === true);
    }};
    send({type: 'approval', id, proposal});
  });
  const cancelApproval = () => { pendingApproval?.resolve(false); };
  abort.signal.addEventListener('abort', cancelApproval);
  const verify = ({round, remainingMs, signal}) => new Promise(resolve => {
    if (closing || abort.signal.aborted || signal.aborted || pendingVerification ||
        !Number.isSafeInteger(remainingMs) || remainingMs < 1) {
      resolve({status: 'unavailable', feedback: ''}); return;
    }
    const id = ++verificationSeq;
    const finishCheck = value => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      if (pendingVerification?.id === id) pendingVerification = null;
      resolve(value);
    };
    const cancel = () => {
      expiredVerifications.add(id); finishCheck({status: 'unavailable', feedback: ''});
    };
    const timer = setTimeout(cancel, remainingMs);
    pendingVerification = {id, resolve: finishCheck, cancel};
    signal.addEventListener('abort', cancel, {once: true});
    send({type: 'verification', id, round, remainingMs});
  });
  const unbind = readFrames(input, value => {
    if (value.type === 'cancel' && Object.keys(value).length === 1) { abort.abort(); return; }
    if (value.type === 'approval' && Object.keys(value).length === 3 && typeof value.accepted === 'boolean' &&
        expiredApprovals.delete(value.id)) return;
    if (value.type === 'approval' && Object.keys(value).length === 3 && typeof value.accepted === 'boolean' &&
        pendingApproval && value.id === pendingApproval.id) {
      pendingApproval.resolve(value.accepted && !abort.signal.aborted); pendingApproval = null; return;
    }
    if (value.type === 'verification' && Object.keys(value).length === 4 &&
        validVerification({status: value.status, feedback: value.feedback})) {
      if (expiredVerifications.delete(value.id)) return;
      if (pendingVerification && value.id === pendingVerification.id) {
        pendingVerification.resolve({status: value.status, feedback: value.feedback}); return;
      }
    }
    const verification = value.verification;
    const selectionValid = verification === undefined || record(verification) && Object.keys(verification).length === 2 &&
      verification.version === 1 && Number.isSafeInteger(verification.maxRounds) && verification.maxRounds >= 1 && verification.maxRounds <= 16;
    if (value.type !== 'run' || Object.keys(value).length !== (verification === undefined ? 2 : 3) ||
        !selectionValid || requested || !task || closing ||
        typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.includes('\0') ||
        Buffer.byteLength(value.prompt) > 65536) { broken(); return; }
    requested = true;
    running = task.run(value.prompt, {signal: abort.signal,
      ...(verification ? {verify, maxVerificationRounds: verification.maxRounds} : {})}).then(async result => {
      // One ordinary OpenCode task owns the warm model connection. Its final
      // result is not released to the owner before private session state is gone.
      if (nativeSession) await closeProvider();
      if (!closing) send({type: 'result', result, diagnostics: provider?.diagnostics?.summary ?? null,
        task_diagnostics: task.diagnostics ?? null});
    }).catch(async error => {
      if (nativeSession) { try { await closeProvider(); } catch { bad = true; } }
      const reason = taskFailure(error);
      // A refused/incomplete/cancelled task is still a failed task, not proof of
      // failed runtime cleanup. OpenCodeTask has already awaited session deletion;
      // provider and process cleanup must independently succeed below. Unknown or
      // protocol failures and any unconfirmed session cleanup remain owner failures.
      if (!TERMINAL_TASK_ERRORS.has(reason) || error?.taskCleanupFailure != null) bad = true;
      if (!closing) send({type: 'failed', reason,
        task_cleanup_failure: error?.taskCleanupFailure === 'session_cleanup_unconfirmed' ? 'session_cleanup_unconfirmed' : null,
        diagnostics: provider?.diagnostics?.summary ?? null, task_diagnostics: task.diagnostics ?? null});
    });
  }, broken);
  input.once('end', stop); input.once('close', stop); output.once('error', broken);
  for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.once(name, broken);
  try {
    const caps = capabilities(await (hooks.preflight ?? (async () => {
      const core = new PrivateConversation('/opt/core/compute.sock', {generationPolicyVersion: 1, executionErrorVersion: 1,
        ...(outputConstraint !== undefined ? {outputConstraintVersion: 1} : {})});
      try {
        return await core.connect();
      } finally { core.close(); }
    }))(), 1, 1, outputConstraint !== undefined ? 1 : undefined);
    if (!isCodingModel(caps.model_profile) || !caps.native_tool_template || !caps.local_only ||
        caps.quarantined || !caps.generation_policies.includes('greedy_v1')) throw Error('capabilities');
    if (outputConstraint !== undefined && !caps.output_constraints.includes(outputConstraint)) throw Error('capabilities');
    // The owner's already selected core determines this session's one model.
    // Each provider request rechecks that identity; a core change cannot silently
    // switch the native task to another profile or provider.
    const model = caps.model_profile;
    nativeSession = caps.inference_backend === 'llama_cpp_bf16_v1';
    if (closing) throw Error('closed');
    provider = await (hooks.provider ?? startChatCompletionsProvider)({socketPath: '/opt/core/compute.sock', model,
      diagnostics: true, nativeSession,
      ...(outputConstraint !== undefined ? {outputConstraint} : {})});
    const password = randomBytes(32).toString('hex');
    const cooperative = (hooks.cooperative ?? cooperativeMounted)();
    const settings = runtimeSettings({baseUrl: provider.baseUrl, bearerToken: provider.bearerToken, password, cooperative, model});
    (hooks.prepare ?? prepareState)(cooperative);
    const listen = await (hooks.port ?? port)();
    child = spawnServer('/opt/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(listen)], {
      cwd: '/workspace', env: settings.env, stdio: ['ignore', 'ignore', 'ignore'],
    });
    exited = new Promise(resolve => {
      child.once('error', () => { broken(); resolve({code: null, signal: 'spawn_failed'}); });
      child.once('close', (code, signal) => { if (!closing) broken(); resolve({code, signal}); });
    });
    const deadline = Date.now() + 25000;
    while (!closing && Date.now() < deadline) {
      const Client = hooks.Client ?? OpenCodeClient;
      client = new Client({baseUrl: `http://127.0.0.1:${listen}`, password,
        username: 'volparossa', workspace: '/workspace', timeoutMs: 1000, cooperative});
      try { await client.connect(); break; }
      catch { client.close(); await delay(100); }
    }
    if (closing || !client?.ready) throw Error('startup');
    // Short readiness probes must not shorten normal permission/cleanup RPCs.
    client.timeoutMs = 30000;
    const Task = hooks.Task ?? OpenCodeTask;
    task = new Task(client, approve, {model, onStatus: status => send({type: 'status', ...status})});
    send({type: 'ready', version: 1, execution: 'private_local', confidentialRemoteAvailable: false, modelProfile: model});
    await ended;
  } catch { bad = true; }
  finally {
    stop();
    if (running) { try { await running; } catch { bad = true; } }
    client?.close();
    if (provider) {
      try {
        await closeProvider();
        if (provider.observations.submitted !== provider.observations.cleanup_confirmed) bad = true;
      } catch { bad = true; }
    }
    if (child) {
      child.kill('SIGTERM');
      let timer;
      const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
      clearTimeout(timer);
      if (!result) { bad = true; child.kill('SIGKILL'); await exited; }
      else if (!(result.code === 0 || result.signal === 'SIGTERM')) bad = true;
    }
    abort.signal.removeEventListener('abort', cancelApproval);
    unbind(); input.off('end', stop); input.off('close', stop); output.off('error', broken);
    for (const name of ['SIGTERM', 'SIGINT', 'SIGHUP']) events.off(name, broken);
  }
  return bad ? 1 : 0;
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.cwd() !== '/workspace' ||
      Object.keys(process.env).some(key => !['PATH', 'LANG'].includes(key))) return 1;
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--output-constraint' || args[1] !== OUTPUT_CONSTRAINT)) return 1;
  return runSession({input: process.stdin, output: process.stdout,
    ...(args.length ? {outputConstraint: OUTPUT_CONSTRAINT} : {})});
}
if (require.main === module) main().then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
module.exports = {runSession, cooperativeMounted, prepareState};
