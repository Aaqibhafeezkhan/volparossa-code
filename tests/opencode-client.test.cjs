// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {OpenCodeClient, MAX_BODY} = require('../src/opencode-client.cjs');
const PASSWORD = 'synthetic-opencode-password';
async function fixture(t, handler = () => false, options = {}) {
  const seen = [], streams = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    const item = {method: req.method, path: url.pathname, directory: url.searchParams.get('directory'),
      auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null}; seen.push(item);
    if (await handler(req, res, item)) return;
    if (item.path === '/event') {
      res.writeHead(200, {'content-type': 'text/event-stream'}); streams.push(res);
      res.write('event: message\r\ndata: {"type":"server.connected","properties":{}}\r\n\r\n'); return;
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(item.path === '/global/health' ? {healthy: true, version: '1.18.34'} : true));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new OpenCodeClient({baseUrl: 'http://127.0.0.1:' + server.address().port, password: PASSWORD,
    timeoutMs: 1000, ...options});
  t.after(() => { client.close(); for (const stream of streams) stream.destroy(); server.closeAllConnections(); server.close(); });
  return {client, seen, streams};
}
test('pinned health, scoped authenticated HTTP, and actual SSE framing', async t => {
  const {client, seen, streams} = await fixture(t);
  await client.connect();
  const received = once(client, 'event');
  const bytes = Buffer.from('data: {"type":"message.part.delta","properties":{"delta":"café"}}\n\n');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  streams[0].write(bytes.subarray(0, split)); streams[0].write(bytes.subarray(split));
  assert.equal((await received)[0].properties.delta, 'café');
  await client.createSession({model: 'qwen3-0.6b-v1'});
  await client.replyPermission('per_fixture', true); await client.replyPermission('per_other', false);
  assert.ok(seen.every(item => item.directory === '/workspace' && item.auth ===
    'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64')));
  assert.equal(seen[2].body.model.providerID, 'volparossa');
  assert.deepEqual(seen.slice(3).map(item => item.body), [{reply: 'once'}, {reply: 'reject'}]);
  assert.ok(seen[2].body.permission.some(rule => rule.permission === '*' && rule.action === 'deny'));
});
test('reject non-loopback, credentials in URL, wrong version and dangerous IDs', async t => {
  for (const baseUrl of ['http://example.com:80', 'http://127.0.0.1:4000/path', 'http://user@127.0.0.1:4000',
    'http://127.0.0.1:4000?x=1', 'https://127.0.0.1:4000']) {
    assert.throws(() => new OpenCodeClient({baseUrl, password: PASSWORD}), /scope/);
  }
  const {client} = await fixture(t, (_req, res, item) => {
    if (item.path !== '/global/health') return false;
    res.writeHead(200, {'content-type': 'application/json'}); res.end('{"healthy":true,"version":"different"}'); return true;
  });
  await assert.rejects(client.connect(), /version/); assert.equal(client.closed, true);
  assert.throws(() => client.getSession('../other'), /session/);
});
test('JSON bounds, redirect rejection, prompt cancellation do not follow external locations', async t => {
  const {client} = await fixture(t, (_req, res, item) => {
    if (item.path === '/session/ses_redirect') { res.writeHead(302, {location: 'http://example.com'}); res.end(); return true; }
    if (item.path === '/session/ses_large') {
      res.writeHead(200, {'content-type': 'application/json'}); res.end('"' + 'x'.repeat(MAX_BODY) + '"'); return true;
    }
    if (item.path === '/session/ses_pending/message') return true;
    return false;
  });
  await client.connect();
  await assert.rejects(client.getSession('ses_redirect'), /rejected/);
  await assert.rejects(client.request('GET', '//example.com/private'), /route/);
  await assert.rejects(client.getSession('ses_large'), /bound/);
  const abort = new AbortController();
  const pending = client.prompt('ses_pending', 'synthetic task', {model: 'qwen3-0.6b-v1', signal: abort.signal});
  abort.abort(); await assert.rejects(pending, /cancelled/);
});
test('invalid and oversized SSE close the client', async t => {
  for (const frame of ['data: not-json\n\n', 'data: ' + 'x'.repeat(MAX_BODY + 1)]) {
    const {client, streams} = await fixture(t); await client.connect();
    const closed = once(client, 'closed'); streams[0].write(frame); await closed; assert.equal(client.closed, true);
  }
});
test('session permission follows owner-supplied cooperative capability, not the model prompt', async t => {
  for (const cooperative of [false, true]) {
    const {client, seen} = await fixture(t, undefined, {cooperative}); await client.connect();
    await client.createSession({model: 'qwen3-0.6b-v1'});
    const permission = seen.at(-1).body.permission.find(rule => rule.permission === 'volparossa_delegate_public');
    assert.equal(permission?.action, cooperative ? 'allow' : undefined);
  }
});
test('SSE CRLF delimiters split across observed response chunks still dispatch the event', async t => {
  const {client, streams} = await fixture(t);
  await client.connect();
  const received = once(client, 'event');
  const frame = 'data: {"type":"message.part.delta","properties":{"delta":"split-crlf"}}';
  const response = client.eventResponse;
  const writeAndObserve = async segment => {
    const observed = new Promise((resolve, reject) => {
      let chunks = [], length = 0;
      const onData = chunk => {
        chunks.push(Buffer.from(chunk));
        length += chunk.length;
        if (length >= Buffer.byteLength(segment)) {
          response.off('data', onData);
          resolve(Buffer.concat(chunks));
        }
      };
      response.on('data', onData);
      response.once('error', reject);
    });
    streams[0].write(segment);
    assert.equal((await observed).toString(), segment);
  };
  await writeAndObserve(frame + '\r');
  await writeAndObserve('\n\r');
  await writeAndObserve('\n');
  assert.equal((await received)[0].properties.delta, 'split-crlf');
});
test('multiple SSE events and comments in one write dispatch once in order', async t => {
  const {client, streams} = await fixture(t);
  await client.connect();
  const received = [];
  await new Promise((resolve, reject) => {
    let quietTimer;
    const deadlineTimer = setTimeout(() => finish(new Error('timed out waiting for SSE events')), 500);
    const finish = error => {
      clearTimeout(deadlineTimer);
      clearTimeout(quietTimer);
      client.off('event', onEvent);
      error ? reject(error) : resolve();
    };
    const onEvent = event => {
      received.push(event);
      if (received.length >= 2) {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(), 50);
      }
    };
    client.on('event', onEvent);
    streams[0].write([
      ': keepalive',
      'data: {"type":"message.part.delta","properties":{"delta":"first"}}',
      '',
      ': another comment',
      'data: {"type":"message.part.delta","properties":{"delta":"second"}}',
      '',
    ].join('\n') + '\n');
  });
  assert.deepEqual(received.map(event => event.properties.delta), ['first', 'second']);
});
test('malformed UTF-8 in an SSE data line closes the client without emitting an event', async t => {
  const {client, streams} = await fixture(t);
  await client.connect();
  let emitted = false;
  client.on('event', () => { emitted = true; });
  const closed = once(client, 'closed');
  streams[0].write(Buffer.concat([
    Buffer.from('data: {"type":"message.part.delta","properties":{"delta":"'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('"}}\n\n'),
  ]));
  await closed;
  assert.equal(client.closed, true);
  assert.equal(emitted, false);
});
