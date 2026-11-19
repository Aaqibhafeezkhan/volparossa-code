// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {register, selectionInput} = require('../src/extension.cjs');

function fixture({trusted = true, confirm = true, partial = false, native} = {}) {
  const commands = new Map(), calls = [], documents = [], errors = [];
  const context = {subscriptions: []};
  const editor = {selection: {isEmpty: false}, document: {uri: {scheme: 'file'},
    getText(selection) { assert.equal(selection, editor.selection); return 'const answer = 42;'; }}};
  class Client {
    constructor(path) { calls.push(['connect', path]); }
    async connect() { return {model_profile: 'smol360', max_context_bytes: 4096}; }
    async ask(value) { calls.push(['ask', value]); return {answer_complete: !partial,
      output: {text: '<script>not executable</script>'}, cleanup: {complete: true}}; }
    close() { calls.push(['close']); }
  }
  const api = {
    env: {}, ProgressLocation: {Notification: 15},
    workspace: {isTrusted: trusted, getConfiguration() { return {inspect() {
      return {globalValue: '/run/owner/private.sock', workspaceValue: '/tmp/attacker.sock'};
    }}; }, async openTextDocument(value) { documents.push(value); return value; }},
    commands: {registerCommand(name, action) { commands.set(name, action); return {dispose() {}}; }},
    window: {activeTextEditor: editor, async showInputBox() { return 'Explain this code.'; },
      async showInformationMessage() { return confirm ? 'Send locally' : undefined; },
      async showErrorMessage(value) { errors.push(value); }, async showTextDocument() {},
      async withProgress(_options, action) { return action({}, {isCancellationRequested: false,
        onCancellationRequested() { return {dispose() {}}; }}); }}
  };
  register(api, context, Client, native);
  return {commands, calls, documents, errors, api, context};
}
test('activation has no compute side effects and configuration cannot be redirected by the workspace', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  await f.commands.get('volparossaCode.reviewSelection')();
  assert.deepEqual(f.calls[0], ['connect', '/run/owner/private.sock']);
  const request = f.calls.find(call => call[0] === 'ask')[1];
  assert.equal(request.question, 'Explain this code.'); assert.equal(request.context, 'const answer = 42;');
  assert.deepEqual(Object.keys(request).sort(), ['context', 'question', 'signal']);
  assert.equal(f.documents[0].language, 'plaintext'); assert.match(f.documents[0].content, /not executable/);
  assert.equal(f.calls.at(-1)[0], 'close');
});
test('untrusted, remote and unconfirmed requests never connect', async () => {
  const untrusted = fixture({trusted: false}), refused = fixture({confirm: false}), remote = fixture();
  remote.api.env.remoteName = 'ssh-remote';
  for (const f of [untrusted, refused, remote]) {
    await f.commands.get('volparossaCode.reviewSelection')(); assert.deepEqual(f.calls, []);
  }
});
test('oversized selections are rejected, never silently truncated or replaced by the full document', () => {
  const make = text => ({selection: {isEmpty: false}, document: {uri: {scheme: 'file'}, getText: () => text}});
  assert.equal(selectionInput(make('x'.repeat(4096))).length, 4096);
  for (const text of ['x'.repeat(4097), 'é'.repeat(2049), '\0']) assert.throws(() => selectionInput(make(text)));
  assert.throws(() => selectionInput(null));
});
test('partial answers stay visibly partial and are not automatically applied', async () => {
  const f = fixture({partial: true}); await f.commands.get('volparossaCode.reviewSelection')();
  assert.match(f.documents[0].content, /no \(partial\/truncated\)/); assert.deepEqual(f.errors, []);
});
test('manifest declares trust and machine scope without telemetry, accounts or automatic runtime', () => {
  const value = JSON.parse(readFileSync(new URL('../package.json', `file://${__filename}`)));
  assert.equal(value.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(value.contributes.configuration.properties['volparossaCode.privateSocket'].scope, 'machine');
  assert.equal(value.contributes.configuration.properties['volparossaCode.openCodeRuntime'].scope, 'machine');
  assert.equal(value.contributes.configuration.properties['volparossaCode.publicSocket'].scope, 'machine');
  assert.equal(value.contributes.configuration.properties['volparossaCode.ownerVerification'].scope, 'machine');
  assert.deepEqual(value.contributes.configuration.properties['volparossaCode.ownerVerification'].default, {});
  assert.equal(value.contributes.configuration.properties['volparossaCode.nativeRuntime'], undefined);
  assert.equal(value.dependencies, undefined); assert.equal(value.activationEvents, undefined);
});

function codingFixture({delegation, verification} = {}) {
  const events = [];
  const native = {
    Runtime: {async start(config, options) {
      events.push(['launch', config, options]);
      return {publicDelegation: delegation, async close() { events.push(['cleanup']); },
        async run(prompt, {approve, onStatus}) {
          events.push(['task', prompt]);
          assert.equal(await approve({permission: 'bash', command: 'node --test', directory: '.'}), true);
          onStatus({commands: 1, status: 'completed'});
          return {text: 'Generated reply', commands: 1, nativeTurnCompleted: true, taskVerified: false};
        },
        async stop() { events.push(['stop']); },
      };
    }},
  };
  const f = fixture({native});
  f.api.workspace.workspaceFolders = [{name: 'project', uri: {scheme: 'file', fsPath: '/projects/selected'}}];
  f.api.workspace.getConfiguration = () => ({inspect: key => ({
    globalValue: key === 'ownerVerification' ? verification :
      key === 'privateSocket' ? '/run/owner/conversation.sock' : {version: 1, opencode: '/explicit/runtime'},
    workspaceValue: key === 'privateSocket' ? '/tmp/untrusted.sock' : {opencode: '/project/untrusted-runtime'}
  })});
  f.api.window.showInformationMessage = async (_text, _options, action) => action;
  f.api.window.showWarningMessage = async (text, options, action) => {
    events.push(['approval', text, options]); return action;
  };
  f.api.window.withProgress = async (_options, action) => action({report(value) { events.push(['progress', value]); }}, {
    isCancellationRequested: false, onCancellationRequested() { return {dispose() {}}; }
  });
  return {...f, events, native};
}

test('explicit coding command launches only user-selected inputs, asks one-shot approval and waits for cleanup', async () => {
  const f = codingFixture(); assert.deepEqual(f.events, []);
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.events[0], ['launch', {version: 1, opencode: '/explicit/runtime', socketPath: '/run/owner/conversation.sock'},
    {workspace: '/projects/selected'}]);
  assert(f.events.find(e => e[0] === 'approval')[1].includes('node --test'));
  assert.deepEqual(f.events.at(-1), ['cleanup']);
  assert.equal(f.documents[0].language, 'plaintext');
  assert.match(f.documents[0].content, /not independently verified/);
  assert.match(f.documents[0].content, /Generated reply/); assert.deepEqual(f.errors, []);
});

