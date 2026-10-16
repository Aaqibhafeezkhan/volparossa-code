// SPDX-License-Identifier: GPL-3.0-only
// Actual HTTP/Unix framing with synthetic core replies: no model/OpenCode execution proof.
// Requests follow OpenCode aec0b9a6 (v1.18.34), @ai-sdk/openai-compatible 2.0.41
// getArgs/doStream, convertToOpenAICompatibleChatMessages and prepareTools.
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { startChatCompletionsProvider, toConversation } = require('../src/chat-completions-provider.cjs');
const { caps: legacyCaps, result: legacyResult, reply, fixture } = require('./conversation-fixture.cjs');

// These are synthetic replies for the explicitly negotiated worker policy.
const caps = model => ({ ...legacyCaps(model), generation_policy_version: 1, generation_policies: ['greedy_v1'],
  execution_error_version: 1 });
const result = (output, model) => ({ ...legacyResult(output, model), generation_policy: 'greedy_v1' });

const MODEL = 'qwen3-0.6b-v1';
test('explicit temperature zero requires negotiated greedy execution rather than sampled legacy execution', () => {
  assert.throws(() => toConversation(request(), MODEL, legacyCaps(MODEL)), /unsupported_generation_policy/);
  const negotiated = { ...caps(MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'] };
  assert.equal(toConversation(request(), MODEL, negotiated).generation_policy, 'greedy_v1');
});

function request(stream = true) {
  return { model: MODEL, max_tokens: 1024, temperature: 0,
    messages: [{ role: 'system', content: 'Preserve the private project and propose bounded changes.' },
      { role: 'user', content: 'Read the selected synthetic example.' }],
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
}
function tool(name = 'read') {
  return { type: 'function', function: { name, description: 'A synthetic owner-authorized tool.',
    parameters: { type: 'object', properties: { file: { type: 'string' } } } } };
}
async function start(t, handler, diagnostics = false, model = MODEL) {
  const f = await fixture(t, handler, caps(model));
  const provider = await startChatCompletionsProvider({ socketPath: f.socketPath, model, diagnostics });
  return { ...f, provider };
}
function send(provider, value, headers = {}, suffix = '/chat/completions') {
  const body = Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const req = http.request(provider.baseUrl + suffix, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${provider.bearerToken}`,
      'content-length': Buffer.byteLength(body), ...headers,
    } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject); req.end(body);
  });
}
function chunks(response) {
  assert.equal(response.status, 200, response.body);
  assert.equal(response.headers['content-type'], 'text/event-stream');
  const blocks = response.body.trim().split('\n\n');
  assert.equal(blocks.pop(), 'data: [DONE]');
  const values = blocks.map(block => {
    assert.ok(block.startsWith('data: '));
    return JSON.parse(block.slice(6));
  });
  assert.ok(values.every(value => value.id === values[0].id && value.model === MODEL &&
    value.object === 'chat.completion.chunk' && value.created === values[0].created));
  return values;
}

test('loopback token and web-origin gate authenticate before any core IPC', async t => {
  const f = await start(t, () => assert.fail('no generation expected'));
  try {
    assert.match(f.provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.match(f.provider.bearerToken, /^[\w-]{43}$/);
    assert.deepEqual(f.provider.execution, { scope: 'private_local', distributed: false, confidentialPeerExecution: false });
    assert.equal(f.provider.diagnostics, null);
    assert.equal(f.requests.length, 0);
    for (const headers of [{ authorization: 'Bearer wrong' }, { host: 'untrusted.invalid' },
      { origin: 'https://untrusted.invalid' }, { referer: 'https://untrusted.invalid/' },
      { 'content-type': 'text/plain' }, { 'content-encoding': 'gzip' }]) {
      assert.ok([400, 401].includes((await send(f.provider, request(), headers)).status));
    }
    assert.equal((await send(f.provider, request(), {}, '/responses')).status, 400);
    assert.equal(f.requests.length, 0);
  } finally { await f.provider.close(); }
});

test('SDK stream shape releases actual text and token usage only after terminal core cleanup', async t => {
  let admitted, finish;
  const ready = new Promise(resolve => { admitted = resolve; });
  const original = result(undefined, MODEL);
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted');
    finish = () => reply(socket, message, 'result', { result: original });
    admitted();
  });
  try {
    let settled = false;
    const body = request(); body.user = 'PRIVATE_METADATA_NOT_FOR_MODEL';
    body.messages[1].content = [{ type: 'text', text: 'First part.' }, { type: 'text', text: 'Second part.' }];
    const pending = send(f.provider, body); pending.then(() => { settled = true; });
    await ready;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.provider.observations, { submitted: 1, completed: 0, incomplete: 0, cleanup_confirmed: 0 });
    assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation']);
    assert.deepEqual(f.requests[0].operation, { type: 'conversation_capabilities', generation_policy_version: 1,
      execution_error_version: 1 });
    const input = f.requests[1].operation.conversation;
    assert.equal(input.generation_policy, 'greedy_v1');
    assert.equal(input.visibility, 'private_local');
    assert.equal(input.instructions, body.messages[0].content);
    assert.equal(input.history[0].text, 'First part.\n\nSecond part.');
    assert.ok(!JSON.stringify(input).includes('PRIVATE_METADATA_NOT_FOR_MODEL'));
    finish();
    const response = await pending, events = chunks(response);
    assert.equal(response.headers['x-volparossa-execution'], 'private-local');
    assert.equal(response.headers['x-volparossa-confidential-peer'], 'unavailable');
    assert.equal(events[1].choices[0].delta.content, original.output.text);
    assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
    assert.deepEqual(events.at(-1).choices, []);
    assert.deepEqual(events.at(-1).usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
      prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
    assert.deepEqual(f.provider.observations, { submitted: 1, completed: 1, incomplete: 0, cleanup_confirmed: 1 });
  } finally { await f.provider.close(); }
});

test('SDK nonstreaming generation and no-usage streams use the same checked core lane', async t => {
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(undefined, MODEL) });
  });
  try {
    const response = await send(f.provider, request(false));
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    const value = JSON.parse(response.body);
    assert.equal(value.object, 'chat.completion');
    assert.equal(value.choices[0].message.role, 'assistant');
    assert.equal(value.choices[0].finish_reason, 'stop');
    assert.equal(value.usage.total_tokens, 30);
    const body = request(); delete body.stream_options;
    const streamed = chunks(await send(f.provider, body));
    assert.ok(streamed.every(event => event.usage === undefined));
    assert.equal(streamed.at(-1).choices[0].finish_reason, 'stop');
  } finally { await f.provider.close(); }
});
test('4B provider preserves its validated core profile and refuses frontend substitution', async t => {
  const model = 'qwen3-4b-instruct-2507-v1';
  const f = await start(t, (socket, message) => {
    assert.equal(message.operation.conversation.generation_policy, 'greedy_v1');
    reply(socket, message, 'admitted'); reply(socket, message, 'result', {result: result(undefined, model)});
  }, true, model);
  try {
    const response = await send(f.provider, {...request(false), model});
    assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).model, model);
    const originalSubmits = f.provider.observations.submitted;
    const mismatch = await send(f.provider, request(false));
    assert.equal(mismatch.status, 400); assert.equal(JSON.parse(mismatch.body).error.code, 'model_mismatch');
    assert.equal(f.provider.observations.submitted, originalSubmits);
  } finally { await f.provider.close(); }
  const changed = await fixture(t, () => assert.fail('changed core model must not submit'), caps(MODEL));
  const provider = await startChatCompletionsProvider({socketPath: changed.socketPath, model});
  try {
    const response = await send(provider, {...request(false), model});
    assert.equal(response.status, 400); assert.equal(JSON.parse(response.body).error.code, 'model_mismatch');
    assert.equal(changed.requests.length, 1);
  } finally { await provider.close(); }
});

test('tool proposal identity survives SDK assistant/tool history without execution authority', async t => {
  const output = { type: 'function_call', call_id: 'tool-fixture-1', name: 'read', namespace: null,
    arguments: { file: 'synthetic.rs' } };
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(output, MODEL) });
  });
  try {
    const body = request(); body.tools = [tool()]; body.tool_choice = 'auto';
    const streamed = chunks(await send(f.provider, body));
    const call = streamed[1].choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0); assert.equal(call.id, output.call_id);
    assert.equal(call.function.name, 'read');
    assert.deepEqual(JSON.parse(call.function.arguments), output.arguments);
    assert.equal(streamed.at(-2).choices[0].finish_reason, 'tool_calls');
    const wireCall = { id: call.id, type: 'function', function: call.function };
    const follow = structuredClone(body);
    follow.messages.push({ role: 'assistant', content: '', tool_calls: [wireCall] },
      { role: 'tool', tool_call_id: call.id, content: '{"content":"owner-authorized result"}' });
    const mapped = toConversation(follow, MODEL, caps(MODEL));
    assert.deepEqual(mapped.history.at(-2), output);
    assert.deepEqual(mapped.history.at(-1), { type: 'tool_result', call_id: call.id,
      output: '{"content":"owner-authorized result"}' });
    assert.equal(f.requests.length, 2);
  } finally { await f.provider.close(); }
});

test('system/developer ordering and parallel historical calls preserve the complete request', () => {
  const body = request();
  body.messages.unshift({ role: 'system', content: 'First instruction.' });
  body.messages.push({ role: 'developer', content: 'Later exact developer context.' },
    { role: 'assistant', content: 'I propose two reads.', tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'read', arguments: '{"file":"a"}' } },
      { id: 'call-b', type: 'function', function: { name: 'read', arguments: '{"file":"b"}' } },
    ] }, { role: 'tool', tool_call_id: 'call-b', content: 'B' },
    { role: 'tool', tool_call_id: 'call-a', content: 'A' });
  body.tools = [tool()];
  const mapped = toConversation(body, MODEL, caps(MODEL));
  assert.equal(mapped.instructions, body.messages[0].content + '\n\n' + body.messages[1].content);
  assert.equal(mapped.history[1].role, 'developer');
  assert.equal(mapped.history[2].text, 'I propose two reads.');
  assert.deepEqual(mapped.history.slice(-2).map(value => value.call_id), ['call-b', 'call-a']);
});

test('token exhaustion is length; cleanup-confirmed invalid/truncated output is terminal, not retryable 5xx', async t => {
  for (const reason of ['token_limit', 'wire_truncated', 'invalid_output']) {
    const f = await start(t, (socket, message) => {
      reply(socket, message, 'admitted');
      reply(socket, message, 'result', { result: result({ type: 'incomplete', reason }, MODEL) });
    }, true);
    try {
      const response = await send(f.provider, request());
      if (reason === 'token_limit') {
        const values = chunks(response);
        assert.equal(values.at(-2).choices[0].finish_reason, 'length');
        assert.ok(values.every(value => !value.choices[0]?.delta?.tool_calls));
      } else {
        assert.equal(response.status, 422);
        assert.equal(JSON.parse(response.body).error.code, 'invalid_model_output');
        assert.ok(!response.body.includes('data: '));
      }
      assert.equal(f.provider.observations.incomplete, 1);
      assert.equal(f.provider.observations.cleanup_confirmed, 1);
      assert.equal(f.provider.diagnostics.records[0].incomplete_reason, reason);
      const summary = f.provider.diagnostics.summary;
      assert.equal(summary.submitted, 1); assert.equal(summary.completed, 0);
      assert.equal(summary.incomplete, 1); assert.equal(summary.cleanup_confirmed, 1);
      assert.equal(summary.results.incomplete, 1); assert.equal(summary.incomplete_reasons[reason], 1);
      assert.equal(summary.request_errors.invalid_model_output, reason === 'token_limit' ? 0 : 1);
      assert.equal(f.requests.filter(row => row.operation.type === 'submit_conversation').length, 1);
    } finally { await f.provider.close(); }
  }
});

test('unsupported shapes, altered budgets, unpaired IDs and private exports reject before submit', async t => {
  const f = await start(t, () => assert.fail('invalid requests must not execute'));
  try {
    const toolHistory = [request().messages[0], request().messages[1],
      { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function',
        function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'wrong', content: 'PRIVATE_SENTINEL' }];
    for (const change of [
      { store: true }, { max_tokens: 1023 }, { temperature: 0.7 }, { reasoning_effort: 'high' },
      { response_format: { type: 'json_object' } }, { extra_feature: true }, { n: 2 },
      { tools: [{ ...tool(), function: { ...tool().function, strict: true } }] },
      { tools: [tool()], messages: toolHistory }, { stop: ['PRIVATE_STOP'] },
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://private.invalid' } }] }] },
      { messages: [{ role: 'user', content: 'x'.repeat(65537) }] },
      { messages: [{ role: 'assistant', content: 'only an answer' }] },
      { messages: [{ role: 'assistant', content: '', reasoning_content: 'PRIVATE_REASONING' }] },
    ]) {
      const response = await send(f.provider, { ...request(), ...change });
      assert.equal(response.status, 400, JSON.stringify(change).slice(0, 120));
      assert.ok(!response.body.includes('PRIVATE_') && !response.body.includes('private.invalid'));
    }
    for (const body of ['{"model":"duplicate","model":"again"}', '{"number":9007199254740993}',
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x30, 0x7d])]) {
      assert.equal((await send(f.provider, body)).status, 400);
    }
    assert.ok(f.requests.every(row => row.operation.type === 'conversation_capabilities'));
  } finally { await f.provider.close(); }
});

test('tool argument duplicate keys and duplicate/missing results are not silently repaired', () => {
  const body = request(); body.tools = [tool()];
  const call = { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function',
    function: { name: 'read', arguments: '{"file":"a","file":"b"}' } }] };
  body.messages.push(call, { role: 'tool', tool_call_id: 'call', content: 'Done' });
  assert.throws(() => toConversation(body, MODEL, caps(MODEL)), /duplicate_json_key/);
  call.tool_calls[0].function.arguments = '{}';
  body.messages.push({ role: 'tool', tool_call_id: 'call', content: 'Duplicate' });
  assert.throws(() => toConversation(body, MODEL, caps(MODEL)), /tool_result_correlation/);
  body.messages.splice(-2);
  assert.throws(() => toConversation(body, MODEL, caps(MODEL)));
});

test('a cleanup-confirmed unmet tool choice is terminal and cannot become a different successful outcome', async t => {
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: result(undefined, MODEL) });
  });
  try {
    for (const choice of ['required', { type: 'function', function: { name: 'read' } }]) {
      const body = request(); body.tools = [tool()]; body.tool_choice = choice;
      const response = await send(f.provider, body);
      assert.equal(response.status, 422);
      assert.equal(JSON.parse(response.body).error.code, 'tool_choice_not_met');
    }
  } finally { await f.provider.close(); }
});

test('transient core failures keep their retryable status without claiming a completed turn', async t => {
  for (const code of ['busy', 'execution_failed']) {
    const f = await start(t, (socket, message) => {
      if (code === 'execution_failed') reply(socket, message, 'admitted');
      reply(socket, message, 'error', {code});
    }, true);
    try {
      const response = await send(f.provider, request());
      assert.equal(response.status, 503);
      assert.equal(JSON.parse(response.body).error.code, code);
      assert.equal(f.provider.diagnostics.summary.completed, 0);
      assert.equal(f.provider.diagnostics.summary.incomplete, 0);
      assert.equal(f.provider.diagnostics.summary.request_errors[code], 1);
      assert.equal(f.provider.observations.cleanup_confirmed, code === 'execution_failed' ? 1 : 0);
    } finally { await f.provider.close(); }
  }
});

test('negotiated admitted budget exhaustion is cleanup-confirmed HTTP422, never a completed model result', async t => {
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted');
    reply(socket, message, 'error', {code: 'execution_budget_exceeded'});
  }, true);
  try {
    const response = await send(f.provider, request());
    assert.equal(response.status, 422);
    assert.equal(JSON.parse(response.body).error.code, 'execution_budget_exceeded');
    assert.deepEqual(f.requests[0].operation, {type: 'conversation_capabilities', generation_policy_version: 1,
      execution_error_version: 1});
    assert.equal(f.provider.diagnostics.summary.request_errors.execution_budget_exceeded, 1);
    assert.deepEqual(f.provider.observations, {submitted: 1, completed: 0, incomplete: 0, cleanup_confirmed: 1});
    assert.deepEqual(f.provider.diagnostics.records, []);
  } finally { await f.provider.close(); }
});

test('budget code before admission or under another correlation is not a cleanup receipt', async t => {
  for (const mode of ['unadmitted', 'wrong-id']) {
    const f = await start(t, (socket, message) => {
      if (mode === 'wrong-id') reply(socket, message, 'admitted');
      reply(socket, mode === 'wrong-id' ? {...message, id: 'f'.repeat(32)} : message,
        'error', {code: 'execution_budget_exceeded'});
    }, true);
    try {
      const response = await send(f.provider, request());
      assert.notEqual(response.status, 422);
      assert.equal(f.provider.observations.cleanup_confirmed, 0);
      assert.equal(f.provider.diagnostics.summary.request_errors.execution_budget_exceeded, 0);
    } finally { await f.provider.close(); }
  }
});

test('reaped execution failure followed by success accounts for both cleanups, not two model results', async t => {
  let attempts = 0;
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted');
    if (++attempts === 1) reply(socket, message, 'error', {code: 'execution_failed'});
    else reply(socket, message, 'result', {result: result(undefined, MODEL)});
  }, true);
  try {
    assert.equal((await send(f.provider, request())).status, 503);
    assert.equal((await send(f.provider, request())).status, 200);
    assert.deepEqual(f.provider.observations, {submitted: 2, completed: 1, incomplete: 0, cleanup_confirmed: 2});
    const summary = f.provider.diagnostics.summary;
    assert.equal(summary.cleanup_confirmed, 2);
    assert.equal(summary.request_errors.execution_failed, 1);
    assert.deepEqual(summary.results, {assistant: 1, function_call: 0, incomplete: 0});
    assert.equal(f.provider.diagnostics.records.length, 1);
  } finally { await f.provider.close(); }
});

test('unadmitted, uncertain, unknown or uncorrelated failures never count as confirmed cleanup', async t => {
  for (const kind of ['unadmitted', 'cleanup_unconfirmed', 'invalid_request', 'unknown', 'wrong-id', 'disconnect']) {
    const f = await start(t, (socket, message) => {
      if (kind !== 'unadmitted') reply(socket, message, 'admitted');
      if (kind === 'disconnect') { socket.destroy(); return; }
      reply(socket, kind === 'wrong-id' ? {...message, id: 'f'.repeat(32)} : message, 'error', {
        code: ['unadmitted', 'wrong-id'].includes(kind) ? 'execution_failed' : kind,
      });
    }, true);
    try {
      assert.notEqual((await send(f.provider, request())).status, 200);
      assert.equal(f.provider.observations.cleanup_confirmed, 0, kind);
      assert.equal(f.provider.diagnostics.summary.cleanup_confirmed, 0, kind);
      assert.equal(f.provider.observations.completed, 0);
    } finally { await f.provider.close(); }
  }
});

test('cleanup uncertainty never exports model text or a tool proposal', async t => {
  const original = result({ type: 'assistant', text: 'PRIVATE_DO_NOT_EXPORT' }, MODEL);
  original.cleanup.complete = false;
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted'); reply(socket, message, 'result', { result: original });
  });
  try {
    const response = await send(f.provider, request());
    assert.equal(response.status, 503);
    assert.equal(JSON.parse(response.body).error.code, 'cleanup_unconfirmed');
    assert.ok(!response.body.includes('PRIVATE_DO_NOT_EXPORT'));
    assert.equal(f.provider.observations.cleanup_confirmed, 0);
  } finally { await f.provider.close(); }
});

test('HTTP disconnect cancels the exact task and holds the execution slot until terminal cleanup', async t => {
  let admitted, cancellation, original;
  const started = new Promise(resolve => { admitted = resolve; });
  const cancelled = new Promise(resolve => { cancellation = resolve; });
  const f = await start(t, (socket, message) => {
    if (message.operation.type === 'submit_conversation') {
      original = message; reply(socket, message, 'admitted'); admitted();
    } else {
      assert.equal(message.operation.task_id, original.id);
      reply(socket, message, 'cancel_requested', { task_id: original.id });
      cancellation(() => reply(socket, original, 'error', { code: 'cancelled' }));
    }
  });
  try {
    const body = JSON.stringify(request());
    const req = http.request(f.provider.baseUrl + '/chat/completions', { method: 'POST', headers: {
      authorization: `Bearer ${f.provider.bearerToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } });
    req.on('error', () => {}); req.end(body);
    await started; req.destroy();
    const finish = await cancelled;
    assert.equal((await send(f.provider, request())).status, 503);
    finish();
    await f.provider.close();
    assert.deepEqual(f.provider.observations, {submitted: 1, completed: 0, incomplete: 0, cleanup_confirmed: 1});
    assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities', 'submit_conversation', 'cancel']);
  } finally { await f.provider.close(); }
});

test('large native-shaped system prompts pass unchanged and diagnostics remain content-free', async t => {
  const f = await start(t, (socket, message) => {
    reply(socket, message, 'admitted');
    reply(socket, message, 'result', { result: result({ type: 'assistant', text: 'PRIVATE_CANARY' }, MODEL) });
  }, true);
  try {
    const body = request();
    body.messages[0].content = 'Bounded native instruction. '.repeat(1500);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 32768);
    chunks(await send(f.provider, body));
    assert.equal(f.requests[1].operation.conversation.instructions, body.messages[0].content);
    assert.ok(!JSON.stringify(f.provider.diagnostics).includes('PRIVATE_CANARY'));
    assert.equal(f.provider.diagnostics.records[0].turn_complete, true);
    assert.ok(Object.isFrozen(f.provider.diagnostics.records[0]));
    assert.equal(f.provider.diagnostics.summary.results.assistant, 1);
    assert.equal(f.provider.diagnostics.summary.completed, 1);
    assert.ok(Object.isFrozen(f.provider.diagnostics.summary.request_errors));
    await Promise.all([f.provider.close(), f.provider.close()]);
  } finally { await f.provider.close(); }
});
