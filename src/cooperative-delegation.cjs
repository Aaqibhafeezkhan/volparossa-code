// SPDX-License-Identifier: GPL-3.0-only
// Owner-side adapter for core a57fff5c compute/public_serve/WIRE.md v1.
// Keep this socket OUTSIDE the OpenCode/tool sandbox. The inner tool receives
// only an enrolled, single-use capability: never arbitrary text, paths or keys.
// Core owns all peer scheduling, signed receipts, policy/admission and cleanup.
// Public peer results are not confidential execution or portable attestations.
'use strict';
const {randomBytes, createHash} = require('node:crypto');
const {PrivateCompute} = require('./private-compute.cjs');
const {check, keys, text, object} = require('./private-conversation.cjs');

const snapshots = new WeakMap();
const codeResponses = new WeakMap();
const LICENSES = new Set(['GPL-3.0-only', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0']);
const ERRORS = new Set(['invalid_request', 'handshake_required', 'busy', 'no_such_task', 'cancelled',
  'execution_failed', 'cleanup_unconfirmed', 'deadline_exceeded', 'storage_bound', 'unsupported_operation']);
const id = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0+$/.test(value);
function error(code) {
  const value = Error(`cooperative_delegation_${code}`); value.code = code;
  if (code === 'cancelled') value.name = 'AbortError';
  return value;
}
function convert(cause) { return error(typeof cause?.code === 'string' ? cause.code : 'invalid_response'); }

/** Explicit owner declaration, not an automatic license/secret scanner.
 * Both the exact question and context are public. Private editor history is
 * never an input, nor can a model alter the enrolled bytes after consent. */
function createPublicSnapshot(value) {
  return publicSnapshot(value, 'submit');
}
function createPublicCodeSnapshot(value) {
  return publicSnapshot(value, 'public_code_proposal');
}
function publicSnapshot(value, operation) {
  try {
    keys(value, ['question', 'context', 'license', 'public_content', 'rights_confirmed']);
    text(value.question, 512); text(value.context, 4096);
    check(value.public_content === true && value.rights_confirmed === true, 'public_consent_required');
    check(LICENSES.has(value.license), 'invalid_license');
    const token = Object.freeze({visibility: 'public_cooperative', id: randomBytes(16).toString('hex')});
    snapshots.set(token, {input: Object.freeze({...value}), operation, used: false});
    return token;
  } catch (cause) { throw convert(cause); }
}

function capabilities(value) {
  const exact = {visibility: 'public_cooperative', network_access: true, private_data_supported: false,
    public_cache: true, training: false, cloud_fallback: false, retained_public_receipts: true,
    remote_erasure_guaranteed: false, model_execution_proven: false,
    max_question_bytes: 512, max_context_bytes: 4096, max_request_bytes: 32768, max_response_bytes: 65536,
    execution_slots: 1, max_connections: 8, max_retained_tasks: 32, retained_bytes_admission_limit: 268435456};
  const code = value.code_proposal_v6 === true;
  keys(value, [...Object.keys(exact), 'model_profile', 'max_seconds', 'max_task_seconds', 'quarantined',
    ...(code ? ['code_proposal_v6', 'output_contract'] : [])], code ? [] : ['code_proposal_v6']);
  check(!Object.hasOwn(value, 'code_proposal_v6') || typeof value.code_proposal_v6 === 'boolean', 'incompatible_capabilities');
  check(Object.entries(exact).every(([key, expected]) => value[key] === expected)
    && typeof value.model_profile === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.model_profile)
    && Number.isInteger(value.max_seconds) && value.max_seconds >= 1 && value.max_seconds <= 600
    && Number.isInteger(value.max_task_seconds) && value.max_task_seconds >= 1 && value.max_task_seconds <= 7200
    && typeof value.quarantined === 'boolean', 'incompatible_capabilities');
  check(!code || value.output_contract === 'single_file_replacement_v1'
    && ['qwen3-0.6b-v1', 'qwen3-4b-instruct-2507-v1'].includes(value.model_profile), 'incompatible_capabilities');
  return Object.freeze(value);
}

function result(value) {
  keys(value, ['answer_complete', 'answer_status', 'output', 'provider_keys', 'selected_provider_keys',
    'joining', 'execution_complete', 'package_count', 'total_parts', 'synthesis_levels', 'source_manifest_id',
    'remote_cleanup_confirmed', 'cleanup', 'retained_public_receipts', 'model_answer_correctness_proven',
    'semantic_completeness_proven']);
  keys(value.cleanup, ['complete']); keys(value.output, ['text']);
  check(value.cleanup.complete === true && value.remote_cleanup_confirmed === true, 'cleanup_unconfirmed');
  text(value.output.text, 65536, false);
  const providers = values => Array.isArray(values) && values.length <= 4 && values.every(hex)
    && new Set(values).size === values.length;
  check(value.retained_public_receipts === true && value.model_answer_correctness_proven === false
    && value.semantic_completeness_proven === false && typeof value.answer_complete === 'boolean'
    && typeof value.execution_complete === 'boolean' && ['complete', 'incomplete'].includes(value.answer_status)
    && value.answer_complete === (value.answer_status === 'complete')
    && providers(value.provider_keys) && providers(value.selected_provider_keys)
    && value.selected_provider_keys.length >= 2
    && value.provider_keys.every(key => value.selected_provider_keys.includes(key))
    && ['single_source_answer', 'hierarchical_peer_synthesis', 'hierarchical_peer_synthesis_incomplete',
      'awaiting_fragments_before_peer_synthesis', 'incomplete_fragment_answers',
      'ordered_source_ranges_not_neural_synthesis'].includes(value.joining)
    && Number.isSafeInteger(value.package_count) && value.package_count >= 1
    && Number.isSafeInteger(value.total_parts) && value.total_parts >= 1
    && Number.isInteger(value.synthesis_levels) && value.synthesis_levels >= 0 && value.synthesis_levels <= 16
    && hex(value.source_manifest_id));
  check(!value.answer_complete || value.execution_complete && value.output.text.trim()
    && value.provider_keys.length > 0 && ['single_source_answer', 'hierarchical_peer_synthesis'].includes(value.joining));
  // Do not reconstruct, summarize, claim correctness or synthesize provenance.
  // Signed original receipts remain in core; this is its unchanged compact result.
  return value;
}

// Reuse only same-owner/path checks, bounded framing, IDs and cancellation from
// the existing Unix transport. Private capabilities/results can NEVER pass here.
class PublicTransport extends PrivateCompute {
  ask() { return Promise.reject(error('public_snapshot_required')); }
  submit(input, signal, operation = 'submit') {
    check(this.state === 'open', 'not_connected'); check(!this.pending, 'busy');
    check(!this.caps.quarantined, 'cleanup_unconfirmed');
    if (signal?.aborted) return Promise.reject(error('cancelled'));
    const requestId = this._id(); this.cleanupConfirmed = false;
    return new Promise((resolve, reject) => {
      const abort = () => this._cancel();
      this.pending = {id: requestId, resolve, reject, signal, abort, admitted: false, cancelled: false, operation, input,
        timer: setTimeout(() => this._cancel(), (this.caps.max_task_seconds + 15) * 1000)};
      signal?.addEventListener('abort', abort, {once: true});
      this._send(requestId, {type: operation, ...input});
      if (signal?.aborted) abort();
    });
  }
  _response(message) {
    check(object(message) && message.version === 1 && typeof message.event === 'string'
      && (id(message.id) || message.id === null && message.event === 'error' && message.code === 'invalid_request'));
    if (message.event === 'capabilities') {
      keys(message, ['version', 'id', 'event', 'capabilities']);
      check(this.state === 'connecting' && message.id === this.handshake?.id);
      this.caps = capabilities(message.capabilities); this.state = 'open';
      clearTimeout(this.handshake.timer); this.handshake.resolve(this.caps); this.handshake = null; return;
    }
    if (message.event === 'error') {
      keys(message, ['version', 'id', 'event', 'code']); check(ERRORS.has(message.code));
      if (message.id === null || message.code === 'cleanup_unconfirmed' || message.id === this.handshake?.id) {
        throw error(message.code);
      }
      if (this.cancels.has(message.id)) {
        check(message.code === 'no_such_task'); this.cancels.delete(message.id); return;
      }
      check(message.id === this.pending?.id);
      check(!['cancelled', 'deadline_exceeded', 'execution_failed'].includes(message.code) || this.pending.admitted);
      this.cleanupConfirmed = true; this._settle(error(message.code)); return;
    }
    if (message.event === 'cancel_requested') {
      keys(message, ['version', 'id', 'event', 'task_id']);
      check(this.cancels.get(message.id) === message.task_id && this.cancels.has(message.id));
      this.cancels.delete(message.id); return;
    }
    check(this.pending && this.pending.id === message.id);
    if (message.event === 'admitted') {
      keys(message, ['version', 'id', 'event']); check(!this.pending.admitted);
      this.pending.admitted = true; return;
    }
    keys(message, ['version', 'id', 'event', 'result']); check(message.event === 'result' && this.pending.admitted);
    const original = this.pending.operation === 'public_code_proposal'
      ? require('./public-code-result.cjs').validateCodeResult(message.result, this.pending.input, this.caps)
      : result(message.result);
    const answer = {core_task_id: message.id, result: original};
    this.cleanupConfirmed = true;
    this._settle(this.pending.cancelled ? error('cancelled') : null, answer);
  }
  _fail(cause) {
    if (this.pending) {
      this.cleanupConfirmed = false;
      super._fail(error('cleanup_unconfirmed'));
    } else super._fail(cause);
  }
}

class CooperativeDelegation {
  #transport; #active = null; #closing = null; #closed = false;
  constructor(socketPath) { this.#transport = new PublicTransport(socketPath); }
  async connect() {
    if (this.#closed) throw error('closed');
    try { return await this.#transport.connect(); } catch (cause) { throw convert(cause); }
  }
  async execute(value) {
    try {
      keys(value, ['tool_call_id', 'snapshot'], ['signal']);
      check(typeof value.tool_call_id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.tool_call_id), 'tool_call_id');
      check(value.signal === undefined || value.signal instanceof AbortSignal, 'invalid_signal');
      check(!this.#closed && this.#transport.state === 'open', 'not_connected');
      check(!this.#active, 'busy');
      const snapshot = snapshots.get(value.snapshot);
      check(snapshot && !snapshot.used, 'public_snapshot_required');
      check((snapshot.operation === 'public_code_proposal') === (this.#transport.caps.code_proposal_v6 === true),
        'incompatible_capabilities');
      check(!this.#transport.caps.quarantined, 'cleanup_unconfirmed');
      if (value.signal?.aborted) throw error('cancelled');
      snapshot.used = true;
      const pending = this.#transport.submit(snapshot.input, value.signal, snapshot.operation);
      this.#active = pending;
      try {
        const answer = await pending;
        const response = {tool_call_id: value.tool_call_id, core_task_id: answer.core_task_id,
          visibility: 'public_cooperative', result: answer.result};
        if (snapshot.operation === 'public_code_proposal') {
          codeResponses.set(response, {snapshot: value.snapshot, proposal: Object.freeze({
            sourceSha256: createHash('sha256').update(snapshot.input.context).digest('hex'),
            text: answer.result.outputs[0].text, complete: answer.result.proposal_complete,
            coreTaskId: answer.core_task_id, toolCallId: value.tool_call_id,
            peerJobId: answer.result.receipt.handle.binding.job_id,
            peerReportSha256: answer.result.receipt.status.report_sha256})});
        }
        return response;
      } finally { this.#active = null; }
    } catch (cause) { throw convert(cause); }
  }
  close() {
    this.#closing ??= (async () => {
      this.#closed = true;
      if (this.#active) {
        this.#transport._cancel();
        await this.#active.catch(() => {});
      }
      this.#transport.close();
      // Preserve a previously observed uncertain terminal state even when the
      // execute promise settled before its owner called close().
      if (this.#transport.cleanupConfirmed === false) throw error('cleanup_unconfirmed');
    })();
    return this.#closing;
  }
}

function validatedCodeProposal(snapshot, response) {
  const entry = codeResponses.get(response);
  check(entry && entry.snapshot === snapshot, 'public_snapshot_required');
  // Immutable copy captured during validation, never mutable tool/model output.
  return entry.proposal;
}
module.exports = {CooperativeDelegation, createPublicSnapshot, createPublicCodeSnapshot, validatedCodeProposal};
