// SPDX-License-Identifier: GPL-3.0-only
// Framed socket/HTTP contracts with synthetic replies; no native inference proof.
'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const http = require('node:http');
const {PrivateNativeSession, sessionCapabilities, SESSION_LIMITS} = require('../src/private-native-session.cjs');
const {validateResult} = require('../src/private-conversation.cjs');
const {terminalCleanupConfirmed} = require('../src/private-compute.cjs');
const {startChatCompletionsProvider} = require('../src/chat-completions-provider.cjs');
const {caps, input, result, reply, fixture} = require('./conversation-fixture.cjs');

const MODEL = 'qwen3-4b-instruct-2507-v1';
const CLEAN = Object.freeze({version: 1, child_reaped: true, private_state_removed: true});
function nativeCaps() { return {...caps(MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'],
  execution_error_version: 1, inference_backend: 'llama_cpp_bf16_v1', required_generation_policy: 'greedy_v1',
  native_session_version: 1, native_session: {...SESSION_LIMITS}}; }
function conversation() { return {...input(), generation_policy: 'greedy_v1'}; }
function answer() { return {...result(undefined, MODEL), version: 2, generation_policy: 'greedy_v1',
  cleanup: {version: 2, request_files_removed: true, session_closed: false, session_private_state_retained: true}}; }
async function setup(t, handler, capabilities = nativeCaps()) {
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'open_native_session') reply(socket, request, 'native_session_opened');
    else handler(socket, request);
  }, capabilities);
  const session = new PrivateNativeSession(f.socketPath);
  t.after(() => session.close());
  return {...f, session};
}
function closeReply(socket, request) {
  reply(socket, request, 'native_session_closed', {cleanup: CLEAN}); socket.end();
}
function generate(socket, request) {
  reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: answer()});
}
test('one connection reuses two complete ordinary conversations and proves cleanup only on joined close', async t => {
  const f = await setup(t, (socket, request) => {
    if (request.operation.type === 'close_native_session') closeReply(socket, request);
    else generate(socket, request);
  });
  await f.session.open();
  const original = conversation();
  const first = await f.session.submit(original), second = await f.session.submit(original);
  assert.equal(first.version, 2); assert.equal(second.version, 2);
  assert.equal(f.session.sessionCleanupConfirmed, false);
  assert.throws(() => validateResult(first, caps(MODEL), original));
  assert.deepEqual(f.requests[0].operation, {type: 'conversation_capabilities', generation_policy_version: 1,
    execution_error_version: 1, native_session_version: 1});
  assert.deepEqual(f.requests.slice(2).map(row => row.operation.conversation), [original, original]);
  await f.session.finish();
  assert.equal(f.session.sessionCleanupConfirmed, true);
  assert.deepEqual(f.requests.map(row => row.operation.type), ['conversation_capabilities',
    'open_native_session', 'submit_conversation', 'submit_conversation', 'close_native_session']);
  await f.session.finish();
  await assert.rejects(f.session.submit(original), /not_connected/);
});
test('native capabilities are closed and cannot silently accept old core, widened limits or wrong backend', () => {
  for (const changed of [caps(MODEL), {...nativeCaps(), native_session_version: 2},
    {...nativeCaps(), native_session: {...SESSION_LIMITS, max_task_seconds: 2401}},
    {...nativeCaps(), native_session: {...SESSION_LIMITS, token: 'not-authority'}},
    {...nativeCaps(), inference_backend: 'remote_unverified'}]) {
    assert.throws(() => sessionCapabilities(changed));
  }
  assert.ok(Object.isFrozen(sessionCapabilities(nativeCaps()).native_session));
});
test('legacy or falsely cleaned results cannot release a warm model answer', async t => {
  for (const changed of [result(undefined, MODEL), {...answer(), cleanup: {...answer().cleanup, session_closed: true}},
    {...answer(), cleanup: {...answer().cleanup, request_files_removed: false}}]) {
    const f = await setup(t, (socket, request) => {
      reply(socket, request, 'admitted'); reply(socket, request, 'result', {result: changed});
    });
    await f.session.open();
    await assert.rejects(f.session.submit(conversation()));
    assert.equal(f.session.sessionCleanupConfirmed, false);
    await assert.rejects(f.session.finish(), /cleanup_unconfirmed/);
  }
});
test('request cancellation awaits whole-session cleanup, not the cancellation acknowledgement', async t => {
  let admitted, complete, submit;
  const ready = new Promise(resolve => { admitted = resolve; });
  const f = await setup(t, (socket, request) => {
    if (request.operation.type === 'submit_conversation') {
      submit = request; reply(socket, request, 'admitted'); admitted();
    } else if (request.operation.type === 'cancel') {
      reply(socket, request, 'cancel_requested', {task_id: submit.id});
      complete = () => { reply(socket, submit, 'error', {code: 'cancelled', session_cleanup: CLEAN}); socket.end(); };
    } else assert.fail('no retry or extra operation');
  });
  await f.session.open();
  const controller = new AbortController();
  const pending = f.session.submit(conversation(), {signal: controller.signal});
  const rejected = assert.rejects(pending, error => error.code === 'cancelled' && !terminalCleanupConfirmed(error));
  await ready; controller.abort();
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.sessionCleanupConfirmed, false);
  complete(); await rejected; await f.session.finish();
  assert.equal(f.session.sessionCleanupConfirmed, true);
});
test('missing or incorrect session cleanup remains uncertain even after a valid warm answer', async t => {
  for (const cleanup of [null, {...CLEAN, child_reaped: false}, {...CLEAN, private_state_removed: false}]) {
    const f = await setup(t, (socket, request) => {
      if (request.operation.type === 'submit_conversation') generate(socket, request);
      else { reply(socket, request, 'native_session_closed', {cleanup}); socket.end(); }
    });
    await f.session.open(); await f.session.submit(conversation());
    await assert.rejects(f.session.finish());
    assert.equal(f.session.sessionCleanupConfirmed, false);
  }
});
test('bare disconnect is not a cleanup receipt and cannot reconnect this session', async t => {
  let socket;
  const f = await setup(t, (peer, request) => { socket = peer; generate(peer, request); });
  await f.session.open(); await f.session.submit(conversation());
  socket.destroy();
  while (f.session.state !== 'closed') await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.sessionCleanupConfirmed, false);
  await assert.rejects(f.session.finish()); await assert.rejects(f.session.open());
});
test('foreign close receipt and unknown error fields cannot claim cleanup', async t => {
  const f = await setup(t, (socket, request) => {
    reply(socket, {...request, id: 'ab'.repeat(16)}, 'native_session_closed', {cleanup: CLEAN});
  });
  await f.session.open();
  await assert.rejects(f.session.finish());
  assert.equal(f.session.sessionCleanupConfirmed, false);
});
test('opening failure accepts only correlated real cleanup, not a bare error or EOF', async t => {
  for (const cleanup of [CLEAN, null]) {
    const f = await fixture(t, (socket, request) => {
      assert.equal(request.operation.type, 'open_native_session');
      reply(socket, request, 'error', {code: cleanup ? 'execution_failed' : 'cleanup_unconfirmed',
        session_cleanup: cleanup}); socket.end();
    }, nativeCaps());
    const session = new PrivateNativeSession(f.socketPath);
    t.after(() => session.close());
    await assert.rejects(session.open());
    assert.equal(session.sessionCleanupConfirmed, cleanup !== null);
    if (cleanup) await session.finish(); else await assert.rejects(session.finish());
  }
});
test('failed explicit close preserves a proven cleanup receipt but still rejects the operation', async t => {
  const f = await setup(t, (socket, request) => {
    reply(socket, request, 'error', {code: 'execution_failed', session_cleanup: CLEAN}); socket.end();
  });
  await f.session.open();
  await assert.rejects(f.session.finish(), /execution_failed/);
  assert.equal(f.session.sessionCleanupConfirmed, true);
});