const ownerCheck = () => ({executable: '/usr/bin/python3', args: ['-B', '-m', 'unittest'],
  timeoutMs: 15000, maxRounds: 3});
function checkedCodingFixture() {
  const config = ownerCheck(), f = codingFixture({verification: config});
  let captured;
  f.native.createWorkspaceVerifier = options => {
    captured = options; f.events.push(['capture-check']);
    return async ({round, signal}) => {
      assert.equal(signal.aborted, false);
      const allowed = await options.approve({type: 'workspace_verifier', workspace: options.workspace,
        executable: options.executable, args: options.args, round, timeoutMs: options.timeoutMs});
      return allowed ? {status: round === 1 ? 'failed' : 'passed', feedback: 'private check output'}
        : {status: 'unavailable', feedback: 'workspace_verifier_not_authorized'};
    };
  };
  f.native.Runtime.start = async (_runtime, options) => {
    f.events.push(['launch', options]);
    // Mutation after capture must not change the selected check.
    config.executable = '/usr/bin/false'; config.args.push('changed-by-model'); config.maxRounds = 16;
    return {async close() { f.events.push(['cleanup']); }, async run(_prompt, options) {
      f.events.push(['task', options]);
      assert.equal(options.maxVerificationRounds, 3);
      let checks = 0, receipt;
      do {
        receipt = await options.verify({round: ++checks, remainingMs: 20000, signal: options.signal});
      } while (receipt.status === 'failed' && checks < options.maxVerificationRounds);
      return {text: 'Generated reply', commands: 0, taskVerified: false,
        verification: {status: receipt.status, checks, continuations: checks - 1}};
    }, async stop() { f.events.push(['stop']); }};
  };
  return {...f, captured: () => captured};
}

