// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Owner orchestration with synthetic dependencies; not native runtime proof.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {EventEmitter} = require('node:events');
const {runSession} = require('../scripts/opencode_session.cjs');
const {readFrames, writeFrame, emptyProviderDiagnostic, emptyTaskDiagnostic} = require('../src/opencode-bridge.cjs');
const {startChatCompletionsProvider} = require('../src/chat-completions-provider.cjs');
const {fixture: coreFixture, caps, result: coreResult, reply} = require('./conversation-fixture.cjs');
const DEFAULT_MODEL = 'qwen3-0.6b-v1';

function fixture(Task, receive, options = {}) {
  const input = new PassThrough(), output = new PassThrough(), events = new EventEmitter(), observed = [];
  const binding = {};
  const provider = options.provider ?? {baseUrl: 'http://127.0.0.1:1234/v1', bearerToken: 'a'.repeat(64),
    diagnostics: {summary: emptyProviderDiagnostic()},
    observations: options.observations ?? {submitted: 0, cleanup_confirmed: 0},
    async close() { observed.push('provider-close'); if (options.badCleanup) throw Error('private detail'); }};
  const hooks = {Task, preflight: async () => options.capabilities ??
    {...caps(options.model ?? DEFAULT_MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'],
      execution_error_version: 1},
    provider: async value => { binding.provider = value.model; binding.outputConstraint = value.outputConstraint;
      binding.nativeSession = value.nativeSession; return provider; },
    prepare(cooperative) { assert.equal(cooperative, options.cooperative ?? false); },
    cooperative: () => options.cooperative ?? false, port: async () => 1235, approvalMs: 15,
    spawn(binary, args, config) {
      assert.equal(binary, '/opt/opencode'); assert.equal(config.env.OPENCODE_PURE, '1');
      binding.settings = JSON.parse(config.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(config.env.OPENAI_API_KEY, undefined); assert.equal(args[0], 'serve');
      assert.equal(JSON.parse(config.env.OPENCODE_CONFIG_CONTENT).permission.volparossa_delegate_public,
        options.cooperative ? 'allow' : undefined);
      const child = new EventEmitter();
      child.kill = signal => { observed.push(signal); queueMicrotask(() => child.emit('close', null, signal)); };
      return child;
    },
    Client: class {
      constructor(options_) { assert.equal(options_.cooperative, options.cooperative ?? false); }
      async connect() { this.ready = true; } close() { observed.push('client-close'); }
    },
  };
  const unbind = readFrames(output, value => {
    observed.push(value.type);
    if (value.type === 'ready') {
      binding.ready = value.modelProfile;
      writeFrame(input, {type: 'run', prompt: 'Synthetic task',
        ...(options.verification ? {verification: options.verification} : {})});
    }
    else receive(value, input);
  }, () => assert.fail('owner frame'));
  return {observed, input, binding, done: runSession({input, output, events,
    outputConstraint: options.outputConstraint}, hooks).finally(unbind)};
}
const result = {text: 'Fixture only', commands: 0, nativeTurnCompleted: true, taskVerified: false};
test('explicit constraint is negotiated before runtime startup and bound to the provider', async () => {
  const selected = 'qwen_tagged_tool_json_v1', model = 'qwen3-4b-instruct-2507-v1';
  class Task { async run() { return result; } }
  const capabilities = {...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'],
    execution_error_version: 1, inference_backend: 'llama_cpp_bf16_v1', required_generation_policy: 'greedy_v1',
    output_constraint_version: 1, output_constraints: [selected]};
  const f = fixture(Task, (_value, input) => input.end(), {model, capabilities, outputConstraint: selected});
  assert.equal(await f.done, 0);
  assert.equal(f.binding.outputConstraint, selected);
  assert.equal(f.binding.nativeSession, true);
  assert.deepEqual(f.observed, ['ready', 'provider-close', 'result', 'client-close', 'SIGTERM']);
  for (const output_constraints of [[], undefined]) {
    const rejected = fixture(Task, (_value, input) => input.end(), {model, outputConstraint: selected,
      capabilities: {...capabilities, output_constraints}});
    assert.equal(await rejected.done, 1);
    assert.equal(rejected.binding.provider, undefined);
  }
});
test('owner connects pinned runtime, forwards exact approvals and waits for core/process cleanup', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run(prompt) {
      assert.equal(prompt, 'Synthetic task');
      assert.equal(await this.approve({permission: 'edit', command: 'fixture', directory: '/workspace'}), true);
      return result;
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval') writeFrame(input, {type: 'approval', id: value.id, accepted: true});
    else if (value.type === 'result') { assert.deepEqual(value.result, result); input.end(); }
  });
  assert.equal(await f.done, 0);
  assert.deepEqual(f.observed, ['ready', 'approval', 'result', 'client-close', 'provider-close', 'SIGTERM']);
});

