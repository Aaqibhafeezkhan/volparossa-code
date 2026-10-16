// SPDX-License-Identifier: GPL-3.0-only
// Same-owner private-serve v1 only. No HTTP, peer, public-cache or cloud fallback.
'use strict';

const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const REQUEST_LIMIT = 32768;
const RESPONSE_LIMIT = 65536;
const PROFILES = Object.freeze({
  'smollm2-135m-v1': { tokens: 64, bytes: 1024 },
  'smollm2-360m-v1': { tokens: 256, bytes: 4096 },
  'smollm2-1.7b-v1': { tokens: 256, bytes: 4096 },
});
const REMOTE_ERRORS = new Set([
  'invalid_request', 'handshake_required', 'busy', 'no_such_task',
  'cancelled', 'execution_failed', 'cleanup_unconfirmed',
]);
// Local, per-rejection provenance, never a peer/model-supplied flag. A checked
// terminal failure can confirm cleanup without being a successful execution.
const cleanedFailures = new WeakSet();
function terminalCleanupConfirmed(error) { return object(error) && cleanedFailures.has(error); }

function failure(code) {
  const error = new Error(`private_compute_${code}`);
  error.code = code;
  if (code === 'cancelled') error.name = 'AbortError';
  return error;
}

function requireValue(condition, code = 'invalid_response') {
  if (!condition) throw failure(code);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keys(value, required, optional = []) {
  requireValue(object(value));
  requireValue(required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

function utf8(value, maximum, nonblank = false) {
  requireValue(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maximum &&
    Buffer.from(value, 'utf8').toString('utf8') === value && !value.includes('\0') &&
    (!nonblank || value.trim().length > 0), 'invalid_text');
}

function capabilities(value) {
  const exact = {
    visibility: 'private_local', local_only: true, max_question_bytes: 512,
    max_context_bytes: 4096, max_request_bytes: REQUEST_LIMIT,
    max_response_bytes: RESPONSE_LIMIT, execution_slots: 1, max_connections: 8,
    network_access: false, public_cache: false, training: false,
    cloud_fallback: false, model_execution_proven: false,
  };
  keys(value, [...Object.keys(exact), 'model_profile', 'max_seconds', 'quarantined']);
  requireValue(Object.entries(exact).every(([key, expected]) => value[key] === expected) &&
    Object.hasOwn(PROFILES, value.model_profile) && Number.isInteger(value.max_seconds) &&
    value.max_seconds >= 1 && value.max_seconds <= 600 && typeof value.quarantined === 'boolean',
  'incompatible_capabilities');
  return Object.freeze(value);
}

function result(value, model) {
  keys(value, ['version', 'operation', 'model_profile', 'execution_complete', 'answer_complete',
    'complete', 'answer_status', 'output', 'local_only', 'private_data_supported',
    'distributed_execution_claimed', 'private_training_claimed', 'semantic_completeness_proven',
    'model_answer_correctness_proven', 'cleanup']);
  keys(value.cleanup, ['complete', 'retained_input', 'retained_report']);
  requireValue(value.cleanup.complete === true && value.cleanup.retained_input === false &&
    value.cleanup.retained_report === false, 'cleanup_unconfirmed');
  requireValue(value.version === 1 && value.operation === 'compute_private_task' &&
    value.model_profile === model && value.execution_complete === true && value.local_only === true &&
    value.private_data_supported === true && value.distributed_execution_claimed === false &&
    value.private_training_claimed === false && value.semantic_completeness_proven === false &&
    value.model_answer_correctness_proven === false);
  const output = value.output;
  keys(output, ['sample_index', 'text', 'generated_tokens', 'text_truncated', 'generation']);
  utf8(output.text, PROFILES[model].bytes);
  requireValue(output.sample_index === 0 && typeof output.text_truncated === 'boolean' &&
    Number.isInteger(output.generated_tokens) && output.generated_tokens >= 1 &&
    output.generated_tokens <= PROFILES[model].tokens);
  const generation = output.generation;
  keys(generation, ['version', 'stop_reason', 'max_new_tokens'], ['model_profile']);
  requireValue(generation.version === 1 && generation.max_new_tokens === PROFILES[model].tokens &&
    (generation.model_profile ?? 'smollm2-135m-v1') === model &&
    ['eos', 'token_limit'].includes(generation.stop_reason) &&
    (generation.stop_reason !== 'token_limit' || output.generated_tokens === generation.max_new_tokens));
  const status = output.text_truncated ? 'wire_truncated' :
    generation.stop_reason !== 'eos' ? 'token_limit' : output.text.trim() ? 'eos' : 'empty';
  requireValue(value.answer_status === status && value.answer_complete === (status === 'eos') &&
    value.complete === value.answer_complete);
  // Return the full original result, including incomplete-answer and cleanup fields.
  // No generated text is interpreted as a command or proof of answer correctness.
  return value;
}

async function socketIdentity(socketPath) {
  requireValue(typeof process.geteuid === 'function', 'unsupported_platform');
  const parent = path.dirname(socketPath);
  const [canonical, socket, directory] = await Promise.all([
    fs.realpath(socketPath), fs.lstat(socketPath), fs.lstat(parent),
  ]);
  const uid = process.geteuid();
  requireValue(canonical === socketPath && socket.isSocket() && !socket.isSymbolicLink() &&
    socket.uid === uid && (socket.mode & 0o7777) === 0o600 && directory.isDirectory() &&
    !directory.isSymbolicLink() && directory.uid === uid && (directory.mode & 0o7777) === 0o700,
  'socket_ownership');
  return [socket.dev, socket.ino, directory.dev, directory.ino].join(':');
}

class PrivateCompute {
  constructor(socketPath) {
    requireValue(typeof socketPath === 'string' && path.isAbsolute(socketPath) &&
      path.normalize(socketPath) === socketPath && !socketPath.includes('\0') &&
      Buffer.byteLength(socketPath) <= 107, 'invalid_socket_path');
    this.socketPath = socketPath;
    this.socket = null;
    this.state = 'new';
    this.caps = null;
    this.pending = null;
    this.handshake = null;
    this.cancels = new Map();
    this.ids = new Set();
    this.frame = null;
    this.frameTimer = null;
    this.connectPromise = null;
  }

  connect() {
    if (this.state === 'open') return Promise.resolve(this.caps);
    if (this.state === 'closed') return Promise.reject(failure('closed'));
    if (this.connectPromise) return this.connectPromise;
    if (this.state !== 'new') return Promise.reject(failure('closed'));
    this.state = 'connecting';
    this.connectPromise = this._connect();
    return this.connectPromise;
  }

  async _connect() {
    let identity;
    try {
      identity = await socketIdentity(this.socketPath);
    } catch (error) {
      this._fail(error.code === 'socket_ownership' ? error : failure('socket_unavailable'));
      throw this.lastError;
    }
    requireValue(this.state === 'connecting', 'closed');
    return new Promise((resolve, reject) => {
      this.handshake = { resolve, reject, id: null, timer: setTimeout(() => {
        this._fail(failure('handshake_timeout'));
      }, 5000) };
      this.socket = net.createConnection({ path: this.socketPath });
      this.socket.on('error', () => this._fail(failure('socket_error')));
      this.socket.on('close', () => this._fail(failure('disconnected')));
      this.socket.on('data', bytes => this._read(bytes));
      this.socket.once('connect', async () => {
        try {
          // Node has no portable SO_PEERCRED getter. Verify the owned pathname
          // before/after connect; the core also checks our UID. This is not
          // isolation from a malicious process already running as the same user.
          requireValue(await socketIdentity(this.socketPath) === identity, 'socket_changed');
          if (this.state !== 'connecting') return;
          const id = this._id();
          this.handshake.id = id;
          this._send(id, { type: 'capabilities' });
        } catch (error) {
          this._fail(error.code && error.message?.startsWith('private_compute_') ?
            error : failure('socket_unavailable'));
        }
      });
    });
  }

  async ask(input) {
    keys(input, ['question', 'context'], ['signal']);
    const { question, context, signal } = input;
    utf8(question, 512, true);
    utf8(context, 4096, true);
    requireValue(signal === undefined || (signal !== null && typeof signal.aborted === 'boolean' &&
      typeof signal.addEventListener === 'function' &&
      typeof signal.removeEventListener === 'function'), 'invalid_signal');
    requireValue(this.state === 'open', 'not_connected');
    requireValue(!this.caps.quarantined, 'cleanup_unconfirmed');
    requireValue(!this.pending, 'busy');
    if (signal?.aborted) throw failure('cancelled');
    const id = this._id();
    return new Promise((resolve, reject) => {
      const abort = () => this._cancel();
      this.pending = { id, resolve, reject, signal, abort, admitted: false, cancelled: false,
        timer: setTimeout(() => this._cancel(), this.caps.max_seconds * 1000 + 5000) };
      signal?.addEventListener('abort', abort, { once: true });
      this._send(id, { type: 'submit', question, context });
      if (signal?.aborted) abort();
    });
  }

  _id() {
    requireValue(this.ids.size < 256, 'connection_request_limit');
    let id;
    do { id = randomBytes(16).toString('hex'); } while (this.ids.has(id));
    this.ids.add(id);
    return id;
  }

  _send(id, operation) {
    try {
      const body = Buffer.from(JSON.stringify({ version: 1, id, operation }), 'utf8');
      requireValue(body.length > 0 && body.length <= REQUEST_LIMIT, 'request_bound');
      requireValue(this.socket && !this.socket.destroyed, 'disconnected');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    } catch (error) {
      this._fail(error.message?.startsWith('private_compute_') ? error : failure('socket_error'));
    }
  }

  _cancel() {
    const pending = this.pending;
    if (!pending || pending.cancelled) return;
    pending.cancelled = true;
    clearTimeout(pending.timer);
    // A cancellation acknowledgement is not cleanup. Await the terminal submit
    // response; if it never arrives, report uncertainty instead of success.
    pending.timer = setTimeout(() => this._fail(failure('cleanup_unconfirmed')), 15000);
    try {
      const id = this._id();
      this.cancels.set(id, pending.id);
      this._send(id, { type: 'cancel', task_id: pending.id });
    } catch (error) {
      this._fail(error);
    }
  }

  _read(bytes) {
    try {
      let offset = 0;
      while (offset < bytes.length && this.state !== 'closed') {
        if (!this.frame) {
          this.frame = { header: Buffer.alloc(4), headerBytes: 0, body: null, bodyBytes: 0 };
          this.frameTimer = setTimeout(() => this._fail(failure('frame_timeout')), 5000);
        }
        const frame = this.frame;
        if (frame.headerBytes < 4) {
          const count = Math.min(4 - frame.headerBytes, bytes.length - offset);
          bytes.copy(frame.header, frame.headerBytes, offset, offset + count);
          frame.headerBytes += count;
          offset += count;
          if (frame.headerBytes < 4) continue;
          const length = frame.header.readUInt32BE();
          requireValue(length > 0 && length <= RESPONSE_LIMIT, 'response_bound');
          frame.body = Buffer.alloc(length);
        }
        const count = Math.min(frame.body.length - frame.bodyBytes, bytes.length - offset);
        bytes.copy(frame.body, frame.bodyBytes, offset, offset + count);
        frame.bodyBytes += count;
        offset += count;
        if (frame.bodyBytes === frame.body.length) {
          clearTimeout(this.frameTimer);
          this.frameTimer = null;
          this.frame = null;
          const text = new TextDecoder('utf-8', { fatal: true }).decode(frame.body);
          this._response(JSON.parse(text));
        }
      }
    } catch (error) {
      this._fail(error.message?.startsWith('private_compute_') ? error : failure('invalid_response'));
    }
  }

  // Only the negotiated conversation subclass can recognize this additive code.
  // Q&A and legacy conversations retain their original closed error vocabulary.
  _allowsExecutionBudgetError(_message) { return false; }

  _response(message) {
    requireValue(object(message) && message.version === 1 && typeof message.event === 'string');
    requireValue((typeof message.id === 'string' && /^[0-9a-f]{32}$/.test(message.id)) ||
      (message.id === null && message.event === 'error' && message.code === 'invalid_request'));
    if (message.event === 'error') {
      keys(message, ['version', 'id', 'event', 'code']);
      const budgetError = message.code === 'execution_budget_exceeded' && this._allowsExecutionBudgetError(message);
      requireValue(REMOTE_ERRORS.has(message.code) || budgetError);
      const error = failure(message.code);
      if (message.id === null) throw error;
      requireValue(message.id === this.handshake?.id || message.id === this.pending?.id ||
        this.cancels.has(message.id));
      if (message.code === 'cleanup_unconfirmed') throw error;
      if (message.id === this.handshake?.id) throw error;
      if (this.cancels.has(message.id)) {
        requireValue(message.code === 'no_such_task');
        this.cancels.delete(message.id);
        return;
      }
      requireValue(message.id === this.pending?.id);
      // private-serve v1 emits these only after the admitted execution returns
      // through cleanup. Uncertainty takes precedence as cleanup_unconfirmed.
      // Do not infer this receipt from an error code before admission or from a
      // transport failure that merely has the same message.
      if (this.pending.admitted && (['execution_failed', 'cancelled'].includes(message.code) || budgetError)) {
        cleanedFailures.add(error);
      }
      this._settle(error);
      return;
    }
    if (message.event === 'capabilities') {
      keys(message, ['version', 'id', 'event', 'capabilities']);
      requireValue(this.state === 'connecting' && this.handshake?.id === message.id);
      this.caps = capabilities(message.capabilities);
      this.state = 'open';
      clearTimeout(this.handshake.timer);
      this.handshake.resolve(this.caps);
      this.handshake = null;
      return;
    }
    if (message.event === 'cancel_requested') {
      keys(message, ['version', 'id', 'event', 'task_id']);
      requireValue(this.cancels.has(message.id) && this.cancels.get(message.id) === message.task_id);
      this.cancels.delete(message.id);
      return;
    }
    requireValue(this.pending && message.id === this.pending.id);
    if (message.event === 'admitted') {
      keys(message, ['version', 'id', 'event']);
      requireValue(!this.pending.admitted);
      this.pending.admitted = true;
      return;
    }
    requireValue(message.event === 'result' && this.pending.admitted);
    keys(message, ['version', 'id', 'event', 'result']);
    const answer = result(message.result, this.caps.model_profile);
    this._settle(this.pending.cancelled ? failure('cancelled') : null, answer);
  }

  _settle(error, answer) {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    // A local cancellation can win after a fully validated result has arrived.
    // Preserve the cancellation, but retain that exact result's cleanup receipt.
    if (error && answer !== undefined && pending.admitted) cleanedFailures.add(error);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abort);
    if (error) pending.reject(error);
    else pending.resolve(answer);
  }

  _fail(error) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.lastError = error;
    clearTimeout(this.frameTimer);
    this.frame = null;
    if (this.handshake) {
      clearTimeout(this.handshake.timer);
      this.handshake.reject(error);
      this.handshake = null;
    }
    this._settle(error);
    this.cancels.clear();
    this.socket?.destroy();
  }

  close() {
    // EOF invokes core cancellation/reaping. We cannot observe cleanup after
    // disconnect and therefore reject an active task without claiming cleanup.
    this._fail(failure('disconnected'));
  }
}

module.exports = { PrivateCompute, terminalCleanupConfirmed };
