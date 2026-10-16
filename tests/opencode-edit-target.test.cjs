// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {OpenCodeTask, MODEL} = require('../src/opencode-task.cjs');
const {approvalKind} = require('../scripts/smoke_opencode_inference.cjs');

class Client extends EventEmitter {
  constructor(events) { super(); this.workspace = '/workspace'; this.ready = true; this.events = events; this.calls = []; }
  async createSession() { return {id: 'ses_root', directory: this.workspace, model: {id: MODEL, providerID: 'volparossa'}}; }
  async getSession() { return undefined; }
  async prompt() {
    for (const event of this.events) this.emit('event', event);
    return {info: {id: 'msg_result', sessionID: 'ses_root', role: 'assistant', providerID: 'volparossa', modelID: MODEL,
      finish: 'stop', time: {completed: 1}, path: {cwd: this.workspace}}, parts: []};
  }
  async replyPermission(id, accepted) { this.calls.push(['permission', id, accepted]); return true; }
  async abort(id) { this.calls.push(['abort', id]); return true; }
  async deleteSession(id) { this.calls.push(['delete', id]); return true; }
}

function events({input = {filePath: '/workspace/fixture.py'}, patterns = ['workspace/fixture.py'],
  metadata = {filepath: '/workspace/fixture.py', diff: 'synthetic local diff'}, kind = 'edit', request = {}} = {}) {
  return [{type: 'message.part.updated', properties: {sessionID: 'ses_root', part: {
    id: 'prt_tool', type: 'tool', sessionID: 'ses_root', messageID: 'msg_tool', callID: 'call_edit', tool: kind,
    state: {status: 'running', input}}}},
  {type: 'permission.asked', properties: {id: 'per_edit', sessionID: 'ses_root', permission: 'edit',
    patterns, metadata, always: ['*'], tool: {messageID: 'msg_tool', callID: 'call_edit'}, ...request}}];
}

async function exercise(options, approve = proposal => approvalKind(proposal) === 'edit') {
  const original = events(options), before = structuredClone(original);
  const client = new Client(original), proposals = [];
  const task = new OpenCodeTask(client, async proposal => { proposals.push(proposal); return approve(proposal); });
  await task.run('Synthetic approval contract, not a model execution.');
  assert.deepEqual(original, before, 'normalization must not rewrite upstream events');
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
  return {client, task, proposals};
}

test('non-git upstream edit reaches unchanged exact fixture approval through real task events', async () => {
  // Pinned aec0 project.resolve uses worktree '/' without Git. EditTool asks for
  // path.relative('/', '/workspace/fixture.py'), not workspace-relative spelling.
  const {client, task, proposals} = await exercise();
  assert.deepEqual(client.calls.filter(call => call[0] === 'permission'), [['permission', 'per_edit', true]]);
  assert.deepEqual(proposals[0].patterns, ['fixture.py']);
  assert.equal(proposals[0].metadata.filepath, '/workspace/fixture.py');
  assert.equal(approvalKind(proposals[0]), 'edit');
  assert.deepEqual(task.diagnostics.permissions, {requested: 1, forwarded: 1, accepted: 1, rejected: 0, unconfirmed: 0});
});

for (const pattern of ['fixture.py', './fixture.py', '/workspace/fixture.py', 'workspace/fixture.py']) {
  test(`single edit binds supported target spelling ${pattern}`, async () => {
    for (const filePath of ['/workspace/fixture.py', 'fixture.py', './fixture.py']) {
      const {client, proposals} = await exercise({input: {filePath}, patterns: [pattern]});
      assert.deepEqual(proposals[0].patterns, ['fixture.py']);
      assert.equal(proposals[0].command, 'Edit fixture.py');
      assert.deepEqual(client.calls[0], ['permission', 'per_edit', true]);
    }
  });
}