test('owner-selected validated 4B core binds provider, native catalog and task before startup', async () => {
  const model = 'qwen3-4b-instruct-2507-v1';
  let taskModel;
  class Task {
    constructor(_client, _approve, options) { taskModel = options.model; }
    async run() { return result; }
  }
  const f = fixture(Task, (_value, input) => input.end(), {model});
  assert.equal(await f.done, 0);
  assert.equal(f.binding.provider, model); assert.equal(taskModel, model);
  assert.equal(f.binding.ready, model);
  assert.equal(f.binding.settings.model, `volparossa/${model}`);
  assert.deepEqual(Object.keys(f.binding.settings.provider.volparossa.models), [model]);
});

test('incompatible, widened or quarantined core fails before provider or native startup', async () => {
  const model = 'qwen3-4b-instruct-2507-v1';
  for (const changed of [{quarantined: true}, {local_only: false}, {max_prompt_tokens: 262144},
    {generation_policies: []}, {execution_error_version: undefined}, {execution_error_version: 2},
    {model_profile: 'unreviewed-model'}]) {
    class Task { constructor() { assert.fail('must not create task'); } }
    const f = fixture(Task, () => assert.fail('must not signal ready'), {capabilities: {
      ...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'], execution_error_version: 1, ...changed,
    }});
    assert.equal(await f.done, 1);
    assert.deepEqual(f.binding, {}); assert.deepEqual(f.observed, []);
  }
});
test('expired approval does not prevent subsequent requests or accept a late response', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run() {
      assert.equal(await this.approve({permission: 'bash', command: 'one'}), false);
      assert.equal(await this.approve({permission: 'bash', command: 'two'}), true);
      return result;
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval' && value.id === 2) {
      writeFrame(input, {type: 'approval', id: 1, accepted: true});
      writeFrame(input, {type: 'approval', id: 2, accepted: true});
    } else if (value.type === 'result') input.end();
  });
  assert.equal(await f.done, 0);
});
test('unconfirmed provider cleanup produces failed owner exit after a generated result', async () => {
  class Task { async run() { return result; } }
  const f = fixture(Task, (_value, input) => input.end(), {badCleanup: true});
  assert.equal(await f.done, 1); assert(f.observed.includes('SIGTERM'));
});

