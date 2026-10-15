// SPDX-License-Identifier: GPL-3.0-only
// Real framing with synthetic core replies; no inference or OpenCode proof.
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {test} = require('node:test');
const {PrivateConversation, validateConversation, OUTPUT_CONSTRAINT: PROFILE} = require('../src/private-conversation.cjs');
const {toConversation, startChatCompletionsProvider} = require('../src/chat-completions-provider.cjs');
const {caps, input, result, reply, fixture} = require('./conversation-fixture.cjs');
const MODEL = 'qwen3-4b-instruct-2507-v1';
const OPTIONS = {generationPolicyVersion: 1, executionErrorVersion: 1, outputConstraintVersion: 1};
const tool = {type: 'function', name: 'read', namespace: null, description: 'Synthetic read.',
  parameters: {type: 'object'}};
const advertised = () => ({...caps(MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'],
  execution_error_version: 1, inference_backend: 'llama_cpp_bf16_v1', required_generation_policy: 'greedy_v1',
  output_constraint_version: 1, output_constraints: [PROFILE]});
const conversation = () => ({...input([tool]), generation_policy: 'greedy_v1', output_constraint: PROFILE});
const answer = output => ({...result(output, MODEL), generation_policy: 'greedy_v1', output_constraint: PROFILE});
const request = () => ({model: MODEL, temperature: 0, max_tokens: 1024,
  messages: [{role: 'user', content: 'Use the synthetic example.'}],
  tools: [{type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}}]});

test('constraint negotiation is additive and binds each result to the requested profile', async t => {
  for (const output of [undefined, {type: 'function_call', namespace: null, name: 'read', call_id: 'c1', arguments: {}}]) {
    const original = answer(output);
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: original});
    }, advertised(), OPTIONS);
    assert.deepEqual(await f.client.connect(), advertised());
    assert.deepEqual(await f.client.submit(conversation()), original);
    assert.deepEqual(f.requests[0].operation, {type: 'conversation_capabilities', generation_policy_version: 1,
      execution_error_version: 1, output_constraint_version: 1});
    assert.deepEqual(f.requests[1].operation.conversation, conversation());
    assert.equal(Object.hasOwn(f.requests[1].operation.conversation, 'output_constraint_tools'), false);
    assert.ok(Object.isFrozen(f.client.caps.output_constraints));
  }
});

test('unknown, partial or unsolicited capabilities cannot enable constrained execution', async t => {
  for (const value of [null, true, 0, 2, '1']) {
    assert.throws(() => new PrivateConversation('/fixture/core.sock', {outputConstraintVersion: value}),
      /unsupported_output_constraint_version/);
  }
  for (const change of [{output_constraint_version: undefined}, {output_constraint_version: null},
    {output_constraint_version: 2}, {output_constraints: undefined}, {output_constraints: null},
    {output_constraints: [PROFILE, PROFILE]}, {output_constraints: ['arbitrary-grammar']},
    {inference_backend: undefined, required_generation_policy: undefined},
    {...caps('qwen3-0.6b-v1')}, {grammar: 'user-controlled'}]) {
    const f = await fixture(t, () => assert.fail('must not submit'), {...advertised(), ...change}, OPTIONS);
    await assert.rejects(f.client.connect());
    assert.equal(f.requests.length, 1);
  }
  const unsolicited = await fixture(t, () => assert.fail('must not submit'), advertised(),
    {generationPolicyVersion: 1, executionErrorVersion: 1});
  await assert.rejects(unsolicited.client.connect());
});

test('negotiated empty capabilities permit legacy input but not a constrained request', async t => {
  const f = await fixture(t, () => assert.fail('must not submit'), {...advertised(), output_constraints: []}, OPTIONS);
  await f.client.connect();
  validateConversation({...input(), generation_policy: 'greedy_v1'}, f.client.caps);
  await assert.rejects(f.client.submit(conversation()), {code: 'unsupported_output_constraint'});
  assert.equal(f.requests.length, 1);
});

test('request profile is closed, requires greedy and real tools, and excludes caller aliases', () => {
  for (const change of [{output_constraint: null}, {output_constraint: 'grammar'}, {output_constraint: true},
    {generation_policy: undefined}, {tools: []}, {output_constraint_tools: ['vp_0']},
    {tools: Array.from({length: 33}, (_, n) => ({...tool, name: 't' + n}))}]) {
    assert.throws(() => validateConversation({...conversation(), ...change}, advertised()));
  }
  for (const count of [1, 32]) validateConversation({...conversation(),
    tools: Array.from({length: count}, (_, n) => ({...tool, name: 't' + n}))}, advertised());
});

test('missing, mismatched and unsolicited result constraints are rejected without output repair', async t => {
  for (const value of [undefined, null, 'other', false]) {
    const original = answer();
    if (value === undefined) delete original.output_constraint; else original.output_constraint = value;
    const f = await fixture(t, (socket, message) => {
      reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: original});
    }, advertised(), OPTIONS);
    await f.client.connect();
    await assert.rejects(f.client.submit(conversation()), {code: 'output_constraint_mismatch'});
  }
  const f = await fixture(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: answer()});
  }, advertised(), OPTIONS);
  await f.client.connect();
  const legacy = conversation(); delete legacy.output_constraint;
  await assert.rejects(f.client.submit(legacy));
});

test('provider uses an explicit profile, never implicitly transforms legacy or no-tool input', () => {
  const original = toConversation(request(), MODEL, advertised());
  assert.equal(Object.hasOwn(original, 'output_constraint'), false);
  assert.deepEqual(toConversation(request(), MODEL, advertised(), PROFILE), {...original, output_constraint: PROFILE});
  const noTools = request(); delete noTools.tools;
  assert.deepEqual(toConversation(noTools, MODEL, advertised(), PROFILE), toConversation(noTools, MODEL, advertised()));
  assert.throws(() => toConversation(request(), MODEL, {...advertised(), output_constraints: []}, PROFILE),
    /unsupported_output_constraint/);
  assert.throws(() => toConversation(request(), MODEL, advertised(), null), /unsupported_output_constraint/);
  const sampled = request(); delete sampled.temperature;
  assert.throws(() => toConversation(sampled, MODEL, advertised(), PROFILE), /unsupported_output_constraint/);
});

function send(provider, body) {
  return new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    const req = http.request(provider.baseUrl + '/chat/completions', {method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${provider.bearerToken}`,
      'content-length': Buffer.byteLength(bytes)}}, response => {
      let raw = ''; response.setEncoding('utf8'); response.on('data', part => { raw += part; });
      response.on('end', () => resolve({status: response.statusCode, body: JSON.parse(raw)}));
    });
    req.on('error', reject); req.end(bytes);
  });
}

test('explicit HTTP provider negotiates on its own connection and preserves plain answers', async t => {
  const f = await fixture(t, (socket, message) => {
    assert.equal(message.operation.conversation.output_constraint, PROFILE);
    reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: answer()});
  }, advertised());
  const provider = await startChatCompletionsProvider({socketPath: f.socketPath, model: MODEL, outputConstraint: PROFILE});
  try {
    const received = await send(provider, request());
    assert.equal(received.status, 200);
    assert.equal(received.body.choices[0].message.content, answer().output.text);
    assert.equal(received.body.choices[0].finish_reason, 'stop');
    assert.equal(f.requests[0].operation.output_constraint_version, 1);
    assert.deepEqual(provider.observations, {submitted: 1, completed: 1, incomplete: 0, cleanup_confirmed: 1});
  } finally { await provider.close(); }
});