test('editor captures a fixed user check before startup and asks separately for every round', async () => {
  const f = checkedCodingFixture();
  assert.deepEqual(f.events, []);
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.events[0], ['capture-check']);
  assert.equal(f.captured().workspace, '/projects/selected');
  assert.equal(f.captured().executable, '/usr/bin/python3');
  assert.deepEqual(f.captured().args, ['-B', '-m', 'unittest']);
  assert.equal(f.captured().timeoutMs, 15000);
  const approvals = f.events.filter(e => e[0] === 'approval');
  assert.equal(approvals.length, 2);
  for (let i = 0; i < approvals.length; i++) {
    assert.match(approvals[i][1], new RegExp(`check ${i + 1}/3 once`));
    assert(approvals[i][1].includes(JSON.stringify(['/usr/bin/python3', '-B', '-m', 'unittest'])));
    assert.equal(approvals[i][2].modal, true);
  }
  assert.deepEqual(f.events.at(-1), ['cleanup']);
  assert.match(f.documents[0].content, /Owner-selected check: passed; checks: 2; continuations: 1/);
  assert.match(f.documents[0].content, /not general correctness/);
  assert(!JSON.stringify(f.documents).includes('private check output'));
});

test('declined check is unavailable and startup consent is not check execution authority', async () => {
  const f = checkedCodingFixture();
  f.api.window.showWarningMessage = async () => undefined;
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.errors, []);
  assert.match(f.documents[0].content, /Owner-selected check: unavailable; checks: 1; continuations: 0/);
  assert.deepEqual(f.events.at(-1), ['cleanup']);
});

test('workspace check settings are ignored and an invalid user plan never starts a runtime', async () => {
  const f = codingFixture();
  const inspect = f.api.workspace.getConfiguration().inspect;
  f.api.workspace.getConfiguration = () => ({inspect: key => key === 'ownerVerification'
    ? {workspaceValue: ownerCheck(), workspaceFolderValue: ownerCheck(), defaultValue: ownerCheck()} : inspect(key)});
  f.native.createWorkspaceVerifier = () => assert.fail('workspace must not select the check');
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.errors, []);
  assert(!f.documents[0].content.includes('Owner-selected check:'));
  const bad = codingFixture({verification: {...ownerCheck(), executable: '/project/model-chosen'}});
  await bad.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(bad.events, []);
  assert.match(bad.errors[0], /^Configure the owner verification/);
});

test('declined startup never prepares an owner verifier or a native runtime', async () => {
  const f = checkedCodingFixture();
  f.api.window.showInformationMessage = async text => {
    assert.match(text, /Owner-selected check:/);
    assert.match(text, /including approval/);
    return undefined;
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.events, []); assert.deepEqual(f.documents, []);
});

test('lost trust or deactivation while approving a check grants no authority and still joins cleanup', async () => {
  for (const invalidate of [f => { f.api.workspace.isTrusted = false; },
    f => { f.context.subscriptions.at(-1).dispose(); }]) {
    const f = checkedCodingFixture();
    f.api.window.showWarningMessage = async (_text, _options, action) => { invalidate(f); return action; };
    await f.commands.get('volparossaCode.codingTask')();
    assert.equal(f.errors.length, 1); assert.deepEqual(f.documents, []);
    assert.deepEqual(f.events.at(-1), ['cleanup']);
  }
});

test('progress cancellation reaches owner checks through the original task signal', async () => {
  const f = checkedCodingFixture();
  f.api.window.withProgress = async (_options, action) => action({}, {
    isCancellationRequested: true, onCancellationRequested() { return {dispose() {}}; }
  });
  f.native.createWorkspaceVerifier = () => async ({signal}) => {
    assert.equal(signal.aborted, true);
    return {status: 'unavailable', feedback: 'workspace_verifier_cancelled'};
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.errors, []);
  assert(!f.events.some(e => e[0] === 'approval'));
  assert.match(f.documents[0].content, /Owner-selected check: unavailable/);
  assert.deepEqual(f.events.at(-1), ['cleanup']);
});