test('owner cleanup accepts an actual provider retry after a correlated reaped failure', async t => {
  const model = 'qwen3-0.6b-v1';
  let attempts = 0;
  const core = await coreFixture(t, (socket, request) => {
    reply(socket, request, 'admitted');
    if (++attempts === 1) reply(socket, request, 'error', {code: 'execution_failed'});
    else reply(socket, request, 'result', {result: coreResult(undefined, model)});
  }, {...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'], execution_error_version: 1});
  const provider = await startChatCompletionsProvider({socketPath: core.socketPath, model, diagnostics: true});
  class Task {
    async run() {
      for (const status of [503, 200]) {
        const response = await fetch(provider.baseUrl + '/chat/completions', {
          method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${provider.bearerToken}`},
          body: JSON.stringify({model, messages: [{role: 'user', content: 'Synthetic protocol input.'}]}),
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(response.status, status); await response.json();
      }
      return result;
    }
  }
  try {
    const f = fixture(Task, (value, input) => {
      assert.equal(value.type, 'result'); input.end();
    }, {provider});
    assert.equal(await f.done, 0);
    assert.deepEqual(provider.observations, {submitted: 2, completed: 1, incomplete: 0, cleanup_confirmed: 2});
    assert.ok(f.observed.includes('SIGTERM'));
  } finally { await provider.close(); }
});
test('cancellation resolves pending approval without granting the operation', async () => {
  class Task {
    constructor(_client, approve) { this.approve = approve; }
    async run(_prompt, {signal}) {
      assert.equal(await this.approve({permission: 'bash', command: 'cancelled'}), false);
      assert.equal(signal.aborted, true); throw Error('cancelled');
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'approval') writeFrame(input, {type: 'cancel'});
    else if (value.type === 'failed') input.end();
  });
  assert.equal(await f.done, 1);
});
test('inner owner enables public-snapshot tool only when proxy mount is present', async () => {
  class Task { async run() { return result; } }
  const f = fixture(Task, (_value, input) => input.end(), {cooperative: true});
  assert.equal(await f.done, 0);
});
test('terminal task failure stays a failed frame while confirmed runtime cleanup succeeds independently', async () => {
  for (const message of ['opencode_task_native_error', 'opencode_task_incomplete',
    'opencode_task_cancelled', 'opencode_cancelled', 'PRIVATE_CANARY']) {
    class Task { async run() { throw Error(message); } }
    let failed;
    const f = fixture(Task, (value, input) => { failed = value; input.end(); },
      {observations: {submitted: 1, cleanup_confirmed: 1}});
    assert.equal(await f.done, message === 'PRIVATE_CANARY' ? 1 : 0);
    assert.equal(failed.type, 'failed');
    assert.equal(failed.reason, message === 'PRIVATE_CANARY' ? 'task_or_runtime_failed' : message);
    assert.deepEqual(failed.diagnostics, emptyProviderDiagnostic());
    assert.ok(!JSON.stringify(failed).includes('PRIVATE_CANARY'));
    assert.equal(f.observed.filter(value => value === 'failed').length, 1);
    assert.ok(!f.observed.includes('result'));
    assert(f.observed.includes('provider-close')); assert(f.observed.includes('SIGTERM'));
  }
});
test('task cleanup uncertainty, protocol failures and provider cleanup mismatches still fail owner cleanup', async () => {
  for (const {error, options} of [
    {error: Object.assign(Error('opencode_task_native_error'), {taskCleanupFailure: 'session_cleanup_unconfirmed'})},
    {error: Object.assign(Error('opencode_task_native_error'), {taskCleanupFailure: 'UNKNOWN_PRIVATE_REASON'})},
    {error: Error('opencode_task_permission_replay')},
    {error: Error('opencode_task_native_error'), options: {badCleanup: true}},
    {error: Error('opencode_task_native_error'), options: {observations: {submitted: 1, cleanup_confirmed: 0}}},
  ]) {
    class Task { async run() { throw error; } }
    let failed;
    const f = fixture(Task, (value, input) => { failed = value; input.end(); }, options);
    assert.equal(await f.done, 1);
    assert.equal(failed.type, 'failed');
    assert.ok(!f.observed.includes('result'));
    assert.ok(!JSON.stringify(failed).includes('UNKNOWN_PRIVATE_REASON'));
    assert(f.observed.includes('provider-close')); assert(f.observed.includes('SIGTERM'));
  }
});
test('owner returns observed native lifecycle on both successful and failed turns', async () => {
  for (const failed of [false, true]) {
    const diagnostic = emptyTaskDiagnostic(); diagnostic.observed_calls = 1;
    diagnostic.tools.read[failed ? 'error' : 'completed'] = 1;
    class Task {
      get diagnostics() { return diagnostic; }
      async run() { if (failed) throw Error('opencode_task_native_error'); return result; }
    }
    const f = fixture(Task, (value, input) => {
      assert.equal(value.type, failed ? 'failed' : 'result');
      assert.deepEqual(value.task_diagnostics, diagnostic);
      input.end();
    });
    assert.equal(await f.done, 0);
  }
});
test('inner owner forwards only explicit verification selection and correlates actual feedback', async () => {
  class Task {
    async run(_prompt, {signal, verify, maxVerificationRounds}) {
      assert.equal(maxVerificationRounds, 2);
      const receipt = await verify({round: 1, remainingMs: 1000, signal});
      assert.deepEqual(receipt, {status: 'failed', feedback: 'Exact owner check output'});
      const second = await verify({round: 2, remainingMs: 900, signal});
      assert.equal(second.status, 'passed'); return result;
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'verification') writeFrame(input, {type: 'verification', id: value.id,
      status: value.round === 1 ? 'failed' : 'passed', feedback: value.round === 1 ? 'Exact owner check output' : ''});
    else if (value.type === 'result') input.end();
  }, {verification: {version: 1, maxRounds: 2}});
  assert.equal(await f.done, 0);
  assert.equal(f.observed.filter(value => value === 'verification').length, 2);
});
test('inner cancellation expires verifier request and a late receipt cannot revive a task', async () => {
  class Task {
    async run(_prompt, {signal, verify}) {
      const receipt = await verify({round: 1, remainingMs: 1000, signal});
      assert.equal(receipt.status, 'unavailable');
      assert.equal(signal.aborted, true); throw Error('opencode_task_cancelled');
    }
  }
  const f = fixture(Task, (value, input) => {
    if (value.type === 'verification') {
      writeFrame(input, {type: 'cancel'});
      writeFrame(input, {type: 'verification', id: value.id, status: 'passed', feedback: ''});
    } else if (value.type === 'failed') input.end();
  }, {verification: {version: 1, maxRounds: 2}});
  assert.equal(await f.done, 0); assert.ok(!f.observed.includes('result'));
});
