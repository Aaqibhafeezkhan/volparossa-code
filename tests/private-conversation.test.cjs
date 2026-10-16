// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { validateConversation, PrivateConversation } = require('../src/private-conversation.cjs');
const { terminalCleanupConfirmed } = require('../src/private-compute.cjs');
const { caps, input, result, frame, reply, fixture } = require('./conversation-fixture.cjs');

test('actual framed socket uses separate handshake and yields exact cleanup-confirmed conversation result', async t => {
  const original = result();
  const f = await fixture(t, (socket, request) => {
    const bytes = Buffer.concat([frame({ version: 1, id: request.id, event: 'admitted' }),
      frame({ version: 1, id: request.id, event: 'result', result: original })]);
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => socket.write(bytes.subarray(2)));
  });
  assert.deepEqual(await f.client.connect(), caps());
  assert.deepEqual(await f.client.submit(input()), original);
  assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation']);
  assert.deepEqual(f.requests[0].operation, { type: 'conversation_capabilities' });
  assert.equal(Object.hasOwn(f.requests[1].operation.conversation, 'generation_policy'), false);
  await assert.rejects(f.client.ask({ question: 'legacy', context: 'must not send' }));
});

test('execution error negotiation is independent, strict, and unchanged when absent', async t => {
  for (const value of [null, 0, 2, true]) {
    assert.throws(() => new PrivateConversation('/fixture/core.sock', {executionErrorVersion: value}),
      /unsupported_execution_error_version/);
  }
  for (const advertised of [caps(), {...caps(), execution_error_version: null},
    {...caps(), execution_error_version: 2}]) {
    const f = await fixture(t, () => assert.fail('must not submit'), advertised, {executionErrorVersion: 1});
    await assert.rejects(f.client.connect(), {code: 'incompatible_capabilities'});
    assert.deepEqual(f.requests[0].operation, {type: 'conversation_capabilities', execution_error_version: 1});
  }
  const unsolicited = await fixture(t, () => assert.fail('must not submit'), {...caps(), execution_error_version: 1});
  await assert.rejects(unsolicited.client.connect());
});

test('only a negotiated admitted task has a budget-error cleanup receipt, with request-local provenance', async t => {
  let submitted = 0;
  const f = await fixture(t, (socket, request) => {
    if (++submitted === 1) reply(socket, request, 'admitted');
    reply(socket, request, 'error', {code: 'execution_budget_exceeded'});
  }, {...caps(), execution_error_version: 1}, {executionErrorVersion: 1});
  await f.client.connect();
  let accepted;
  await assert.rejects(f.client.submit(input()), error => {
    accepted = error;
    assert.equal(error.code, 'execution_budget_exceeded');
    assert.equal(terminalCleanupConfirmed(error), true);
    return true;
  });
  await assert.rejects(f.client.submit(input()), error => {
    assert.equal(error.code, 'invalid_response');
    assert.equal(terminalCleanupConfirmed(error), false);
    return true;
  });
  assert.equal(terminalCleanupConfirmed({...accepted, cleanupConfirmed: true}), false);
  assert.equal(terminalCleanupConfirmed(Object.assign(Error(accepted.message), {code: accepted.code})), false);
  assert.equal(terminalCleanupConfirmed(accepted), true);
});

test('legacy, wrong-id, cancel-id and handshake budget codes never become cleanup receipts', async t => {
  for (const mode of ['legacy', 'wrong-id', 'cancel-id']) {
    let admitted;
    const ready = new Promise(resolve => { admitted = resolve; });
    const f = await fixture(t, (socket, request) => {
      if (request.operation.type === 'submit_conversation') {
        reply(socket, request, 'admitted');
        if (mode === 'cancel-id') { admitted(); return; }
      }
      reply(socket, mode === 'wrong-id' ? {...request, id: 'f'.repeat(32)} : request,
        'error', {code: 'execution_budget_exceeded'});
    }, mode === 'legacy' ? caps() : {...caps(), execution_error_version: 1},
    mode === 'legacy' ? {} : {executionErrorVersion: 1});
    await f.client.connect();
    const controller = new AbortController();
    const pending = f.client.submit(input(), {signal: controller.signal});
    const rejected = assert.rejects(pending, error => {
      assert.equal(error.code, 'invalid_response', mode);
      assert.equal(terminalCleanupConfirmed(error), false, mode);
      return true;
    });
    if (mode === 'cancel-id') { await ready; controller.abort(); }
    await rejected;
  }
  // Pure dispatch guard at the handshake boundary; no synthetic execution claim.
  const client = new PrivateConversation('/fixture/core.sock', {executionErrorVersion: 1});
  client.state = 'connecting'; client.handshake = {id: 'a'.repeat(32)};
  assert.throws(() => client._response({version: 1, id: client.handshake.id, event: 'error',
    code: 'execution_budget_exceeded'}), error => {
    assert.equal(error.code, 'invalid_response');
    assert.equal(terminalCleanupConfirmed(error), false);
    return true;
  });
});

