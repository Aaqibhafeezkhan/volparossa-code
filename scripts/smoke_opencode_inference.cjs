// SPDX-License-Identifier: GPL-3.0-only
// Explicit disposable-guest trial. No model responses or tool results are supplied.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {OpenCodeRuntime} = require('../src/opencode-runtime.cjs');
const {taskFailure} = require('../src/opencode-bridge.cjs');
const {createWorkspaceVerifier} = require('../src/workspace-verifier.cjs');
const {isCodingModel} = require('../src/opencode-config.cjs');
const {OUTPUT_CONSTRAINT} = require('../src/private-conversation.cjs');

const ORIGINAL = 'def add(a, b):\n    return a - b\n';
const TEST = 'import unittest\nfrom fixture import add\n\nclass AddTests(unittest.TestCase):\n'
  + '    def test_positive(self):\n        self.assertEqual(add(2, 3), 5)\n'
  + '    def test_negative(self):\n        self.assertEqual(add(-4, 1), -3)\n'
  + '    def test_zero(self):\n        self.assertEqual(add(0, 7), 7)\n';
const README = 'Disposable synthetic Python project. Fix fixture.py; keep test_fixture.py unchanged.\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const ENV = {PATH: '/usr/bin:/bin', LANG: 'C.UTF-8'};
const FILES = ['README.txt', 'fixture.py', 'test_fixture.py'];

function retainFailure(evidence, error, aborted = false) {
  evidence.failure ??= aborted ? 'cancelled_or_deadline' : taskFailure(error);
  if (error?.taskCleanupFailure === 'session_cleanup_unconfirmed') evidence.task_cleanup_failure = error.taskCleanupFailure;
}
async function closeRuntime(evidence, runtime) {
  evidence.provider_diagnostics = runtime.diagnostics ?? null;
  evidence.native_tool_diagnostics = runtime.taskDiagnostics ?? null;
  try { await runtime.close(); evidence.runtime_cleanup_confirmed = true; }
  catch { evidence.cleanup_failure = 'runtime_cleanup_unconfirmed'; }
}

