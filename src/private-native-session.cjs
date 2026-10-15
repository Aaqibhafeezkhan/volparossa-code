// SPDX-License-Identifier: GPL-3.0-only
'use strict';
// Same-owner, single-connection native model reuse. No session token, shared KV,
// reconnect replay or remote-confidential-execution claim.
const { PrivateConversation, capabilities, validateNativeSessionResult, check, keys, object, fail } =
  require('./private-conversation.cjs');

const SESSION_LIMITS = Object.freeze({version: 1, max_task_seconds: 2400,
  max_idle_seconds: 300, max_requests: 128});
function sessionCapabilities(value, outputConstraintVersion) {
  check(object(value), 'incompatible_capabilities');
  const {native_session_version, native_session, ...ordinary} = value;
  const caps = capabilities(ordinary, 1, 1, outputConstraintVersion);
  check(native_session_version === 1 && caps.model_profile === 'qwen3-4b-instruct-2507-v1' &&
    caps.inference_backend === 'llama_cpp_bf16_v1', 'incompatible_capabilities');
  keys(native_session, Object.keys(SESSION_LIMITS));
  check(Object.entries(SESSION_LIMITS).every(([key, expected]) => native_session[key] === expected),
    'incompatible_capabilities');
  return Object.freeze({...caps, native_session_version: 1,
    native_session: Object.freeze({...native_session})});
}
function closedCleanup(value) {
  keys(value, ['version', 'child_reaped', 'private_state_removed']);
  check(value.version === 1 && value.child_reaped === true && value.private_state_removed === true,
    'cleanup_unconfirmed');
}

