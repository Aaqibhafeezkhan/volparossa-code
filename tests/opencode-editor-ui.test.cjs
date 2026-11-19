// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {CHECK, decision} = require('../scripts/opencode_editor_ui.cjs');
const project = '/home/vpci/opencode-projects/ui/project';
const scope = 'This permits only this request, not future actions or wider access.';
const one = (title, action) => `${title} once in /workspace?\n\n${action}\n\n${scope}`;

test('rendered approvals bind the original fixture and bounded commands', () => {
  assert.equal(decision(one('Apply this edit','Edit fixture.py'),project,0), 'edit');
  assert.equal(decision(one('Run this command','python3 -B -m unittest -v test_fixture.py'),project,1), 'test');
  assert.equal(decision(one('Apply this edit','Edit test_fixture.py'),project,1), null);
  assert.equal(decision(one('Run this command','python3 other.py'),project,1), null);
  assert.equal(decision(one('Run this command','cat fixture.py'),project,12), null);
});

test('the independent owner check may run once per bounded round for this folder', () => {
  const detail = 'Read-only workspace sandbox, no network or core credentials. A failed check may send its bounded output '
    + 'to the same local model session for another attempt. This does not authorize future checks or tools.';
  const prompt = `Run owner-selected check 2/4 once in ${project}?\n\n${JSON.stringify(CHECK)}\n\n${detail}`;
  assert.equal(decision(prompt,project,2),'check');
  assert.equal(decision(prompt,project+'-other',2),null);
  assert.equal(decision(prompt.replace('2/4','5/4'),project,2),null);
  assert.equal(decision(prompt.replace('-B','-i'),project,2),null);
});
