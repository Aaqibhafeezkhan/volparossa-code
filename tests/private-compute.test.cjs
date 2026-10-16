// SPDX-License-Identifier: GPL-3.0-only
// Local protocol fixtures only: these tests do not run a model or prove inference quality.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { PrivateCompute, terminalCleanupConfirmed } = require('../src/private-compute.cjs');

function caps(overrides = {}) {
  return { visibility: 'private_local', local_only: true, model_profile: 'smollm2-360m-v1',
    max_question_bytes: 512, max_context_bytes: 4096, max_request_bytes: 32768,
    max_response_bytes: 65536, execution_slots: 1, max_connections: 8, max_seconds: 600,
    network_access: false, public_cache: false, training: false, cloud_fallback: false,
    model_execution_proven: false, quarantined: false, ...overrides };
}

function answer(overrides = {}) {
  return { version: 1, operation: 'compute_private_task', model_profile: 'smollm2-360m-v1',
    execution_complete: true, answer_complete: true, complete: true, answer_status: 'eos',
    output: { sample_index: 0, text: 'Synthetic protocol-fixture answer, not model inference.',
      generated_tokens: 12, text_truncated: false,
      generation: { version: 1, stop_reason: 'eos', max_new_tokens: 256,
        model_profile: 'smollm2-360m-v1' } },
    local_only: true, private_data_supported: true, distributed_execution_claimed: false,
    private_training_claimed: false, semantic_completeness_proven: false,
    model_answer_correctness_proven: false,
    cleanup: { complete: true, retained_input: false, retained_report: false }, ...overrides };
}

function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  return Buffer.concat([header, data]);
}

function reply(socket, request, event, extra = {}) {
  socket.write(frame({ version: 1, id: request.id, event, ...extra }));
}

async function fixture(t, handler, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vp-code-private-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 'compute.sock');
  const sockets = new Set();
  const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let incoming = Buffer.alloc(0);
    socket.on('data', bytes => {
      incoming = Buffer.concat([incoming, bytes]);
      while (incoming.length >= 4 && incoming.length >= incoming.readUInt32BE() + 4) {
        const length = incoming.readUInt32BE();
        const request = JSON.parse(incoming.subarray(4, length + 4));
        incoming = incoming.subarray(length + 4);
        requests.push(request);
        if (request.operation.type === 'capabilities') {
          reply(socket, request, 'capabilities', { capabilities: options.capabilities ?? caps() });
        } else handler(socket, request);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const client = new PrivateCompute(socketPath);
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true });
  });
  return { client, socketPath, directory, requests, sockets };
}

test('legacy Q&A never accepts the conversational terminal budget vocabulary', async t => {
  const f = await fixture(t, (socket, request) => {
    reply(socket, request, 'admitted');
    reply(socket, request, 'error', {code: 'execution_budget_exceeded'});
  });
  await f.client.connect();
  await assert.rejects(f.client.ask({question: 'Q', context: 'C'}), error => {
    assert.equal(error.code, 'invalid_response');
    assert.equal(terminalCleanupConfirmed(error), false);
    return true;
  });
  assert.deepEqual(f.requests[0].operation, {type: 'capabilities'});
});

test('real Unix framing preserves the exact private result across partial and coalesced frames', async t => {
  const original = answer();
  const f = await fixture(t, (socket, request) => {
    const bytes = Buffer.concat([
      frame({ version: 1, id: request.id, event: 'admitted' }),
      frame({ version: 1, id: request.id, event: 'result', result: original }),
    ]);
    socket.write(bytes.subarray(0, 2));
    setImmediate(() => socket.write(bytes.subarray(2, 7)));
    setImmediate(() => socket.write(bytes.subarray(7)));
  });
  assert.equal((await f.client.connect()).visibility, 'private_local');
  assert.deepEqual(await f.client.ask({ question: 'Explain this selection.', context: 'const x = 1;' }), original);
  assert.deepEqual(f.requests.map(item => item.operation.type), ['capabilities', 'submit']);
  assert.notEqual(f.requests[0].id, f.requests[1].id);
});

test('token-limited output remains an incomplete answer instead of becoming completed text', async t => {
  const partial = answer();
  partial.answer_complete = partial.complete = false;
  partial.answer_status = 'token_limit';
  partial.output.generated_tokens = 256;
  partial.output.generation.stop_reason = 'token_limit';
  const f = await fixture(t, (socket, request) => {
    reply(socket, request, 'admitted');
    reply(socket, request, 'result', { result: partial });
  });
  await f.client.connect();
  assert.deepEqual(await f.client.ask({ question: 'Q', context: 'C' }), partial);
});

test('public, cloud, unknown or widened capabilities are rejected before any submit', async t => {
  for (const change of [{ visibility: 'public_cooperative' }, { cloud_fallback: true },
    { network_access: true }, { public_cache: true }, { training: true },
    { max_context_bytes: 99999 }, { execution_slots: 2 }, { model_profile: 'unknown' },
    { max_seconds: 0 }, { arbitrary: true }]) {
    await t.test(JSON.stringify(change), async child => {
      const f = await fixture(child, () => assert.fail('must not submit'), { capabilities: caps(change) });
      await assert.rejects(f.client.connect());
      assert.equal(f.requests.length, 1);
    });
  }
});

