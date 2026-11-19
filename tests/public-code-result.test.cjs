// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {fixture, result, caps, INPUT, updateReport} = require('./public-code-fixture.cjs');
const {validateCodeResult} = require('../src/public-code-result.cjs');
const {createPublicSnapshot, createPublicCodeSnapshot, validatedCodeProposal} = require('../src/cooperative-delegation.cjs');

test('actual Unix transport keeps source/task/model/report binding and exact raw replacement on both closed profiles', async t => {
  for (const profile of ['qwen3-0.6b-v1', 'qwen3-4b-instruct-2507-v1']) {
    const f = await fixture(t, {profile}), response = await f.execute();
    assert.deepEqual(f.requests[1].operation, {type: 'public_code_proposal', ...INPUT});
    assert.deepEqual(response.result, result(INPUT, profile));
    assert.equal(response.core_task_id, f.requests[1].id);
    const proposal = validatedCodeProposal(f.snapshot, response);
    assert.equal(proposal.peerJobId, response.result.receipt.handle.binding.job_id);
    assert.equal(proposal.peerReportSha256, response.result.receipt.status.report_sha256);
    assert.equal(proposal.text, response.result.outputs[0].text); assert.equal(proposal.complete, true);
    response.result.outputs[0].text = 'caller altered result';
    assert.equal(validatedCodeProposal(f.snapshot, response).text, 'export const value = 2;\n');
    assert.throws(() => validatedCodeProposal(createPublicCodeSnapshot(INPUT), response));
    assert.throws(() => validatedCodeProposal(f.snapshot, {...response}));
    await f.client.close();
  }
});
test('native code endpoint cannot silently accept ordinary document task enrollment', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.execute({tool_call_id: 'wrong-purpose', snapshot: createPublicSnapshot(INPUT)}),
    {code: 'incompatible_capabilities'});
  assert.equal(f.requests.length, 1);
});
test('retained terminal receipt may be verified after execution expiry, without renewing its binding', () => {
  const value = result();
  value.receipt.verified_at_unix_seconds = value.receipt.handle.binding.expires_unix_seconds + 1;
  assert.equal(validateCodeResult(value, INPUT, caps()), value);
  for (const expiry of [0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1, null]) {
    const invalid = structuredClone(value);
    invalid.receipt.handle.binding.expires_unix_seconds = expiry;
    invalid.receipt.status.binding.expires_unix_seconds = expiry;
    assert.throws(() => validateCodeResult(invalid, INPUT, caps()));
  }
});
test('wrong source/hash/receipt/model/row/cleanup cannot become an applyable proposal', () => {
  for (const change of [v => {v.source_sha256 = 'b'.repeat(64);}, v => {v.source_bytes++;},
    v => {v.receipt.status.report_sha256 = 'f'.repeat(64);}, v => {v.model_profile = 'qwen3-4b-instruct-2507-v1';},
    v => {v.receipt.status.binding.job_id = '2'.repeat(32);}, v => {v.receipt.handle.binding.row_indices = [1];},
    v => {v.receipt.status.cancellation_requested = true;}, v => {v.receipt.handle.provider_key = 'b'.repeat(64);},
    v => {v.cleanup_confirmed = false;}, v => {v.outputs[0].text = 'rewritten';},
    v => {v.execution_complete = false;}, v => {v.extra_command = 'execute';},
    v => {v.receipt.handle.capabilities.model.base_weights.sha256 = 'f'.repeat(64);},
    v => updateReport(v, r => {r.dataset.license = 'CC0-1.0';}),
    v => updateReport(v, r => {r.proposal_complete = true; r.outputs[0].generation.stop_reason = 'token_limit';
      r.outputs[0].generated_tokens = 1024;})]) {
    const value = result(); change(value);
    assert.throws(() => validateCodeResult(value, INPUT, caps()));
  }
});
test('partial/truncated raw output remains visible but incomplete; no markdown repair or extraction', async t => {
  for (const mode of ['tokens', 'truncated', 'fenced']) {
    const f = await fixture(t, {change: value => updateReport(value, report => {
      report.outputs[0].text = '```javascript\nwrong();\n```';
      if (mode === 'tokens') {report.outputs[0].generation.stop_reason = 'token_limit'; report.outputs[0].generated_tokens = 1024;}
      if (mode === 'truncated') report.outputs[0].text_truncated = true;
      report.proposal_complete = mode === 'fenced';
    })});
    const response = await f.execute(), proposal = validatedCodeProposal(f.snapshot, response);
    assert.equal(proposal.complete, mode === 'fenced');
    assert.equal(proposal.text, '```javascript\nwrong();\n```');
  }
});
test('corrupt admitted reply makes cleanup uncertain, not a successful public code result', async t => {
  const f = await fixture(t, {change: value => {value.cleanup_confirmed = false;}});
  await assert.rejects(f.execute(), {code: 'cleanup_unconfirmed'});
  await assert.rejects(f.client.close(), {code: 'cleanup_unconfirmed'});
});

test('existing native OpenCode socket tool carries only call identity and preserves original public code result', async t => {
  const f = await fixture(t);
  const {startCooperativeTool} = require('../src/cooperative-tool-server.cjs');
  const {CooperativeToolClient} = require('../src/cooperative-tool-client.cjs');
  const proxy = await startCooperativeTool({socketPath: f.socketPath, snapshot: f.snapshot});
  try {
    const value = await new CooperativeToolClient(proxy.socketPath).execute('native_opencode_public_code');
    assert.equal(value.tool_call_id, 'native_opencode_public_code');
    assert.deepEqual(value.result, result());
    const submissions = f.requests.filter(item => item.operation.type === 'public_code_proposal');
    assert.equal(submissions.length, 1);
    assert.deepEqual(submissions[0].operation, {type: 'public_code_proposal', ...INPUT});
    assert.deepEqual(Object.keys(submissions[0]).sort(), ['id', 'operation', 'version']);
  } finally { await proxy.close(); }
  assert.equal(proxy.observations.cleanup_confirmed, true);
});