const rejected = {
  'missing input target': {input: {}},
  'non-string input target': {input: {filePath: true}},
  'different input target': {input: {filePath: '/workspace/other.py'}},
  'outside input target': {input: {filePath: '/workspace-other/fixture.py'}},
  'input parent traversal': {input: {filePath: '../workspace/fixture.py'}},
  'input internal traversal': {input: {filePath: 'sub/../fixture.py'}},
  'input backslash': {input: {filePath: 'sub\\fixture.py'}},
  'input wildcard': {input: {filePath: 'fixture.*'}},
  'missing metadata target': {metadata: {}},
  'non-string metadata target': {metadata: {filepath: null}},
  'different metadata target': {metadata: {filepath: '/workspace/other.py'}},
  'relative metadata target': {metadata: {filepath: 'fixture.py'}},
  'noncanonical metadata target': {metadata: {filepath: '/workspace/./fixture.py'}},
  'metadata double separator': {metadata: {filepath: '/workspace//fixture.py'}},
  'metadata trailing separator': {input: {filePath: '/workspace/fixture.py/'},
    metadata: {filepath: '/workspace/fixture.py/'}, patterns: ['fixture.py']},
  'metadata traversal': {metadata: {filepath: '/workspace/sub/../fixture.py'}},
  'metadata control byte': {metadata: {filepath: '/workspace/fixture.py\n'}},
  'outside matched target': {input: {filePath: '/tmp/fixture.py'},
    metadata: {filepath: '/tmp/fixture.py'}, patterns: ['tmp/fixture.py']},
  'workspace prefix collision': {input: {filePath: '/workspace-other/fixture.py'},
    metadata: {filepath: '/workspace-other/fixture.py'}, patterns: ['workspace-other/fixture.py']},
  'workspace itself': {input: {filePath: '/workspace'}, metadata: {filepath: '/workspace'}, patterns: ['workspace']},
  'missing pattern': {patterns: []},
  'multiple patterns': {patterns: ['fixture.py', 'test_fixture.py']},
  'wrong pattern target': {patterns: ['workspace/other.py']},
  'pattern wildcard': {patterns: ['workspace/*.py']},
  'pattern traversal': {patterns: ['workspace/sub/../fixture.py']},
  'pattern outside traversal': {patterns: ['../workspace/fixture.py']},
  'pattern double separator': {patterns: ['workspace//fixture.py']},
  'pattern control byte': {patterns: ['workspace/fixture.py\0']},
  'overlong pattern': {patterns: ['x'.repeat(4097)]},
  'foreign session': {request: {sessionID: 'ses_other'}},
  'foreign message': {request: {tool: {messageID: 'msg_other', callID: 'call_edit'}}},
  'foreign call': {request: {tool: {messageID: 'msg_tool', callID: 'call_other'}}},
  'different permission': {request: {permission: 'external_directory'}},
};
for (const [name, options] of Object.entries(rejected)) {
  test(`single edit rejects ${name} before owner approval`, async () => {
    const {client, task, proposals} = await exercise(options, () => assert.fail('unbound target reached owner'));
    assert.equal(proposals.length, 0);
    assert.deepEqual(client.calls[0], ['permission', 'per_edit', false]);
    assert.deepEqual(task.diagnostics.permissions, {requested: 1, forwarded: 0, accepted: 0, rejected: 1, unconfirmed: 0});
  });
}

test('normalized targets never broaden the exact fixture policy or use a basename shortcut', async () => {
  for (const target of ['test_fixture.py', 'other.py', 'sub/fixture.py']) {
    const filepath = '/workspace/' + target;
    const {client, proposals} = await exercise({input: {filePath: filepath},
      metadata: {filepath}, patterns: ['workspace/' + target]});
    assert.deepEqual(proposals[0].patterns, [target]);
    assert.equal(approvalKind(proposals[0]), null);
    assert.deepEqual(client.calls[0], ['permission', 'per_edit', false]);
  }
});

test('non-edit tool permission payloads are not normalized', async () => {
  for (const kind of ['write', 'apply_patch', 'multiedit']) {
    const {client, proposals} = await exercise({kind});
    assert.deepEqual(proposals[0].patterns, ['workspace/fixture.py']);
    assert.equal(proposals[0].command, 'Edit workspace/fixture.py');
    assert.deepEqual(client.calls[0], ['permission', 'per_edit', false]);
  }
  const {client, proposals} = await exercise({kind: 'bash', input: {command: 'python3 -m unittest'},
    patterns: ['python3 -m unittest'], metadata: {}, request: {permission: 'bash'}}, proposal => approvalKind(proposal) === 'test');
  assert.deepEqual(proposals[0].patterns, ['python3 -m unittest']);
  assert.deepEqual(client.calls[0], ['permission', 'per_edit', true]);
});

test('normalized edit is still one-shot and cannot replay its permission', async () => {
  const original = events(); original.push(structuredClone(original[1]));
  const client = new Client(original); let approvals = 0;
  const task = new OpenCodeTask(client, async proposal => { approvals++; return approvalKind(proposal) === 'edit'; });
  await assert.rejects(task.run('Synthetic replay'), /permission_replay/);
  assert.equal(approvals, 1);
  assert.deepEqual(client.calls.filter(call => call[0] === 'permission'), [['permission', 'per_edit', true]]);
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
});

test('cancel during normalized edit approval rejects late permission and joins task cleanup', async () => {
  const controller = new AbortController(), client = new Client(events()); let release;
  const task = new OpenCodeTask(client, proposal => {
    assert.equal(approvalKind(proposal), 'edit');
    queueMicrotask(() => controller.abort());
    return new Promise(resolve => { release = resolve; });
  });
  await assert.rejects(task.run('Synthetic cancellation', {signal: controller.signal}), /cancelled/);
  release(true);
  assert.deepEqual(client.calls.filter(call => call[0] === 'permission'), [['permission', 'per_edit', false]]);
  assert.ok(client.calls.some(call => call[0] === 'abort'));
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
});

test('normalized edit still requires an affirmative owner decision before its approval deadline', async () => {
  const client = new Client(events());
  const task = new OpenCodeTask(client, () => new Promise(() => {}), {approvalMs: 1});
  await task.run('Synthetic bounded owner approval');
  assert.deepEqual(client.calls.filter(call => call[0] === 'permission'), [['permission', 'per_edit', false]]);
  assert.deepEqual(client.calls.at(-1), ['delete', 'ses_root']);
});
