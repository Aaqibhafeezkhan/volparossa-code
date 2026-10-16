// SPDX-License-Identifier: GPL-3.0-only
// Synthetic frame bindings only; this test never starts OpenCode or a model.
'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {syntheticResult} = require('./real_opencode_provider_errors.cjs');
const {caps, input} = require('./conversation-fixture.cjs');
const {validateResult} = require('../src/private-conversation.cjs');
const MODEL = 'qwen3-0.6b-v1';
const negotiated = {...caps(MODEL), generation_policy_version: 1, generation_policies: ['greedy_v1'],
  execution_error_version: 1};

test('native error fixture does not invent policy from negotiated support', () => {
  const conversation = input();
  for (const reason of ['invalid_output', 'wire_truncated']) {
    const response = syntheticResult({type: 'incomplete', reason}, conversation);
    assert.equal(Object.hasOwn(response, 'generation_policy'), false);
    assert.equal(validateResult(response, negotiated, conversation), response);
    assert.throws(() => validateResult({...response, generation_policy: 'greedy_v1'}, negotiated, conversation),
      {code: 'invalid_conversation'});
  }
});

test('native error fixture retains the exact explicitly selected greedy policy', () => {
  const conversation = {...input(), generation_policy: 'greedy_v1'};
  for (const reason of ['invalid_output', 'wire_truncated']) {
    const response = syntheticResult({type: 'incomplete', reason}, conversation);
    assert.equal(response.generation_policy, 'greedy_v1');
    assert.equal(validateResult(response, negotiated, conversation), response);
    const {generation_policy: removed, ...missing} = response;
    assert.equal(removed, 'greedy_v1');
    assert.throws(() => validateResult(missing, negotiated, conversation), {code: 'generation_policy_mismatch'});
  }
  assert.throws(() => syntheticResult({type: 'assistant', text: 'synthetic'},
    {...conversation, generation_policy: 'unknown'}));
});
