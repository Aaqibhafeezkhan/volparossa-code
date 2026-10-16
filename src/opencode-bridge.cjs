// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const {TextDecoder} = require('node:util');
const LIMIT = 524288;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Closed lifecycle facts only. Never copy an exception message, model text,
// tool arguments, session ID or path into a diagnostic frame.
const FAILURE_CODES = new Set([
  'task_or_runtime_failed', 'runtime_failed', 'cancelled_or_deadline',
  ...['scope', 'event_bound', 'event', 'connection', 'session_bound', 'permission_schema',
    'permission_replay', 'permission_bound', 'permission_unconfirmed', 'native_error',
    'tool_schema', 'tool_bound', 'abort_unconfirmed', 'cancelled', 'session_scope',
    'incomplete', 'output_bound', 'result_scope', 'cleanup_unconfirmed',
    'verification_scope', 'verification_cleanup_unconfirmed'].map(code => `opencode_task_${code}`),
  ...['unavailable', 'request', 'bound', 'transport', 'rejected', 'response', 'timeout',
    'cancelled', 'connection', 'version', 'event_timeout', 'event_schema', 'event_connection',
    'event_disposed', 'event_response', 'event_bound', 'event_invalid', 'event_closed',
    'event_transport', 'session', 'model', 'prompt'].map(code => `opencode_${code}`),
]);
const PROVIDER_ERRORS = Object.freeze(['execution_failed', 'execution_budget_exceeded', 'invalid_model_output', 'tool_choice_not_met',
  'invalid_conversation', 'request_bound', 'busy', 'cancelled', 'cleanup_unconfirmed',
  'socket_unavailable', 'socket_error', 'disconnected', 'invalid_response',
  'incompatible_capabilities', 'provider_failed', 'other']);
const isFailureCode = code => FAILURE_CODES.has(code);
const VERIFICATION_STATUSES = Object.freeze(['passed', 'failed', 'unavailable']);
function validVerification(value) {
  return record(value) && Object.keys(value).length === 2 && VERIFICATION_STATUSES.includes(value.status) &&
    typeof value.feedback === 'string' && !value.feedback.includes('\0') && Buffer.byteLength(value.feedback) <= 8192 &&
    (value.status !== 'failed' || value.feedback.trim().length > 0);
}
function validVerificationSummary(value) {
  return record(value) && Object.keys(value).length === 3 && VERIFICATION_STATUSES.includes(value.status) &&
    Number.isSafeInteger(value.checks) && value.checks >= 1 && value.checks <= 16 &&
    Number.isSafeInteger(value.continuations) && value.continuations >= 0 && value.continuations < value.checks;
}
function taskFailure(error) {
  if (isFailureCode(error?.code)) return error.code;
  return isFailureCode(error?.message) ? error.message : 'task_or_runtime_failed';
}
function emptyProviderDiagnostic() {
  return {version: 1, submitted: 0, completed: 0, incomplete: 0, cleanup_confirmed: 0,
    results: {assistant: 0, function_call: 0, incomplete: 0},
    incomplete_reasons: {token_limit: 0, wire_truncated: 0, invalid_output: 0},
    request_errors: Object.fromEntries(PROVIDER_ERRORS.map(code => [code, 0])), truncated: false};
}
const TASK_TOOLS = Object.freeze(['read', 'glob', 'grep', 'list', 'bash', 'edit', 'write',
  'apply_patch', 'multiedit', 'task', 'volparossa_delegate_public', 'invalid', 'other']);
const TOOL_STATES = Object.freeze(['pending', 'running', 'completed', 'error']);
function emptyTaskDiagnostic() {
  return {version: 1, observed_calls: 0,
    tools: Object.fromEntries(TASK_TOOLS.map(tool => [tool,
      Object.fromEntries(TOOL_STATES.map(state => [state, 0]))])),
    permissions: {requested: 0, forwarded: 0, accepted: 0, rejected: 0, unconfirmed: 0},
    truncated: false};
}
function validTaskDiagnostic(value) {
  const matches = (actual, expected) => record(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => Object.hasOwn(actual, key) && (record(item)
      ? matches(actual[key], item) : typeof item === 'number'
        ? Number.isSafeInteger(actual[key]) && actual[key] >= 0 && actual[key] <= 65535
        : typeof actual[key] === typeof item));
  return value === null || matches(value, emptyTaskDiagnostic()) && value.version === 1;
}
function validProviderDiagnostic(value) {
  const template = emptyProviderDiagnostic();
  // Historical v1 receipts predate the negotiated budget code. Accept either
  // exact closed schema; never fabricate the missing counter or relax extras.
  if (record(value?.request_errors) && !Object.hasOwn(value.request_errors, 'execution_budget_exceeded')) {
    delete template.request_errors.execution_budget_exceeded;
  }
  const matches = (actual, expected) => record(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, item]) => Object.hasOwn(actual, key) && (record(item)
      ? matches(actual[key], item) : typeof item === 'number'
        ? Number.isSafeInteger(actual[key]) && actual[key] >= 0 && actual[key] <= 65535
        : typeof actual[key] === typeof item));
  return value === null || matches(value, template) && value.version === 1;
}
function writeFrame(stream, value) {
  const encoded = Buffer.from(JSON.stringify(value) + '\n');
  if (encoded.length > LIMIT || stream.destroyed || stream.writableEnded ||
      !Number.isSafeInteger(stream.writableLength) || stream.writableLength + encoded.length > LIMIT) {
    throw Error('opencode_bridge_closed');
  }
  stream.write(encoded);
}
function readFrames(stream, receive, fail) {
  let pending = Buffer.alloc(0), failed = false;
  const bad = () => { if (!failed) { failed = true; fail(); } };
  const data = chunk => {
    if (failed) return;
    try {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        if (pending.length + end - start >= LIMIT) throw Error('bound');
        const raw = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat([pending, chunk.subarray(start, end)]));
        start = end + 1; pending = Buffer.alloc(0);
        const value = JSON.parse(raw);
        if (!record(value) || typeof value.type !== 'string') throw Error('frame');
        receive(value);
        if (failed) return;
      }
      pending = Buffer.concat([pending, chunk.subarray(start)]);
      if (pending.length >= LIMIT) throw Error('bound');
    } catch { bad(); }
  };
  const end = () => { if (pending.length) bad(); };
  stream.on('data', data); stream.on('error', bad); stream.on('end', end);
  return () => { stream.off('data', data); stream.off('error', bad); stream.off('end', end); pending = Buffer.alloc(0); };
}
module.exports = {readFrames, writeFrame, record, isFailureCode, taskFailure,
  validVerification, validVerificationSummary,
  PROVIDER_ERRORS, emptyProviderDiagnostic, validProviderDiagnostic,
  TASK_TOOLS, TOOL_STATES, emptyTaskDiagnostic, validTaskDiagnostic};