// This is deliberately a parser for a small ordinary read/test command grammar,
// not a shell sanitizer. The actual workspace is also network/mount isolated.
function commandKind(command) {
  if (typeof command !== 'string' || command.length > 1024 || /[\r\n\0`$;|<>\\]/.test(command)) return null;
  let value = command.trim();
  value = value.replace(/^cd\s+(?:\/workspace|\.)\s*&&\s*/, '');
  if (value.includes('&&')) {
    const parts = value.split(/\s*&&\s*/);
    if (parts.length > 3) return null;
    const kinds = parts.map(commandKind);
    return kinds.includes(null) ? null : kinds.includes('test') ? 'test' : 'read';
  }
  if (value.includes('&') || !/^[A-Za-z0-9_./,'" =-]+$/.test(value)) return null;
  const words = value.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g)?.map(word => word.replace(/^(['"])(.*)\1$/, '$2')) ?? [];
  if (!words.length || words.some(word => !word || /['"]/.test(word))) return null;
  const relative = word => word.replace(/^\/workspace\//, '').replace(/^\.\//, '');
  if (words[0] === 'cat' && words.length >= 2 && words.length <= 4 && words.slice(1).every(word => FILES.includes(relative(word)))) return 'read';
  if (words[0] === 'pwd' && words.length === 1) return 'read';
  if (words[0] === 'ls' && words.slice(1).every(word => ['-l', '-a', '-la', '-al', '.', '/workspace'].includes(word))) return 'read';
  if (words[0] === 'sed' && words.length === 4 && words[1] === '-n' && /^1,(?:[1-9][0-9]?|[12][0-9]{2})p$/.test(words[2])
      && FILES.includes(relative(words[3]))) return 'read';
  if (!['python', 'python3', '/usr/bin/python3'].includes(words[0])) return null;
  let offset = words[1] === '-B' ? 2 : 1;
  if (words[offset++] !== '-m' || words[offset++] !== 'unittest') return null;
  const rest = words.slice(offset);
  const targets = rest.filter(word => !['-v', '-q'].includes(word));
  if (rest.length > 4 || targets.length > 1 || targets.some(word => !['test_fixture', 'test_fixture.py', 'discover'].includes(relative(word)))) return null;
  return 'test';
}

function approvalKind(proposal) {
  if (!proposal || proposal.directory !== '/workspace') return null;
  if (proposal.permission === 'bash') return commandKind(proposal.command);
  const exact = value => ['fixture.py', './fixture.py', '/workspace/fixture.py'].includes(value);
  if (proposal.permission === 'edit' && Array.isArray(proposal.patterns) && proposal.patterns.length === 1
      && exact(proposal.patterns[0]) && (!proposal.metadata?.filepath || exact(proposal.metadata.filepath))) return 'edit';
  return null;
}

async function owned(file, directory = false) {
  assert.equal(await fs.realpath(file), file);
  const info = await fs.lstat(file);
  assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o6022, 0);
  assert.ok(directory ? info.isDirectory() && !(info.mode & 0o077) : info.isFile());
  return info;
}
async function contents(project, name, maximum = 8192) {
  const target = path.join(project, name);
  assert.equal(await fs.realpath(target), target);
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.uid === process.getuid() && (info.mode & 0o6022) === 0 && info.size > 0 && info.size <= maximum);
    const bytes = Buffer.alloc(info.size + 1); let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    assert.ok(size === info.size && ['size', 'mtimeMs', 'mode', 'uid', 'gid'].every(key => info[key] === after[key]));
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

function createTrialVerifier(project, createVerifier = createWorkspaceVerifier) {
  // Owner-selected before the model starts. This current-workspace check never
  // replaces the separate immutable acceptance check below or native approvals.
  return createVerifier({workspace: project, executable: '/usr/bin/python3',
    args: ['-B', '-m', 'unittest', '-v', 'test_fixture.py'], timeoutMs: 15000,
    approve: async () => {
      try { return hash(await contents(project, 'test_fixture.py')) === hash(TEST); }
      catch { return false; }
    }});
}

async function runNativeTrial(runtime, project, controller, evidence, verify) {
  const result = await runtime.run('Read fixture.py and test_fixture.py. Fix the small bug in fixture.py, '
    + 'then run the existing Python unittest tests. Do not modify tests or install dependencies. '
    + 'This is an explicitly selected disposable project. Keep your final answer concise.', {
    signal: controller.signal, verify,
    approve: async proposal => {
      const kind = approvalKind(proposal);
      const count = evidence.approved_read + evidence.approved_edit + evidence.approved_test;
      const intact = hash(await contents(project, 'test_fixture.py')) === hash(TEST);
      if (!kind || count >= 12 || !intact) { evidence.refused++; controller.abort(); return false; }
      evidence['approved_' + kind]++; return true;
    },
    onStatus: status => { evidence.completed_commands = status.commands; if (status.status === 'failed') evidence.failed_commands++; },
  });
  evidence.actual_native_turn_completed = result.nativeTurnCompleted === true;
  evidence.completed_commands = result.commands;
  const {status, checks, continuations} = result.verification;
  evidence.verification = {status, checks, continuations}; // Never export private check output.
}

function bindRuntimeModel(evidence, runtime) {
  assert.equal(runtime.execution, 'private_local');
  assert.equal(runtime.confidentialRemoteAvailable, false);
  assert.ok(isCodingModel(runtime.modelProfile));
  evidence.model_profile = runtime.modelProfile;
}

async function isolatedCheck(project, parent) {
  const check = await fs.mkdtemp(path.join(parent, 'opencode-check-'));
  await fs.chmod(check, 0o700);
  // Copy only verified source bytes, not model-writable imports or bytecode.
  // The checker is never mounted in the model's tool workspace.
  await fs.writeFile(path.join(check, 'fixture.py'), await contents(project, 'fixture.py'), {mode: 0o600, flag: 'wx'});
  await fs.writeFile(path.join(check, 'test_fixture.py'), TEST, {mode: 0o600, flag: 'wx'});
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', check, '/workspace', '--chdir', '/workspace', '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
    '/usr/bin/python3', '-B', '-m', 'unittest', '-v', 'test_fixture.py'];
  try {
    const result = spawnSync('/usr/bin/bwrap', args, {env: ENV, cwd: '/', timeout: 15000,
      killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8'});
    assert.ok(!result.error && !result.signal && /Ran 3 tests in/.test(result.stderr), 'independent check unavailable');
    return result.status === 0 && /\nOK\s*$/.test(result.stderr);
  } finally { await fs.rm(check, {recursive: true, force: false}); }
}

function guestGuard() {
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
  assert.equal(os.userInfo().username, 'vpci'); assert.equal(os.hostname(), 'volparossa-alpha');
  const virt = spawnSync('/usr/bin/systemd-detect-virt', ['--vm'], {env: ENV, timeout: 5000, encoding: 'utf8'});
  assert.equal(virt.status, 0); assert.equal(virt.stdout.trim(), 'kvm');
}

function trialArguments(args) {
  assert.ok(args.length === 12 || args.length === 14);
  assert.deepEqual(args.slice(0, 12).filter((_, index) => index < 2 || index % 2 === 0),
    ['--execute', '--yes', '--node', '--build-report', '--socket', '--project-parent', '--output']);
  if (args.length === 14) assert.deepEqual(args.slice(12), ['--output-constraint', OUTPUT_CONSTRAINT]);
  const [, , , node, , buildReport, , socketPath, , parent, , output] = args;
  return {node, buildReport, socketPath, parent, output,
    ...(args.length === 14 ? {outputConstraint: OUTPUT_CONSTRAINT} : {})};
}

function selectionEvidence(outputConstraint) {
  assert.ok(outputConstraint === undefined || outputConstraint === OUTPUT_CONSTRAINT);
  return outputConstraint === undefined ? {} : {version: 2, output_constraint: OUTPUT_CONSTRAINT};
}

async function startTrialRuntime(config, project, outputConstraint) {
  selectionEvidence(outputConstraint); // Same closed opt-in as the task receipt.
  assert.equal(Object.hasOwn(config, 'outputConstraint'), false);
  return OpenCodeRuntime.start({...config,
    ...(outputConstraint !== undefined ? {outputConstraint} : {})}, {workspace: project});
}

async function main(args = process.argv.slice(2)) {
  if (!args.length || args[0] === '--preview') {
    process.stdout.write(JSON.stringify({execute: false, actual_inference: false,
      scope: 'actual OpenCode/private-core task; parent proves real core/model identity, resource limits and VM cleanup',
      usage: '--execute --yes --node ABS --build-report ABS --socket ABS --project-parent ABS --output NEW'}) + '\n');
    return;
  }
  const {node, buildReport, socketPath, parent, output, outputConstraint} = trialArguments(args);
  guestGuard();
  await owned(parent, true); await owned(path.dirname(output), true);
  assert.ok(path.isAbsolute(output) && !path.basename(output).startsWith('.'));
  await fs.lstat(output).then(() => { throw Error('existing_output'); }, error => { if (error.code !== 'ENOENT') throw error; });
  await owned(node); const info = await owned(buildReport); assert.ok(info.size <= 65536);
  const build = JSON.parse(await fs.readFile(buildReport, 'utf8'));
  const config = {version: 1, opencode: build.binary, opencodeSha256: build.binary_sha256,
    buildReport, node, nodeSha256: hash(await fs.readFile(node)), socketPath};
  // Staged report retains original provenance; the guest may supply its exact
  // binary at the sibling runtime path without rewriting that original report.
  const staged = path.join(path.dirname(buildReport), 'opencode');
  if (await fs.stat(staged).then(s => s.isFile(), () => false)) config.opencode = staged;
  const evidence = {version: 1, kind: 'opencode-actual-core-task', passed: false, phase: 'prepare', failure: null,
    cleanup_failure: null, task_cleanup_failure: null, provider_diagnostics: null, native_tool_diagnostics: null,
    verification: null,
    actual_native_turn_completed: false, synthetic_core_used: false, model_answers_injected: false,
    private_peer_execution_proven: false, general_coding_quality_proven: false,
    core_model_provenance_owned_by_parent: true, vm_cleanup_owned_by_parent: true,
    source_commit: build.source_commit, binary_sha256: build.binary_sha256,
    build_report_sha256: hash(await fs.readFile(buildReport)), node_sha256: config.nodeSha256,
    model_profile: null, approved_read: 0, approved_edit: 0, approved_test: 0,
    refused: 0, completed_commands: 0, failed_commands: 0, original_test_unchanged: false,
    fixture_changed: false, independent_test_passed: false, runtime_cleanup_confirmed: false,
    project_removed: false, original_sha256: hash(ORIGINAL), resulting_sha256: null, elapsed_ms: 0,
    ...selectionEvidence(outputConstraint)};
  const begin = Date.now(), controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 2400000);
  const interrupted = () => controller.abort();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(name, interrupted);
  let project, runtime;
  try {
    project = await fs.mkdtemp(path.join(parent, 'opencode-project-'));
    await fs.chmod(project, 0o700);
    for (const [name, value] of [['fixture.py', ORIGINAL], ['test_fixture.py', TEST], ['README.txt', README]]) {
      await fs.writeFile(path.join(project, name), value, {flag: 'wx', mode: 0o600});
    }
    assert.equal(await isolatedCheck(project, parent), false, 'fixture baseline must really fail');
    const verify = createTrialVerifier(project);
    evidence.phase = 'runtime-start';
    runtime = await startTrialRuntime(config, project, outputConstraint);
    bindRuntimeModel(evidence, runtime);
    evidence.phase = 'native-task';
    await runNativeTrial(runtime, project, controller, evidence, verify);
    evidence.phase = 'independent-check';
    evidence.original_test_unchanged = hash(await contents(project, 'test_fixture.py')) === hash(TEST);
    const changed = await contents(project, 'fixture.py');
    evidence.resulting_sha256 = hash(changed); evidence.fixture_changed = evidence.resulting_sha256 !== hash(ORIGINAL);
    evidence.independent_test_passed = evidence.original_test_unchanged && await isolatedCheck(project, parent);
    assert.ok(evidence.actual_native_turn_completed && evidence.original_test_unchanged && evidence.fixture_changed
      && evidence.independent_test_passed && evidence.approved_edit >= 1 && evidence.approved_test >= 1 && evidence.refused === 0);
    evidence.phase = 'complete';
  } catch (error) {
    retainFailure(evidence, error, controller.signal.aborted);
  } finally {
    clearTimeout(deadline);
    for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(name, interrupted);
    if (runtime) {
      await closeRuntime(evidence, runtime);
    }
    if (project) {
      try { await fs.rm(project, {recursive: true, force: false}); evidence.project_removed = true; }
      catch { evidence.cleanup_failure ??= 'project_cleanup_unconfirmed'; }
    }
    evidence.elapsed_ms = Date.now() - begin;
    evidence.passed = evidence.phase === 'complete' && evidence.failure === null && evidence.cleanup_failure === null
      && evidence.task_cleanup_failure === null
      && evidence.runtime_cleanup_confirmed && evidence.project_removed;
    await fs.writeFile(output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx', mode: 0o600});
    process.stdout.write(JSON.stringify({phase: evidence.phase, passed: evidence.passed, failure: evidence.failure,
      cleanup_failure: evidence.cleanup_failure}) + '\n');
  }
  if (!evidence.passed) process.exitCode = 1;
  return evidence;
}
if (require.main === module) main().catch(() => {
  process.stderr.write('{"passed":false,"phase":"guard","failure":"guard_or_input_rejected"}\n'); process.exitCode = 1;
});
module.exports = {main, commandKind, approvalKind, ORIGINAL, TEST, guestGuard, retainFailure, closeRuntime,
  createTrialVerifier, runNativeTrial, bindRuntimeModel, isolatedCheck,
  trialArguments, selectionEvidence, startTrialRuntime};