test('owner and permission checks reject a loose socket or parent, symlink and non-socket', async t => {
  const f = await fixture(t, () => assert.fail('must not submit'));
  await fs.chmod(f.socketPath, 0o666);
  await assert.rejects(f.client.connect(), { code: 'socket_ownership' });
  await fs.chmod(f.socketPath, 0o600);
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(new PrivateCompute(f.socketPath).connect(), { code: 'socket_ownership' });
  await fs.chmod(f.directory, 0o700);
  const link = path.join(f.directory, 'link.sock');
  await fs.symlink(f.socketPath, link);
  await assert.rejects(new PrivateCompute(link).connect(), { code: 'socket_ownership' });
  const regular = path.join(f.directory, 'regular');
  await fs.writeFile(regular, '', { mode: 0o600 });
  await assert.rejects(new PrivateCompute(regular).connect(), { code: 'socket_ownership' });
  assert.throws(() => new PrivateCompute('relative.sock'), { code: 'invalid_socket_path' });
});

test('UTF-8 byte limits, empty text, NUL and invalid Unicode reject without submitting', async t => {
  const f = await fixture(t, () => assert.fail('invalid text must never submit'));
  await f.client.connect();
  for (const input of [{ question: 'é'.repeat(257), context: 'C' },
    { question: 'Q', context: '🙂'.repeat(1025) }, { question: ' ', context: 'C' },
    { question: 'Q', context: 'NUL\0text' }, { question: '\ud800', context: 'C' }]) {
    await assert.rejects(f.client.ask(input), { code: 'invalid_text' });
  }
  assert.equal(f.requests.length, 1);
});

test('AbortSignal sends one correlated cancel and awaits terminal cancellation after the acknowledgement', async t => {
  let submit;
  let finishCancel;
  const acknowledged = new Promise(resolve => { finishCancel = resolve; });
  const f = await fixture(t, (socket, request) => {
    if (request.operation.type === 'submit') {
      submit = request;
      reply(socket, request, 'admitted');
    } else {
      assert.equal(request.operation.task_id, submit.id);
      reply(socket, request, 'cancel_requested', { task_id: submit.id });
      finishCancel(() => reply(socket, submit, 'error', { code: 'cancelled' }));
    }
  });
  await f.client.connect();
  const controller = new AbortController();
  const task = f.client.ask({ question: 'Q', context: 'C', signal: controller.signal });
  const rejected = assert.rejects(task, { code: 'cancelled', name: 'AbortError' });
  controller.abort();
  const terminal = await acknowledged;
  let settled = false;
  task.catch(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'cancel_requested must not claim worker cleanup');
  terminal();
  await rejected;
  assert.deepEqual(f.requests.map(item => item.operation.type), ['capabilities', 'submit', 'cancel']);
});

test('cleanup uncertainty, model substitution and false completeness never expose a result', async t => {
  const cases = [answer({ cleanup: { complete: false, retained_input: true, retained_report: true } }),
    answer({ model_profile: 'smollm2-1.7b-v1' }), answer({ answer_complete: false }),
    answer({ model_answer_correctness_proven: true })];
  for (const invalid of cases) {
    await t.test(JSON.stringify(invalid.cleanup), async child => {
      const f = await fixture(child, (socket, request) => {
        reply(socket, request, 'admitted');
        reply(socket, request, 'result', { result: invalid });
      });
      await f.client.connect();
      await assert.rejects(f.client.ask({ question: 'Q', context: 'C' }));
    });
  }
});

test('oversized, invalid UTF-8 and uncorrelated response frames fail without raw diagnostics', async t => {
  for (const kind of ['oversized', 'utf8', 'correlation']) {
    await t.test(kind, async child => {
      const f = await fixture(child, (socket, request) => {
        if (kind === 'oversized') {
          const header = Buffer.alloc(4); header.writeUInt32BE(65537); socket.write(header);
        } else if (kind === 'utf8') {
          socket.write(Buffer.from([0, 0, 0, 2, 0xc0, 0xaf]));
        } else {
          reply(socket, { id: 'f'.repeat(32) }, 'result', { result: { text: 'secret-canary' } });
        }
      });
      await f.client.connect();
      await assert.rejects(f.client.ask({ question: 'Q', context: 'C' }), error => {
        assert.ok(!error.message.includes('secret-canary'));
        return true;
      });
    });
  }
});

test('disconnect rejects an active task, cannot reconnect implicitly, and never retries', async t => {
  let admitted;
  const started = new Promise(resolve => { admitted = resolve; });
  const f = await fixture(t, (socket, request) => {
    reply(socket, request, 'admitted');
    admitted();
  });
  await f.client.connect();
  const task = f.client.ask({ question: 'Q', context: 'C' });
  const rejected = assert.rejects(task, { code: 'disconnected' });
  await started;
  await assert.rejects(f.client.ask({ question: 'Second', context: 'C' }), { code: 'busy' });
  f.client.close();
  await rejected;
  await assert.rejects(f.client.connect(), { code: 'closed' });
  assert.equal(f.requests.length, 2);
});