test('negotiated greedy requests require matching result evidence and cannot silently use a legacy core', async t => {
  const model = 'qwen3-0.6b-v1';
  const negotiated = { ...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'] };
  const request = { ...input(), generation_policy: 'greedy_v1' };
  for (const evidence of ['greedy_v1', undefined, null, 'sampled']) {
    const original = { ...result(undefined, model), ...(evidence === undefined ? {} : { generation_policy: evidence }) };
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: original });
    }, structuredClone(negotiated), { generationPolicyVersion: 1 });
    await f.client.connect();
    if (evidence === 'greedy_v1') assert.deepEqual(await f.client.submit(request), original);
    else await assert.rejects(f.client.submit(request), { code: 'generation_policy_mismatch' });
    assert.deepEqual(f.requests[0].operation, { type: 'conversation_capabilities', generation_policy_version: 1 });
    assert.deepEqual(f.requests[1].operation.conversation, request);
  }
  for (const advertised of [caps(model), { ...negotiated, generation_policy_version: 2 },
    { ...negotiated, generation_policies: ['sampled'] }]) {
    const f = await fixture(t, () => assert.fail('legacy/unknown policy must not submit'), advertised,
      { generationPolicyVersion: 1 });
    await assert.rejects(f.client.connect(), { code: 'unsupported_generation_policy' });
    assert.equal(f.requests.length, 1);
  }
  for (const policy of [null, 'sampled', 0]) {
    assert.throws(() => validateConversation({ ...request, generation_policy: policy }, negotiated),
      /unsupported_generation_policy/);
  }
  assert.throws(() => validateConversation(request, caps(model)), /unsupported_generation_policy/);
  assert.throws(() => validateConversation(request, { ...caps(), generation_policy_version: 1, generation_policies: [] }),
    /unsupported_generation_policy/);
});

test('closed 4B profile binds exact template, limits, greedy policy and returned model', async t => {
  const model = 'qwen3-4b-instruct-2507-v1';
  const negotiated = {...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1']};
  assert.equal(negotiated.conversation_template, 'qwen3-tools-instruct-2507-v1');
  assert.equal(negotiated.model_context_tokens, 262144);
  assert.equal(negotiated.max_prompt_tokens, 12288);
  assert.equal(negotiated.max_new_tokens, 1024);
  assert.equal(negotiated.max_output_bytes, 4096);
  assert.equal(negotiated.max_request_bytes, 524288);
  const request = {...input(), generation_policy: 'greedy_v1'};
  const answer = {...result(undefined, model), generation_policy: 'greedy_v1'};
  const f = await fixture(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: answer});
  }, structuredClone(negotiated), {generationPolicyVersion: 1});
  await f.client.connect();
  assert.deepEqual(await f.client.submit(request), answer);
  assert.deepEqual(f.requests[1].operation.conversation, request);
  for (const change of [{conversation_template: 'qwen3-tools-nonthinking-v1'}, {model_context_tokens: 32768},
    {max_prompt_tokens: 262144}, {max_new_tokens: 2048}, {generation_policies: []}, {model_profile: 'qwen3-4b'}]) {
    const wrong = await fixture(t, () => assert.fail('unvalidated profile must never submit'),
      {...negotiated, ...change}, {generationPolicyVersion: 1});
    await assert.rejects(wrong.client.connect());
  }
  for (const change of [{model_profile: 'qwen3-0.6b-v1'}, {generation_policy: 'sampled'}]) {
    const wrong = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: {...answer, ...change}});
    }, structuredClone(negotiated), {generationPolicyVersion: 1});
    await wrong.client.connect(); await assert.rejects(wrong.client.submit(request));
  }
});