test('terminal public responses are not presented as complete peer answers', async () => {
  const f = codingFixture({delegation: {submitted: 1, completed: 1, cleanup_confirmed: true}});
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.errors, []);
  assert.match(f.documents[0].content, /terminal responses: 1/);
  assert.match(f.documents[0].content, /Terminal responses may contain incomplete answers/);
  assert.doesNotMatch(f.documents[0].content, /; completed: 1/);
});

test('cancelled consent, remote, untrusted and missing folders never launch a native runtime', async () => {
  for (const configure of [f => { f.api.window.showInformationMessage = async () => undefined; },
    f => { f.api.env.remoteName = 'ssh-remote'; }, f => { f.api.workspace.isTrusted = false; },
    f => { f.api.workspace.workspaceFolders = []; }]) {
    const f = codingFixture(); configure(f);
    await f.commands.get('volparossaCode.codingTask')(); assert.deepEqual(f.events, []);
  }
});

test('runtime cleanup failure never displays a successful coding result or raw private error', async () => {
  const f = codingFixture();
  f.native.Runtime.start = async () => ({async run() { return {text: 'unreleased', commands: 0}; },
    async close() { throw Error('private-token-and-path'); }});
  await f.commands.get('volparossaCode.codingTask')();
  assert.deepEqual(f.documents, []); assert.equal(f.errors.length, 1);
  assert(!f.errors[0].includes('private-token-and-path'));
});

test('deactivation during native startup closes the new runtime without beginning a task', async () => {
  const f = codingFixture(); let joined = false;
  f.native.Runtime.start = async () => {
    f.context.subscriptions.at(-1).dispose();
    return {async close() { joined = true; }};
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert.equal(joined, true); assert.deepEqual(f.events, []); assert.deepEqual(f.documents, []);
});

test('deactivation while progress callback is queued cannot begin native inference', async () => {
  const f = codingFixture();
  f.api.window.withProgress = async (_options, action) => {
    f.context.subscriptions.at(-1).dispose();
    return action({}, {});
  };
  await f.commands.get('volparossaCode.codingTask')();
  assert(!f.events.some(e => e[0] === 'task'));
  assert.deepEqual(f.events.at(-1), ['cleanup']);
  assert.deepEqual(f.documents, []);
});

test('public coding enrollment contains only the exact reviewed excerpt and public question', async () => {
  const f = codingFixture(), opaque = Object.freeze({}), enrollments = [];
  const original = f.api.workspace.getConfiguration;
  f.api.workspace.getConfiguration = () => ({inspect: key => key === 'publicSocket'
    ? {globalValue: '/run/owner/public.sock', workspaceValue: '/tmp/attacker.sock'}
    : original().inspect(key)});
  const questions = ['Review this public function.', 'Private task context must stay with the local model.'];
  f.api.window.showInputBox = async () => questions.shift();
  f.api.window.showQuickPick = async values => { assert(values.includes('GPL-3.0-only')); return 'GPL-3.0-only'; };
  f.native.createPublicSnapshot = value => { enrollments.push(value); return opaque; };
  await f.commands.get('volparossaCode.codingPublicTask')();
  assert.deepEqual(enrollments, [{question: 'Review this public function.', context: 'const answer = 42;',
    license: 'GPL-3.0-only', public_content: true, rights_confirmed: true}]);
  const launch = f.events.find(event => event[0] === 'launch');
  assert.deepEqual(launch[2].cooperation, {socketPath: '/run/owner/public.sock', snapshot: opaque});
  assert.equal(launch[1].cooperativeSocketPath, undefined);
  assert(f.events.find(event => event[0] === 'task')[1].includes('volparossa_delegate_public'));
  assert(f.documents[0].content.includes('Exact selected code:\nconst answer = 42;'));
  assert(!JSON.stringify(enrollments).includes('Private task'));
  assert.deepEqual(f.errors, []);
});

test('public snapshot cancellation or invalid socket cannot launch or authorize sharing', async () => {
  for (const missing of [false, true]) {
    const f = codingFixture();
    const original = f.api.workspace.getConfiguration;
    f.api.workspace.getConfiguration = () => ({inspect: key => key === 'publicSocket'
      ? {globalValue: missing ? '' : '/run/owner/public.sock'} : original().inspect(key)});
    f.api.window.showQuickPick = async () => 'GPL-3.0-only';
    f.api.window.showWarningMessage = async () => undefined;
    f.native.createPublicSnapshot = () => assert.fail('no enrollment');
    await f.commands.get('volparossaCode.codingPublicTask')();
    assert.deepEqual(f.events, []);
  }
});

async function publicSourceCodingFixture(t) {
  const fs = require('node:fs/promises'), path = require('node:path');
  const {INPUT} = require('./public-code-fixture.cjs');
  const workspace = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'vp-code-editor-source-'));
  t.after(() => fs.rm(workspace, {recursive: true, force: false}));
  const file = path.join(workspace, 'source.js');
  await fs.writeFile(file, INPUT.context, {mode: 0o600});
  await fs.writeFile(path.join(workspace, 'private.txt'), 'PRIVATE_OTHER_FILE', {mode: 0o600});
  const f = codingFixture();
  f.api.workspace.workspaceFolders = [{name: 'source', uri: {scheme: 'file', fsPath: workspace}}];
  f.api.window.activeTextEditor = {selection: {isEmpty: true}, document: {
    uri: {scheme: 'file', fsPath: file}, isDirty: false, version: 1,
    getText() { assert.fail('the complete saved source must be captured, not an editor excerpt'); },
  }};
  const inspect = f.api.workspace.getConfiguration().inspect;
  f.api.workspace.getConfiguration = () => ({inspect: key => key === 'publicSocket'
    ? {globalValue: '/run/owner/public-code.sock', workspaceValue: '/tmp/untrusted.sock'} : inspect(key)});
  const questions = [INPUT.question, 'PRIVATE_PLAN stays with the current private planner.'];
  f.api.window.showInputBox = async () => questions.shift();
  f.api.window.showQuickPick = async () => INPUT.license;
  f.native.createPublicSnapshot = () => assert.fail('code enrollment must not use document purpose');
  return {...f, file, workspace, input: INPUT};
}