class PrivateNativeSession extends PrivateConversation {
  constructor(socketPath, {outputConstraintVersion} = {}) {
    super(socketPath, {generationPolicyVersion: 1, executionErrorVersion: 1, outputConstraintVersion});
    this.sessionState = 'new';
    this.sessionControl = null;
    this.openId = null;
    this.sessionCleanupConfirmed = false;
    this.requests = 0;
    this.finishPromise = null;
  }
  _send(id, operation) {
    if (operation.type === 'capabilities') operation = {type: 'conversation_capabilities',
      generation_policy_version: 1, execution_error_version: 1, native_session_version: 1,
      ...(this.outputConstraintVersion === 1 ? {output_constraint_version: 1} : {})};
    super._send(id, operation);
  }
  async open() {
    const caps = await this.connect();
    check(this.sessionState === 'new' && !this.sessionControl, 'busy');
    check(!caps.quarantined, 'cleanup_unconfirmed');
    this.sessionState = 'opening';
    const id = this._id(); this.openId = id;
    await new Promise((resolve, reject) => {
      this.sessionControl = {id, resolve, reject, timer: setTimeout(() =>
        this._fail(fail('cleanup_unconfirmed')), 15000)};
      this._send(id, {type: 'open_native_session'});
    });
    return caps;
  }
  async submit(conversation, options) {
    check(this.sessionState === 'open', 'not_connected');
    check(this.requests < SESSION_LIMITS.max_requests, 'connection_request_limit');
    this.requests++;
    return super.submit(conversation, options);
  }
  _response(message) {
    check(object(message) && message.version === 1 &&
      typeof message.id === 'string' && /^[0-9a-f]{32}$/.test(message.id), 'invalid_response');
    if (message.event === 'conversation_capabilities') {
      keys(message, ['version', 'id', 'event', 'capabilities']);
      check(this.state === 'connecting' && message.id === this.handshake?.id, 'invalid_response');
      this.caps = sessionCapabilities(message.capabilities, this.outputConstraintVersion);
      this.state = 'open'; clearTimeout(this.handshake.timer);
      this.handshake.resolve(this.caps); this.handshake = null; return;
    }
    if (message.event === 'native_session_opened') {
      keys(message, ['version', 'id', 'event']);
      check(this.sessionState === 'opening' && message.id === this.sessionControl?.id, 'invalid_response');
      this.sessionState = 'open'; this._controlDone(); return;
    }
    if (message.event === 'native_session_closed') {
      keys(message, ['version', 'id', 'event', 'cleanup']);
      check(!this.pending && (this.sessionState === 'closing' && message.id === this.sessionControl?.id ||
        this.sessionState === 'open' && message.id === this.openId), 'invalid_response');
      closedCleanup(message.cleanup);
      this.sessionCleanupConfirmed = true; this.sessionState = 'closed';
      this._controlDone();
      // The checked receipt, not EOF or a cancellation acknowledgement, proves
      // cleanup. Keep that fact even if the socket closes immediately afterwards.
      this.close(); return;
    }
    if (message.event === 'result') {
      keys(message, ['version', 'id', 'event', 'result']);
      check(this.sessionState === 'open' && this.pending?.admitted && message.id === this.pending.id,
        'invalid_response');
      const result = validateNativeSessionResult(message.result, this.caps, this.pending.input);
      this._settle(this.pending.cancelled ? fail('cancelled') : null, result); return;
    }
    if (message.event === 'error' && this.sessionState !== 'new') {
      if (this.cancels.has(message.id) && message.code === 'no_such_task') {
        super._response(message); return;
      }
      if (this.sessionState === 'opening' && !Object.hasOwn(message, 'session_cleanup')) {
        keys(message, ['version', 'id', 'event', 'code']);
        check(message.id === this.sessionControl?.id &&
          ['invalid_request', 'handshake_required', 'busy'].includes(message.code), 'invalid_response');
        throw fail(message.code);
      }
      keys(message, ['version', 'id', 'event', 'code', 'session_cleanup']);
      const correlated = message.id === this.pending?.id || message.id === this.sessionControl?.id ||
        this.sessionState === 'open' && !this.pending && message.id === this.openId;
      check(correlated &&
        ['cancelled', 'execution_failed', 'execution_budget_exceeded', 'cleanup_unconfirmed'].includes(message.code),
      'invalid_response');
      if (message.session_cleanup === null || message.code === 'cleanup_unconfirmed') throw fail('cleanup_unconfirmed');
      closedCleanup(message.session_cleanup);
      this.sessionCleanupConfirmed = true; this.sessionState = 'closed';
      const error = fail(message.code);
      this._controlDone(error); this._settle(error); this.close(); return;
    }
    // Reuse framed transport, admitted and correlated cancel acknowledgements;
    // no legacy result is ever passed to its all-state-removed validator.
    super._response(message);
  }
  _settle(error, value) {
    // Unlike legacy results, a warm result cannot stamp terminal cleanup onto
    // an AbortError. Final cleanup is independently observable on this instance.
    const pending = this.pending; this.pending = null;
    if (!pending) return;
    clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  _controlDone(error) {
    const control = this.sessionControl; this.sessionControl = null;
    if (!control) return;
    clearTimeout(control.timer);
    if (error) control.reject(error); else control.resolve();
  }
  _fail(error) {
    this._controlDone(error);
    if (!this.sessionCleanupConfirmed) this.sessionState = 'failed';
    super._fail(error);
  }
  finish() {
    if (this.finishPromise) return this.finishPromise;
    this.finishPromise = (async () => {
      if (this.sessionCleanupConfirmed) return;
      check(this.sessionState === 'open' && this.state === 'open' && !this.pending, 'cleanup_unconfirmed');
      this.sessionState = 'closing';
      const id = this._id();
      await new Promise((resolve, reject) => {
        this.sessionControl = {id, resolve, reject, timer: setTimeout(() =>
          this._fail(fail('cleanup_unconfirmed')), 15000)};
        this._send(id, {type: 'close_native_session'});
      });
      check(this.sessionCleanupConfirmed, 'cleanup_unconfirmed');
    })();
    return this.finishPromise;
  }
}

module.exports = {PrivateNativeSession, sessionCapabilities, closedCleanup, SESSION_LIMITS};