test('owner-selected native CPU capability pair preserves greedy socket requests and unchanged summaries', async t => {
  // Framed socket contract only; no native backend, model or OpenCode is loaded.
  const model = 'qwen3-4b-instruct-2507-v1';
  for (const backend of [{}, {inference_backend: 'llama_cpp_bf16_v1', required_generation_policy: 'greedy_v1'}]) {
    const negotiated = {...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'],
      execution_error_version: 1, ...backend};
    const request = {...input(), generation_policy: 'greedy_v1'};
    const answer = {...result(undefined, model), generation_policy: 'greedy_v1'};
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: answer});
    }, structuredClone(negotiated), {generationPolicyVersion: 1, executionErrorVersion: 1});
    assert.deepEqual(await f.client.connect(), negotiated);
    const returned = await f.client.submit(request);
    assert.deepEqual(returned, answer);
    assert.equal(Object.hasOwn(returned, 'inference_backend'), false);
    assert.deepEqual(f.requests[0].operation, {type: 'conversation_capabilities',
      generation_policy_version: 1, execution_error_version: 1});
    assert.deepEqual(f.requests[1].operation.conversation, request);
  }
});

test('partial, unknown or unnegotiated native CPU capabilities fail before submission', async t => {
  const model = 'qwen3-4b-instruct-2507-v1';
  const pair = {inference_backend: 'llama_cpp_bf16_v1', required_generation_policy: 'greedy_v1'};
  const negotiated = {...caps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'], ...pair};
  const invalid = [
    {...negotiated, inference_backend: undefined},
    {...negotiated, required_generation_policy: undefined},
    {...negotiated, inference_backend: null},
    {...negotiated, inference_backend: 'llama_cpp_bf16_v2'},
    {...negotiated, required_generation_policy: null},
    {...negotiated, required_generation_policy: 'sampled'},
    {...negotiated, ...caps('qwen3-0.6b-v1')},
    {...negotiated, ...caps('smollm2-360m-v1')},
    {...negotiated, generation_policy_version: undefined},
    {...negotiated, generation_policy_version: 2},
    {...negotiated, generation_policies: []},
    {...negotiated, generation_policies: ['sampled']},
    {...negotiated, executable_path: '/untrusted/backend'},
  ];
  for (const advertised of invalid) {
    const f = await fixture(t, () => assert.fail('invalid backend must not submit'), advertised,
      {generationPolicyVersion: 1});
    await assert.rejects(f.client.connect());
    assert.equal(f.requests.length, 1);
  }
  for (const advertised of [{...caps(model), ...pair}, negotiated]) {
    const f = await fixture(t, () => assert.fail('unnegotiated backend must not submit'), advertised);
    await assert.rejects(f.client.connect());
    assert.equal(f.requests.length, 1);
  }
});

test('public/cloud/widened/unknown capabilities fail before any task', async t => {
  for (const change of [{ network_access: true }, { training: true }, { cloud_fallback: true },
    { max_prompt_tokens: 999999 }, { native_tool_template: true }, { model_profile: 'unknown' },
    { arbitrary_json_schema_validation: true }, { max_seconds: 0 }, { max_request_bytes: 999999 }]) {
    const f = await fixture(t, () => assert.fail('unexpected submit'), { ...caps(), ...change });
    await assert.rejects(f.client.connect());
    assert.equal(f.requests.length, 1);
  }
});

test('history preserves exact namespaced calls and requires one matching result before the next message', () => {
  const value = input([{ type: 'function', namespace: 'workspace', name: 'read', description: 'Read approved file.',
    parameters: { type: 'object', properties: { file: { type: 'string' } } } }]);
  value.history.push({ type: 'function_call', namespace: 'workspace', name: 'read', call_id: 'c1', arguments: { file: 'demo' } },
    { type: 'tool_result', call_id: 'c1', output: 'Public fixture bytes.' });
  validateConversation(value);
  for (const alter of [v => { v.history[2].call_id = 'other'; }, v => { v.history[1].namespace = null; },
    v => { v.history.splice(2, 0, { type: 'message', role: 'user', text: 'interrupt' }); },
    v => { v.history.push(v.history[2]); }, v => { v.tools = []; },
    v => { v.history[1].arguments = 'not object'; }, v => { v.instructions = 'x'.repeat(4097); }]) {
    const invalid = structuredClone(value); alter(invalid);
    assert.throws(() => validateConversation(invalid));
  }
});

test('cleanup uncertainty, wrong tool identity and historical call reuse never expose output', async t => {
  const request = input([{ type: 'custom', name: 'patch', namespace: null, description: 'Propose a literal patch.' }]);
  request.history.push({ type: 'custom_tool_call', name: 'patch', namespace: null, call_id: 'old', input: 'example' },
    { type: 'tool_result', call_id: 'old', output: 'fixture' });
  for (const output of [
    { type: 'custom_tool_call', name: 'other', namespace: null, call_id: 'new', input: 'must not run' },
    { type: 'custom_tool_call', name: 'patch', namespace: null, call_id: 'old', input: 'must not run' },
    { type: 'custom_tool_call', name: 'patch', call_id: 'new', input: 'missing namespace' },
  ]) {
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(output) });
    });
    await f.client.connect(); await assert.rejects(f.client.submit(request));
  }
  const invalid = result(); invalid.cleanup.complete = false;
  const f = await fixture(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: invalid });
  });
  await f.client.connect(); await assert.rejects(f.client.submit(input()), { code: 'cleanup_unconfirmed' });
});