test('native agent enrollment routes the complete saved source through the actual v6 proxy, not document work', async t => {
  const f = await publicSourceCodingFixture(t);
  const core = await require('./public-code-fixture.cjs').fixture(t);
  const {startCooperativeTool} = require('../src/cooperative-tool-server.cjs');
  const {CooperativeToolClient} = require('../src/cooperative-tool-client.cjs');
  const inspect = f.api.workspace.getConfiguration().inspect;
  f.api.workspace.getConfiguration = () => ({inspect: key => key === 'publicSocket'
    ? {globalValue: core.socketPath, workspaceValue: '/tmp/untrusted.sock'} : inspect(key)});
  let original;
  // Native planner is synthetic here; enrollment, filesystem capture, proxy and
  // framed core transport are real. This is not a real-model coding-loop proof.
  f.native.Runtime.start = async (config, options) => {
    assert.equal(config.socketPath, '/run/owner/conversation.sock');
    assert.equal(options.workspace, f.workspace);
    assert.equal(options.cooperation.socketPath, core.socketPath);
    assert.deepEqual(Object.keys(options.cooperation).sort(), ['snapshot', 'socketPath']);
    const proxy = await startCooperativeTool(options.cooperation);
    return {publicDelegation: proxy.observations, async close() { await proxy.close(); f.events.push(['cleanup']); },
      async run(prompt, {approve}) {
        assert.match(prompt, /PRIVATE_PLAN/); assert.match(prompt, /single_file_replacement_v1/);
        original = await new CooperativeToolClient(proxy.socketPath).execute('opencode_source_test_call');
        assert.equal(original.result.proposal_complete, true);
        assert.equal(original.result.outputs[0].text, 'export const value = 2;\n');
        assert.equal(await approve({permission: 'edit', directory: f.workspace, command: 'Edit source.js',
          metadata: {diff: 'synthetic proposed diff'}}), true);
        return {text: 'Synthetic planner received original peer result.', commands: 0};
      }};
  };
  await f.commands.get('volparossaCode.codingPublicSourceTask')();
  assert.deepEqual(f.errors, []);
  const submits = core.requests.filter(r => r.operation.type === 'public_code_proposal');
  assert.equal(submits.length, 1);
  assert.deepEqual(submits[0].operation, {type: 'public_code_proposal', ...f.input});
  assert.equal(original.core_task_id, submits[0].id);
  assert(!JSON.stringify(core.requests).includes('PRIVATE_PLAN'));
  assert(!JSON.stringify(core.requests).includes('PRIVATE_OTHER_FILE'));
  assert(!JSON.stringify(core.requests).includes(f.workspace));
  assert.match(f.documents[0].content, /Complete saved source file:\nexport const value = 1;/);
  assert.deepEqual(f.events.at(-1), ['cleanup']);
  assert.match(f.documents.at(-1).content, /Enrolled public tasks submitted: 1; terminal responses: 1; cleanup confirmed: true/);
});

