// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const path = require('node:path');
const {spawn} = require('node:child_process');
const {MODEL, isCodingModel} = require('./opencode-config.cjs');
const {OUTPUT_CONSTRAINT} = require('./private-conversation.cjs');
const {readFrames, writeFrame, record, isFailureCode, validProviderDiagnostic, validTaskDiagnostic,
  validVerification, validVerificationSummary} = require('./opencode-bridge.cjs');
const FIELDS = ['version', 'opencode', 'opencodeSha256', 'buildReport', 'node', 'nodeSha256', 'socketPath'];
const fail = (code = 'runtime_failed') => Object.assign(Error('opencode_runtime_unavailable_or_cleanup_unconfirmed'), {code});
function configuration(value, workspace) {
  if (!record(value) || value.version !== 1 || !FIELDS.every(key => Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !FIELDS.includes(key) && key !== 'outputConstraint') ||
      Object.hasOwn(value, 'outputConstraint') && value.outputConstraint !== OUTPUT_CONSTRAINT) throw fail();
  for (const key of FIELDS.slice(1)) {
    const item = value[key];
    if (typeof item !== 'string' || !item || item.includes('\0') || Buffer.byteLength(item) > 4096 ||
        (key.endsWith('Sha256') ? !/^[a-f0-9]{64}$/.test(item) : !path.isAbsolute(item))) throw fail();
  }
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.includes('\0') ||
      Buffer.byteLength(workspace) > 4096) throw fail();
  return {...value};
}
async function ownedOpenCode(child, {startupMs = 30000, closeMs = 45000, killMs = 5000, cancelMs = 45000} = {}) {
  if (![startupMs, closeMs, killMs, cancelMs].every(value => Number.isInteger(value) && value > 0 && value <= 60000) ||
      cancelMs > 45000) throw fail();
  let terminal, run, used = false, closing, settled = false, readyResolve, readyReject, protocolBad = false;
  let diagnostics = null, taskDiagnostics = null;
  let modelProfile = MODEL;
  const verifiers = new Set();
  async function joinVerifier(work) {
    if (!work) return;
    let timer;
    try {
      await Promise.race([work, new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail('opencode_task_verification_cleanup_unconfirmed')), cancelMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  function complete(error, result) {
    if (!run || run.finished) return;
    run.finished = true; clearTimeout(run.cancelTimer);
    if (error) run.reject(error); else run.resolve(result);
  }
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise(resolve => {
    const done = (code, signal) => {
      terminal ??= {code, signal}; resolve(terminal); readyReject(fail()); complete(fail());
    };
    child.once('error', () => done(null, 'spawn_failed')); child.once('close', done);
  });
  function bad() { protocolBad = true; run?.verificationController?.abort(); readyReject(fail()); complete(fail()); child.stdin.end(); }
  const unbind = readFrames(child.stdout, value => {
    if (protocolBad) return;
    if (!settled) {
      if (value.type !== 'ready' || value.version !== 1 || value.execution !== 'private_local' ||
          value.confidentialRemoteAvailable !== false ||
          Object.hasOwn(value, 'modelProfile') && !isCodingModel(value.modelProfile)) { bad(); return; }
      // Legacy version-1 owners only supported the fixed 0.6B profile. Missing
      // identity therefore preserves that compatibility, never implies 4B.
      modelProfile = Object.hasOwn(value, 'modelProfile') ? value.modelProfile : MODEL;
      settled = true; readyResolve(); return;
    }
    if (!run || run.finished) { bad(); return; }
    if (['result', 'failed'].includes(value.type) && value.diagnostics !== undefined) {
      if (!validProviderDiagnostic(value.diagnostics)) { bad(); return; }
      diagnostics = value.diagnostics;
    }
    if (['result', 'failed'].includes(value.type) && value.task_diagnostics !== undefined) {
      if (!validTaskDiagnostic(value.task_diagnostics)) { bad(); return; }
      taskDiagnostics = value.task_diagnostics;
    }
    if (value.type === 'verification') {
      if (Object.keys(value).length !== 4 || !run.verify || run.stopped || run.verificationWork ||
          !Number.isSafeInteger(value.id) || value.id <= run.lastVerification ||
          value.round !== run.lastVerificationRound + 1 || value.round > run.maxVerificationRounds ||
          value.round > 1 && run.lastVerificationStatus !== 'failed' ||
          !Number.isSafeInteger(value.remainingMs) || value.remainingMs < 1 || value.remainingMs > 2400000) { bad(); return; }
      const active = run, controller = new AbortController();
      active.lastVerification = value.id; active.lastVerificationRound = value.round;
      active.lastVerificationStatus = null;
      active.verificationController = controller;
      const answer = receipt => {
        if (!validVerification(receipt)) { bad(); return; }
        if (active === run && !active.stopped && !active.finished && !closing && !protocolBad && !terminal) {
          active.lastVerificationStatus = receipt.status;
          try { writeFrame(child.stdin, {type: 'verification', id: value.id, ...receipt}); } catch { bad(); }
        }
      };
      const work = Promise.resolve().then(() => active.verify({round: value.round,
        remainingMs: value.remainingMs, signal: controller.signal})).then(answer,
        () => answer({status: 'unavailable', feedback: ''})).finally(() => {
        verifiers.delete(work);
        if (active.verificationWork === work) {
          active.verificationWork = null; active.verificationController = null;
        }
      });
      active.verificationWork = work; verifiers.add(work);
    } else if (value.type === 'approval') {
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || value.id <= run.lastApproval ||
          !record(value.proposal) || !['bash', 'edit'].includes(value.proposal.permission)) { bad(); return; }
      run.lastApproval = value.id;
      const active = run;
      Promise.resolve().then(() => active.approve(value.proposal)).then(accepted => {
        if (active === run && !active.stopped && !active.finished && !protocolBad && !terminal) {
          writeFrame(child.stdin, {type: 'approval', id: value.id, accepted: accepted === true});
        }
      }).catch(() => {
        if (active === run && !active.stopped && !active.finished && !protocolBad && !terminal) {
          try { writeFrame(child.stdin, {type: 'approval', id: value.id, accepted: false}); } catch { bad(); }
        }
      });
    } else if (value.type === 'status') {
      if (!Number.isSafeInteger(value.commands) || value.commands < run.lastCommands || value.commands > 1024 ||
          !['completed', 'failed'].includes(value.status)) { bad(); return; }
      run.lastCommands = value.commands;
      run.onStatus({commands: value.commands, status: value.status});
    } else if (value.type === 'result') {
      const result = value.result;
      if (!record(result) || result.nativeTurnCompleted !== true || result.taskVerified !== false ||
          typeof result.text !== 'string' || Buffer.byteLength(result.text) > 65536 ||
          !Number.isSafeInteger(result.commands) || result.commands < run.lastCommands || result.commands > 1024 || run.stopped ||
          (run.verify ? !validVerificationSummary(result.verification) || result.verification.checks !== run.lastVerificationRound
              || result.verification.status !== run.lastVerificationStatus
              || result.verification.continuations !== result.verification.checks - 1
            : result.verification !== undefined)) { bad(); return; }
      complete(null, taskDiagnostics === null ? result : {...result,
        taskDiagnostics: JSON.parse(JSON.stringify(taskDiagnostics))});
    } else if (value.type === 'failed') {
      if (value.reason !== undefined && !isFailureCode(value.reason)) { bad(); return; }
      if (value.task_cleanup_failure != null && value.task_cleanup_failure !== 'session_cleanup_unconfirmed') { bad(); return; }
      const error = fail(value.reason);
      if (value.task_cleanup_failure) error.taskCleanupFailure = value.task_cleanup_failure;
      complete(error);
    }
    else bad();
  }, bad);
  child.stdin.on('error', bad);
  const outputEnded = () => {
    if (!closing && (!settled || run && !run.finished)) bad();
  };
  child.stdout.on('end', outputEnded); child.stdout.on('close', outputEnded);
  // Raw runtime output is never returned as an editor error or persisted.
  let stderr = 0;
  child.stderr.on('data', data => { stderr += data.length; if (stderr > 1048576) bad(); });
  child.stderr.on('error', bad);
  async function close() {
    closing ??= (async () => {
      if (run) run.stopped = true;
      run?.verificationController?.abort();
      child.stdin.end();
      let timer, hard, forced = false;
      try {
        const finished = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), closeMs); })]);
        if (!finished) {
          forced = true; child.kill('SIGTERM'); hard = setTimeout(() => child.kill('SIGKILL'), killMs); await exited;
        }
      } finally {
        clearTimeout(timer); clearTimeout(hard); unbind();
        child.stdout.off('end', outputEnded); child.stdout.off('close', outputEnded);
      }
      await Promise.all([...verifiers].map(joinVerifier));
      if (forced || protocolBad || terminal?.code !== 0 || terminal?.signal) throw fail();
    })();
    return closing;
  }
  let timer;
  try {
    await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(fail()), startupMs); })]);
    if (terminal || protocolBad) throw fail();
  } catch (error) { try { await close(); } catch {} throw error; }
  finally { clearTimeout(timer); }
  const stop = () => {
    if (!run || run.stopped || run.finished) return;
    run.stopped = true;
    run.verificationController?.abort();
    run.cancelTimer = setTimeout(bad, cancelMs);
    try { writeFrame(child.stdin, {type: 'cancel'}); } catch { bad(); }
  };
  return {close, stop, execution: 'private_local', confidentialRemoteAvailable: false, modelProfile,
    get diagnostics() { return diagnostics === null ? null : JSON.parse(JSON.stringify(diagnostics)); },
    get taskDiagnostics() { return taskDiagnostics === null ? null : JSON.parse(JSON.stringify(taskDiagnostics)); },
    async run(prompt, {signal, approve = async () => false, onStatus = () => {}, verify, maxVerificationRounds = 3} = {}) {
      if (used || terminal || protocolBad || typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') ||
          Buffer.byteLength(prompt) > 65536 || typeof approve !== 'function' || typeof onStatus !== 'function' ||
          verify !== undefined && typeof verify !== 'function' || !Number.isSafeInteger(maxVerificationRounds) ||
          maxVerificationRounds < 1 || maxVerificationRounds > 16) throw fail();
      used = true;
      const done = new Promise((resolve, reject) => { run = {
        resolve, reject, approve, onStatus, verify, maxVerificationRounds,
        lastVerification: 0, lastVerificationRound: 0, lastVerificationStatus: null,
        verificationWork: null, verificationController: null,
        lastApproval: 0, lastCommands: 0, stopped: false, finished: false, cancelTimer: null,
      }; });
      signal?.addEventListener('abort', stop, {once: true});
      const deadline = setTimeout(() => { stop(); complete(fail()); }, 2430000);
      try {
        if (signal?.aborted) throw fail();
        writeFrame(child.stdin, {type: 'run', prompt,
          ...(verify ? {verification: {version: 1, maxRounds: maxVerificationRounds}} : {})});
        return await done;
      } finally {
        const active = run;
        clearTimeout(deadline); clearTimeout(active?.cancelTimer); signal?.removeEventListener('abort', stop);
        if (active) { active.stopped = true; active.verificationController?.abort(); }
        try { await joinVerifier(active?.verificationWork); } finally { run = null; }
      }
    },
  };
}
class OpenCodeRuntime {
  static async start(config, {workspace, cooperation} = {}) {
    const checked = configuration(config, workspace);
    if (process.platform !== 'linux') throw fail();
    let publicTool;
    try {
      if (cooperation !== undefined) {
        if (!record(cooperation) || Object.keys(cooperation).length !== 2 ||
            typeof cooperation.socketPath !== 'string' || !Object.hasOwn(cooperation, 'snapshot')) throw fail();
        publicTool = await require('./cooperative-tool-server.cjs').startCooperativeTool(cooperation);
        // Never pass the actual public-service socket or its identity credentials
        // into OpenCode. This proxy exports only the exact owner-enrolled snapshot.
        checked.cooperativeSocketPath = publicTool.socketPath;
      }
      const child = spawn('/usr/bin/python3', ['-B', path.resolve(__dirname, '../scripts/opencode_session.py'),
        '--execute', JSON.stringify(checked), workspace], {
        cwd: '/', env: {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'}, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const runtime = await ownedOpenCode(child);
      if (!publicTool) return runtime;
      let closing;
      return {...runtime, publicDelegation: publicTool.observations,
        get diagnostics() { return runtime.diagnostics; },
        get taskDiagnostics() { return runtime.taskDiagnostics; },
        close() {
          closing ??= (async () => {
            const outcomes = await Promise.allSettled([runtime.close(), publicTool.close()]);
            if (outcomes.some(outcome => outcome.status === 'rejected')) throw fail();
          })();
          return closing;
        },
      };
    } catch (error) {
      if (publicTool) await publicTool.close().catch(() => {});
      throw error;
    }
  }
}
module.exports = {OpenCodeRuntime, configuration, ownedOpenCode};