test('cancellation acknowledgement does not settle until the exact task cleanup terminal', async t => {
  let task, authorize;
  const ready = new Promise(resolve => { authorize = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit_conversation') { task = request; reply(socket, request, 'admitted'); }
    else { assert.equal(request.operation.task_id, task.id);
      reply(socket, request, 'cancel_requested', { task_id: task.id });
      authorize(() => reply(socket, task, 'error', { code: 'cancelled' })); }
  });
  await f.client.connect();
  const controller = new AbortController();
  const pending = f.client.submit(input(), { signal: controller.signal });
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'cancelled');
    assert.equal(terminalCleanupConfirmed(error), true);
    return true;
  });
  controller.abort();
  const finish = await ready;
  let settled = false; pending.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  finish(); await rejected;
});

test('cleanup receipt belongs only to the validated rejected request, never its error code alone', async t => {
  let submitted = 0;
  const f = await fixture(t, (socket, request) => {
    if (++submitted === 1) reply(socket, request, 'admitted');
    reply(socket, request, 'error', {code: 'execution_failed'});
  });
  await f.client.connect();
  let first;
  await assert.rejects(f.client.submit(input()), error => {
    first = error; assert.equal(error.code, 'execution_failed');
    assert.equal(terminalCleanupConfirmed(error), true); return true;
  });
  await assert.rejects(f.client.submit(input()), error => {
    assert.equal(error.code, 'execution_failed');
    assert.equal(terminalCleanupConfirmed(error), false); return true;
  });
  assert.equal(terminalCleanupConfirmed({...first, cleanupConfirmed: true}), false);
  assert.equal(terminalCleanupConfirmed(Error(first.message)), false);
  assert.equal(terminalCleanupConfirmed(null), false);
  assert.equal(terminalCleanupConfirmed(first), true);
});

test('cancellation racing a valid result keeps its cleanup receipt without returning the answer', async t => {
  let task, finish;
  const cancelled = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit_conversation') { task = request; reply(socket, request, 'admitted'); }
    else {
      reply(socket, request, 'cancel_requested', {task_id: task.id});
      finish(() => reply(socket, task, 'result', {result: result()}));
    }
  });
  await f.client.connect();
  const controller = new AbortController();
  const pending = f.client.submit(input(), {signal: controller.signal});
  const rejected = assert.rejects(pending, error => {
    assert.equal(error.code, 'cancelled');
    assert.equal(terminalCleanupConfirmed(error), true); return true;
  });
  controller.abort();
  (await cancelled)(); await rejected;
});

test('conversation inherits exact owned socket/parent boundary and rejects false result correlation', async t => {
  const f = await fixture(t, (socket, request) => reply(socket, { id: 'f'.repeat(32) }, 'result', { result: result() }));
  await fs.chmod(f.socketPath, 0o666);
  await assert.rejects(new PrivateConversation(f.socketPath).connect(), { code: 'socket_ownership' });
  await fs.chmod(f.socketPath, 0o600);
  await f.client.connect(); await assert.rejects(f.client.submit(input()), { code: 'invalid_response' });
});