function send(provider, prompt) {
  const body = JSON.stringify({model: MODEL, temperature: 0, messages: [{role: 'user', content: prompt}]});
  return new Promise((resolve, reject) => {
    const request = http.request(provider.baseUrl + '/chat/completions', {method: 'POST', headers: {
      authorization: `Bearer ${provider.bearerToken}`, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)}}, response => {
      let value = ''; response.on('data', chunk => { value += chunk; });
      response.on('end', () => resolve({status: response.statusCode, body: JSON.parse(value)}));
    });
    request.on('error', reject); request.end(body);
  });
}
test('normal HTTP provider preserves context and delays full cleanup counters until session close', async t => {
  const f = await setup(t, (socket, request) => {
    if (request.operation.type === 'close_native_session') closeReply(socket, request);
    else generate(socket, request);
  });
  const provider = await startChatCompletionsProvider({socketPath: f.socketPath, model: MODEL,
    nativeSession: true, diagnostics: true});
  t.after(() => provider.close());
  for (const prompt of ['First private input.', 'Second private input.']) {
    const response = await send(provider, prompt);
    assert.equal(response.status, 200);
    assert.equal(response.body.usage.prompt_tokens_details, undefined);
  }
  assert.deepEqual(provider.observations, {submitted: 2, completed: 2, incomplete: 0, cleanup_confirmed: 0});
  assert.equal(f.requests.filter(row => row.operation.type === 'open_native_session').length, 1);
  assert.deepEqual(f.requests.filter(row => row.operation.type === 'submit_conversation')
    .map(row => row.operation.conversation.history[0].text), ['First private input.', 'Second private input.']);
  assert.ok(!JSON.stringify(provider.diagnostics).includes('private input'));
  await provider.close();
  assert.equal(provider.observations.cleanup_confirmed, 2);
  assert.equal(provider.diagnostics.summary.cleanup_confirmed, 2);
});
test('a cleanup-confirmed failed native turn is terminal HTTP422 and cannot replay in a new session', async t => {
  const f = await setup(t, (socket, request) => {
    reply(socket, request, 'admitted');
    reply(socket, request, 'error', {code: 'execution_failed', session_cleanup: CLEAN}); socket.end();
  });
  const provider = await startChatCompletionsProvider({socketPath: f.socketPath, model: MODEL,
    nativeSession: true, diagnostics: true});
  t.after(() => provider.close());
  assert.equal((await send(provider, 'Original task.')).status, 422);
  assert.equal((await send(provider, 'Original task.')).status, 422);
  assert.equal(f.requests.filter(row => row.operation.type === 'submit_conversation').length, 1);
  assert.equal(f.requests.filter(row => row.operation.type === 'open_native_session').length, 1);
  await provider.close();
  assert.deepEqual(provider.observations, {submitted: 1, completed: 0, incomplete: 0, cleanup_confirmed: 1});
});
test('verified idle closure permits a new request, but carries neither tokens nor old context across connections', async t => {
  let firstSocket, firstOpen;
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'open_native_session') {
      firstSocket ??= socket; firstOpen ??= request;
      reply(socket, request, 'native_session_opened');
    } else if (request.operation.type === 'close_native_session') closeReply(socket, request);
    else generate(socket, request);
  }, nativeCaps());
  const provider = await startChatCompletionsProvider({socketPath: f.socketPath, model: MODEL, nativeSession: true});
  t.after(() => provider.close());
  assert.equal((await send(provider, 'Before idle close.')).status, 200);
  closeReply(firstSocket, firstOpen);
  await new Promise(resolve => firstSocket.once('close', resolve));
  assert.equal((await send(provider, 'After idle close.')).status, 200);
  assert.equal(f.requests.filter(row => row.operation.type === 'open_native_session').length, 2);
  await provider.close();
  assert.equal(provider.observations.cleanup_confirmed, 2);
});