test('source enrollment preserves one-shot edits and owner checks in the existing native task path', async t => {
  const f = await publicSourceCodingFixture(t), enrollments = [];
  const inspect = f.api.workspace.getConfiguration().inspect;
  f.api.workspace.getConfiguration = () => ({inspect: key => key === 'ownerVerification'
    ? {globalValue: ownerCheck()} : inspect(key)});
  f.native.createPublicCodeSnapshot = value => { enrollments.push(value); return Object.freeze({}); };
  f.native.createWorkspaceVerifier = options => async ({round}) => {
    const granted = await options.approve({round, executable: options.executable, args: options.args});
    assert.equal(granted, true); return {status: 'passed', feedback: 'PRIVATE_CHECK_OUTPUT'};
  };
  f.native.Runtime.start = async (_config, _options) => ({
    async close() { f.events.push(['cleanup']); },
    async run(_prompt, {approve, verify, maxVerificationRounds, signal}) {
      assert.equal(maxVerificationRounds, 3);
      assert.equal(await approve({permission: 'edit', directory: f.workspace,
        command: 'Edit source.js', metadata: {diff: 'PRIVATE_DIFF'}}), true);
      assert.equal((await verify({round: 1, signal})).status, 'passed');
      return {text: 'Synthetic result', commands: 0, verification: {status: 'passed', checks: 1, continuations: 0}};
    },
  });
  await f.commands.get('volparossaCode.codingPublicSourceTask')();
  assert.deepEqual(f.errors, []); assert.deepEqual(enrollments, [f.input]);
  const approvals = f.events.filter(e => e[0] === 'approval');
  assert.equal(approvals.length, 3); // publication, edit, then owner-selected check
  assert.match(approvals[1][1], /Apply this edit/); assert.match(approvals[2][1], /Run owner-selected check/);
  assert(!JSON.stringify(enrollments).includes('PRIVATE_'));
});

test('unsaved, out-of-workspace, untrusted or declined source enrollment never starts a planner', async t => {
  for (const configure of [f => { f.api.window.activeTextEditor.document.isDirty = true; },
    f => { f.api.window.activeTextEditor.document.uri.fsPath = f.workspace + '/../outside.js'; },
    f => { f.api.workspace.isTrusted = false; },
    f => { f.api.window.showWarningMessage = async () => undefined; },
    f => { f.api.window.showInformationMessage = async () => undefined; }]) {
    const f = await publicSourceCodingFixture(t); configure(f);
    await f.commands.get('volparossaCode.codingPublicSourceTask')();
    assert(!f.events.some(e => e[0] === 'launch' || e[0] === 'task'));
  }
});

