// SPDX-License-Identifier: GPL-3.0-only
// Actual pinned OpenCode and production provider; SYNTHETIC terminal core output.
// Counts native retries, not model quality, peer execution or confidential compute.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {OpenCodeRuntime} = require('../src/opencode-runtime.cjs');
const {caps, result, reply, fixture} = require('./conversation-fixture.cjs');
const MODEL = 'qwen3-0.6b-v1';
const hash = value => createHash('sha256').update(value).digest('hex');

function syntheticResult(output, conversation) {
  // Negotiating support does not select a policy. Mirror only the policy on
  // the actual request, just as the core's checked result binding requires.
  const selected = Object.hasOwn(conversation, 'generation_policy');
  if (selected) assert.equal(conversation.generation_policy, 'greedy_v1');
  return {...result(output, MODEL), ...(selected ? {generation_policy: conversation.generation_policy} : {})};
}

async function terminalCase(reason, config) {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'volparossa-opencode-error-'));
  await fs.chmod(project, 0o700);
  const marker = 'Disposable synthetic project; no model, user data or authorized tool actions.\n';
  await fs.writeFile(path.join(project, 'README.txt'), marker, {mode: 0o600});
  const cleanups = [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90000);
  let runtime, fixtureError, taskError, submissions = 0, codingSubmissions = 0, approvals = 0;
  const generationPolicies = {unspecified: 0, greedy_v1: 0};
  let phase = 'fixture';
  try {
    const core = await fixture({after: action => cleanups.push(action)}, (socket, message) => {
      try {
        assert.equal(message.operation.type, 'submit_conversation');
        assert.equal(message.operation.conversation.visibility, 'private_local');
        const conversation = message.operation.conversation;
        const selectedPolicy = Object.hasOwn(conversation, 'generation_policy');
        if (selectedPolicy) assert.equal(conversation.generation_policy, 'greedy_v1');
        generationPolicies[selectedPolicy ? 'greedy_v1' : 'unspecified']++;
        assert.ok(++submissions <= 8, 'bounded fixture requests');
        const coding = message.operation.conversation.tools.some(tool => tool.name === 'bash');
        if (coding) {
          assert.equal(conversation.generation_policy, 'greedy_v1', 'native coding must select its configured policy');
          assert.equal(++codingSubmissions, 1, 'terminal output must not cause native regeneration');
        }
        // Titles and other upstream no-tool requests are not the coding task.
        reply(socket, message, 'admitted');
        if (coding && reason === 'execution_budget_exceeded') {
          reply(socket, message, 'error', {code: reason});
        } else {
          const output = coding ? {type: 'incomplete', reason} : {type: 'assistant', text: 'Synthetic retry check'};
          reply(socket, message, 'result', {result: syntheticResult(output, conversation)});
        }
      } catch (error) {
        fixtureError ??= error;
        socket.destroy();
        abort.abort();
      }
    }, {...caps(MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'], execution_error_version: 1});
    phase = 'native_start';
    runtime = await OpenCodeRuntime.start({...config, socketPath: core.socketPath}, {workspace: project});
    phase = 'native_task';
    try {
      await runtime.run('Review README.txt without changing anything. This is a disposable synthetic retry check.', {
        signal: abort.signal,
        approve: async () => { approvals++; return false; },
      });
    } catch (error) { taskError = error; }
    phase = 'terminal_checks';
    if (fixtureError) throw fixtureError;
    assert.equal(abort.signal.aborted, false, 'the original error must terminate without our deadline');
    assert.ok(taskError, 'invalid output must not be a completed answer');
    assert.ok(['opencode_task_native_error', 'opencode_task_incomplete'].includes(taskError.code),
      `unexpected closed error: ${taskError.code}`);
    assert.equal(taskError.taskCleanupFailure, undefined);
    assert.equal(codingSubmissions, 1);
    assert.equal(approvals, 0);
    const diagnostics = runtime.diagnostics;
    const budget = reason === 'execution_budget_exceeded';
    if (!budget) assert.equal(diagnostics.incomplete_reasons[reason], 1);
    assert.equal(diagnostics.request_errors.invalid_model_output, budget ? 0 : 1);
    assert.equal(diagnostics.request_errors.execution_budget_exceeded, budget ? 1 : 0);
    assert.equal(diagnostics.submitted, submissions);
    assert.equal(diagnostics.cleanup_confirmed, submissions);
    assert.equal(diagnostics.incomplete, budget ? 0 : 1);
    assert.equal(await fs.readFile(path.join(project, 'README.txt'), 'utf8'), marker);
    assert.deepEqual(await fs.readdir(project), ['README.txt']);
    phase = 'session_close';
    await runtime.close();
    runtime = null;
    return {reason, coding_submissions: codingSubmissions, auxiliary_submissions: submissions - codingSubmissions,
      native_retry_count: 0, terminal_error: taskError.code, approvals, generation_policies: generationPolicies,
      original_project_unchanged: true, session_cleanup_confirmed: true, provider_diagnostics: diagnostics};
  } catch (error) {
    process.stderr.write(JSON.stringify({reason, phase, coding_submissions: codingSubmissions,
      auxiliary_submissions: submissions - codingSubmissions, approvals,
      task_error: taskError?.code ?? null, provider_diagnostics: runtime?.diagnostics ?? null}) + '\n');
    throw error;
  } finally {
    clearTimeout(timer);
    try { if (runtime) await runtime.close(); }
    finally {
      for (const action of cleanups.reverse()) await action();
      // Only the exact disposable mkdtemp project owned by this case is removed.
      await fs.rm(project, {recursive: true, force: false});
    }
  }
}

async function main(args = process.argv.slice(2)) {
  if (!args.includes('--execute')) {
    process.stdout.write(JSON.stringify({execute: false, model_inference: false, peer_execution: false,
      usage: '--execute --node /absolute/node --build-report /absolute/build-report.json '
        + '--report /same/build/directory/native-errors-SUFFIX.json'}) + '\n');
    return;
  }
  assert.equal(args.length, 7);
  assert.deepEqual([args[0], args[1], args[3], args[5]], ['--execute', '--node', '--build-report', '--report']);
  const node = args[2], buildReport = args[4], output = args[6];
  for (const file of [node, buildReport]) {
    assert.equal(await fs.realpath(file), file);
    const info = await fs.stat(file);
    assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o6022, 0); assert.ok(info.isFile());
  }
  assert.equal(path.dirname(output), path.dirname(buildReport));
  assert.match(path.basename(output), /^native-errors-[a-z0-9-]+\.json$/);
  try { await fs.access(output); throw Error('existing-native-error-report'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const report = JSON.parse(await fs.readFile(buildReport, 'utf8'));
  assert.equal(report.source_build, true);
  assert.equal(report.runtime_version, '1.18.34');
  const config = {version: 1, opencode: report.binary, opencodeSha256: report.binary_sha256,
    buildReport, node, nodeSha256: hash(await fs.readFile(node))};
  const cases = [];
  for (const reason of ['invalid_output', 'wire_truncated', 'execution_budget_exceeded']) cases.push(await terminalCase(reason, config));
  const evidence = {version: 1, native_runtime: true, runtime_version: report.runtime_version,
    source_commit: report.source_commit, binary_sha256: report.binary_sha256, node_sha256: config.nodeSha256,
    provider_sha256: hash(await fs.readFile(path.join(__dirname, '../src/chat-completions-provider.cjs'))),
    test_sha256: hash(await fs.readFile(__filename)), production_runtime_launcher: true,
    production_chat_completions_provider: true, synthetic_private_conversation_core: true,
    model_inference: false, peer_execution: false, confidential_remote_execution: false, cases};
  await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  process.stdout.write(JSON.stringify({...evidence, report: output}) + '\n');
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`Native retry check failed: ${String(error.message).slice(0, 200)}\n`);
  process.exitCode = 1;
});
module.exports = {main, syntheticResult};