function proposalFixture({complete = true, apply = true, cleanup = true} = {}) {
  const events = [], native = {};
  const source = Object.freeze({context: 'export const value = 1;', sourceSha256: 'a'.repeat(64), relativePath: 'source.js'});
  const snapshot = Object.freeze({}), response = Object.freeze({}), proposal = {
    complete, sourceSha256: source.sourceSha256, text: 'export const value = 2;', coreTaskId: 'core-task', toolCallId: 'tool',
    peerReportSha256: 'a'.repeat(64)};
  native.publicCodeFile = {
    capturePublicCodeFile(value) { events.push(['capture', value]); return source; },
    async applyPublicCodeFile(s, token, result, {approve}) {
      assert.equal(s, source); assert.equal(token, snapshot); assert.equal(result, response);
      if (!complete) return {applied: false};
      const accepted = await approve({...proposal, file: '/project/source.js', relativePath: 'source.js', replacementSha256: 'b'.repeat(64)});
      events.push(['apply', accepted]); return {applied: accepted};
    },
  };
  native.publicDelegation = {
    createPublicCodeSnapshot(value) { events.push(['enroll', value]); return snapshot; },
    validatedCodeProposal(s, r) { assert.equal(s, snapshot); assert.equal(r, response); return proposal; },
    CooperativeDelegation: class {
      constructor(socket) { events.push(['socket', socket]); }
      async connect() { events.push(['connect']); }
      async execute(value) { assert.equal(value.snapshot, snapshot); events.push(['execute']); return response; }
      async close() { events.push(['cleanup']); if (!cleanup) throw Error('PRIVATE_FAILURE'); }
    },
  };
  const f = fixture({native});
  f.api.window.activeTextEditor.document = {uri: {scheme: 'file', fsPath: '/project/source.js'}, isDirty: false, version: 1};
  f.api.workspace.workspaceFolders = [{uri: {scheme: 'file', fsPath: '/project'}}];
  f.api.workspace.getConfiguration = () => ({inspect: key => ({globalValue: key === 'publicSocket' ? '/owner/public.sock' : {}})});
  f.api.window.showQuickPick = async () => 'GPL-3.0-only';
  f.api.window.showWarningMessage = async (_text, _options, action) => {
    events.push(['approve', action]); return action === 'Apply replacement once' && !apply ? undefined : action;
  };
  return {...f, events};
}
test('public file command shares exact source only and joins cleanup before separate local edit approval', async () => {
  const f = proposalFixture(); await f.commands.get('volparossaCode.proposePublicFile')();
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.events.find(event => event[0] === 'enroll')[1], {question: 'Explain this code.',
    context: 'export const value = 1;', license: 'GPL-3.0-only', public_content: true, rights_confirmed: true});
  assert(f.events.findIndex(event => event[0] === 'cleanup') < f.events.findIndex(event => event[0] === 'apply'));
  assert.deepEqual(f.events.find(event => event[0] === 'socket'), ['socket', '/owner/public.sock']);
  assert.match(f.documents.at(-1).content, /applied to the selected file/);
  assert.ok(f.documents.at(-1).content.includes('Core task: core-task\nPeer report SHA-256: ' + 'a'.repeat(64)));
  assert.match(f.documents.at(-1).content, /No local test result/);
});
test('incomplete peer output, declined local edit and failed cleanup never apply', async () => {
  for (const options of [{complete: false}, {apply: false}, {cleanup: false}]) {
    const f = proposalFixture(options); await f.commands.get('volparossaCode.proposePublicFile')();
    assert(!f.events.some(event => event[0] === 'apply' && event[1]));
    if (options.cleanup === false) assert(!f.documents.some(document => /generated public peer proposal/.test(document.content)));
  }
});
test('dirty documents and denied public consent never connect or publish', async () => {
  for (const dirty of [true, false]) {
    const f = proposalFixture(); f.api.window.activeTextEditor.document.isDirty = dirty;
    f.api.window.showWarningMessage = async () => undefined;
    await f.commands.get('volparossaCode.proposePublicFile')();
    assert(!f.events.some(event => event[0] === 'enroll' || event[0] === 'socket'));
  }
});
test('editor changes while public task executes block replacement of unsaved work', async () => {
  const f = proposalFixture();
  const old = f.api.window.showTextDocument;
  f.api.window.showTextDocument = async doc => {
    if (/generated public peer proposal/.test(doc.content)) f.api.window.activeTextEditor.document.isDirty = true;
    return old(doc);
  };
  await f.commands.get('volparossaCode.proposePublicFile')();
  assert(!f.events.some(event => event[0] === 'apply' && event[1]));
});
