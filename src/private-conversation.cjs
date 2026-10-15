// SPDX-License-Identifier: GPL-3.0-only
// Additive conversation protocol. Reuse the unchanged Q&A framing/owner/cancel transport.
'use strict';

const { PrivateCompute } = require('./private-compute.cjs');

function fail(code) {
  const error = new Error(`private_compute_${code}`);
  error.code = code;
  if (code === 'cancelled') error.name = 'AbortError';
  return error;
}
function check(value, code = 'invalid_conversation') { if (!value) throw fail(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, required, optional = []) {
  check(object(value) && required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function text(value, maximum, nonempty = true) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= maximum &&
    Buffer.from(value).toString() === value && !value.includes('\0') && (!nonempty || value.trim()));
}
function identifier(value) { check(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)); }
function toolKey(value) {
  identifier(value.name);
  check(value.namespace == null || typeof value.namespace === 'string');
  if (value.namespace != null) identifier(value.namespace);
  return JSON.stringify([value.namespace ?? null, value.name]);
}
function payload(value) { check(object(value) && Buffer.byteLength(JSON.stringify(value)) <= 4096); }

const PROFILES = Object.freeze({
  'smollm2-135m-v1': [192, 64, 1024],
  'smollm2-360m-v1': [1024, 256, 4096],
  'smollm2-1.7b-v1': [1024, 256, 4096],
  'qwen3-0.6b-v1': [12288, 1024, 4096],
  'qwen3-4b-instruct-2507-v1': [12288, 1024, 4096],
});
const NATIVE_PROFILES = Object.freeze({
  'qwen3-0.6b-v1': {context: 32768, template: 'qwen3-tools-nonthinking-v1'},
  'qwen3-4b-instruct-2507-v1': {context: 262144, template: 'qwen3-tools-instruct-2507-v1'},
});
const nativeProfile = model => Object.hasOwn(NATIVE_PROFILES, model);
const OUTPUT_CONSTRAINT = 'qwen_tagged_tool_json_v1';
function expectedLimits(model) {
  check(Object.hasOwn(PROFILES, model), 'incompatible_capabilities');
  const [prompt, output, bytes] = PROFILES[model];
  const qwen = nativeProfile(model);
  return { version: 1, visibility: 'private_local', model_profile: model,
    max_input_bytes: 24576, max_history_items: 32, max_tools: 8,
    max_instructions_bytes: 4096, max_message_bytes: 8192, max_tool_description_bytes: 2048,
    max_tool_payload_bytes: 4096, max_prompt_tokens: prompt, max_new_tokens: output,
    model_context_tokens: 8192, max_output_bytes: bytes, conversation_template: 'smollm2-json-turn-v1',
    native_tool_template: false, local_only: true, tool_execution: false, network_access: false,
    public_cache: false, training: false, cloud_fallback: false, model_tool_use_proven: false,
    arbitrary_json_schema_validation: false,
    ...(qwen ? { max_input_bytes: 262144, max_instructions_bytes: 65536, max_history_items: 128,
      max_tools: 32, max_message_bytes: 65536, max_tool_description_bytes: 8192,
      model_context_tokens: NATIVE_PROFILES[model].context,
      conversation_template: NATIVE_PROFILES[model].template, native_tool_template: true } : {}) };
}
function requestLimit(model) { return nativeProfile(model) ? 524288 : 32768; }
function equalLimits(value, expected, optional = []) {
  keys(value, Object.keys(expected), optional);
  check(Object.entries(expected).every(([key, item]) => value[key] === item), 'incompatible_capabilities');
}
function capabilities(value, generationPolicyVersion, executionErrorVersion, outputConstraintVersion) {
  check(object(value));
  const generation = generationPolicyVersion === 1 ? ['generation_policy_version', 'generation_policies'] : [];
  const execution = executionErrorVersion === 1 ? ['execution_error_version'] : [];
  const constraint = outputConstraintVersion === 1 ? ['output_constraint_version', 'output_constraints'] : [];
  const backend = ['inference_backend', 'required_generation_policy'];
  equalLimits(value, { ...expectedLimits(value.model_profile), execution_slots: 1,
    max_request_bytes: requestLimit(value.model_profile), max_response_bytes: 65536 },
  ['max_seconds', 'quarantined', ...generation, ...execution, ...constraint, ...backend]);
  // The owner-selected core may expose this one backend restriction, not a
  // frontend executor choice or independent proof of the returned backend.
  if (backend.some(key => Object.hasOwn(value, key))) {
    check(backend.every(key => Object.hasOwn(value, key)) &&
      value.inference_backend === 'llama_cpp_bf16_v1' && value.required_generation_policy === 'greedy_v1' &&
      value.model_profile === 'qwen3-4b-instruct-2507-v1' && generationPolicyVersion === 1,
    'incompatible_capabilities');
  }
  check(Number.isInteger(value.max_seconds) && value.max_seconds >= 1 && value.max_seconds <= 600 &&
    typeof value.quarantined === 'boolean', 'incompatible_capabilities');
  if (generationPolicyVersion === 1) {
    const expected = nativeProfile(value.model_profile) ? ['greedy_v1'] : [];
    check(value.generation_policy_version === 1 && Array.isArray(value.generation_policies) &&
      JSON.stringify(value.generation_policies) === JSON.stringify(expected), 'unsupported_generation_policy');
    Object.freeze(value.generation_policies);
  }
  if (executionErrorVersion === 1) check(value.execution_error_version === 1, 'incompatible_capabilities');
  if (outputConstraintVersion === 1) {
    check(value.output_constraint_version === 1 && Array.isArray(value.output_constraints) &&
      (value.output_constraints.length === 0 || value.output_constraints.length === 1 &&
       value.output_constraints[0] === OUTPUT_CONSTRAINT &&
       value.model_profile === 'qwen3-4b-instruct-2507-v1' &&
       value.inference_backend === 'llama_cpp_bf16_v1'), 'unsupported_output_constraint');
    Object.freeze(value.output_constraints);
  }
  return Object.freeze(value);
}

function validateConversation(value, limits = expectedLimits('smollm2-360m-v1')) {
  keys(value, ['version', 'visibility', 'instructions', 'history', 'tools'], ['generation_policy', 'output_constraint']);
  check(value.version === 1 && value.visibility === 'private_local');
  if (Object.hasOwn(value, 'generation_policy')) {
    check(value.generation_policy === 'greedy_v1' && nativeProfile(limits.model_profile) &&
      limits.generation_policy_version === 1 && limits.generation_policies?.includes('greedy_v1'),
    'unsupported_generation_policy');
  }
  text(value.instructions, limits.max_instructions_bytes);
  check(Array.isArray(value.history) && value.history.length >= 1 && value.history.length <= limits.max_history_items &&
    Array.isArray(value.tools) && value.tools.length <= limits.max_tools);
  if (Object.hasOwn(value, 'output_constraint')) {
    check(value.output_constraint === OUTPUT_CONSTRAINT && value.generation_policy === 'greedy_v1' &&
      limits.model_profile === 'qwen3-4b-instruct-2507-v1' && limits.inference_backend === 'llama_cpp_bf16_v1' &&
      limits.output_constraint_version === 1 && limits.output_constraints?.includes(OUTPUT_CONSTRAINT) &&
      value.tools.length >= 1 && value.tools.length <= 32, 'unsupported_output_constraint');
  }
  const tools = new Map(), seen = new Map(), open = new Set();
  for (const tool of value.tools) {
    check(tool.type === 'function' || tool.type === 'custom');
    keys(tool, ['type', 'name', 'description', ...(tool.type === 'function' ? ['parameters'] : [])], ['namespace']);
    const key = toolKey(tool);
    check(!tools.has(key));
    tools.set(key, tool.type);
    text(tool.description, limits.max_tool_description_bytes);
    if (tool.type === 'function') { payload(tool.parameters); check(tool.parameters.type === 'object'); }
  }
  for (const item of value.history) {
    check(object(item));
    if (item.type === 'message') {
      keys(item, ['type', 'role', 'text']);
      const roles = nativeProfile(limits.model_profile) ? ['user', 'assistant', 'system', 'developer'] : ['user', 'assistant'];
      check(!open.size && roles.includes(item.role));
      text(item.text, limits.max_message_bytes);
    } else if (item.type === 'tool_result') {
      keys(item, ['type', 'call_id', 'output']);
      identifier(item.call_id);
      check(open.delete(item.call_id));
      text(item.output, limits.max_message_bytes, false);
    } else {
      validateCall(item, tools, seen);
      seen.set(item.call_id, item);
      open.add(item.call_id);
    }
  }
  const last = value.history.at(-1);
  check(!open.size && (last.type === 'tool_result' || last.type === 'message' && last.role === 'user'));
  check(Buffer.byteLength(JSON.stringify(value)) <= limits.max_input_bytes, 'request_bound');
  return { tools, seen };
}
function validateCall(item, tools, seen) {
  const custom = item.type === 'custom_tool_call';
  check(custom || item.type === 'function_call');
  keys(item, ['type', 'call_id', 'name', custom ? 'input' : 'arguments'], ['namespace']);
  identifier(item.call_id);
  check(!seen.has(item.call_id) && tools.get(toolKey(item)) === (custom ? 'custom' : 'function'));
  if (custom) text(item.input, 4096); else payload(item.arguments);
}
function validateResult(value, caps, input) {
  keys(value, ['version', 'operation', 'model_profile', 'execution_complete', 'turn_complete', 'output',
    'prompt_tokens', 'generated_tokens', 'limits', 'local_only', 'private_data_supported', 'tool_execution',
    'distributed_execution_claimed', 'private_training_claimed', 'model_answer_correctness_proven', 'cleanup'],
  [...(Object.hasOwn(input, 'generation_policy') ? ['generation_policy'] : []),
    ...(Object.hasOwn(input, 'output_constraint') ? ['output_constraint'] : [])]);
  if (Object.hasOwn(input, 'generation_policy')) {
    validateConversation(input, caps);
    check(value.generation_policy === input.generation_policy, 'generation_policy_mismatch');
  }
  if (Object.hasOwn(input, 'output_constraint')) {
    validateConversation(input, caps);
    check(value.output_constraint === input.output_constraint, 'output_constraint_mismatch');
  }
  keys(value.cleanup, ['complete', 'retained_input', 'retained_report']);
  check(value.cleanup.complete === true && value.cleanup.retained_input === false &&
    value.cleanup.retained_report === false, 'cleanup_unconfirmed');
  check(value.version === 1 && value.operation === 'compute_private_conversation' &&
    value.model_profile === caps.model_profile && value.execution_complete === true && value.local_only === true &&
    value.private_data_supported === true && value.tool_execution === false &&
    value.distributed_execution_claimed === false && value.private_training_claimed === false &&
    value.model_answer_correctness_proven === false);
  equalLimits(value.limits, expectedLimits(caps.model_profile));
  check(Number.isInteger(value.prompt_tokens) && value.prompt_tokens >= 1 && value.prompt_tokens <= caps.max_prompt_tokens &&
    Number.isInteger(value.generated_tokens) && value.generated_tokens >= 1 && value.generated_tokens <= caps.max_new_tokens);
  const output = value.output;
  check(object(output) && value.turn_complete === (output.type !== 'incomplete'));
  if (output.type === 'incomplete') {
    keys(output, ['type', 'reason']);
    check(['token_limit', 'wire_truncated', 'invalid_output'].includes(output.reason));
  } else if (output.type === 'assistant') {
    keys(output, ['type', 'text']);
    text(output.text, caps.max_output_bytes);
  } else {
    const { tools, seen } = validateConversation(input, caps);
    check(Object.hasOwn(output, 'namespace'));
    validateCall(output, tools, seen);
  }
  return value;
}

class PrivateConversation extends PrivateCompute {
  constructor(socketPath, { generationPolicyVersion, executionErrorVersion, outputConstraintVersion } = {}) {
    super(socketPath);
    check(generationPolicyVersion === undefined || generationPolicyVersion === 1, 'unsupported_generation_policy');
    this.generationPolicyVersion = generationPolicyVersion;
    check(executionErrorVersion === undefined || executionErrorVersion === 1, 'unsupported_execution_error_version');
    this.executionErrorVersion = executionErrorVersion;
    check(outputConstraintVersion === undefined || outputConstraintVersion === 1, 'unsupported_output_constraint_version');
    this.outputConstraintVersion = outputConstraintVersion;
  }
  // These hooks reuse only the already-tested transport. Q&A callers and bytes
  // remain unchanged; this instance cannot silently use the old handshake.
  _send(id, operation) {
    // The separate conversation family may advertise a larger request envelope;
    // the legacy Q&A class and its 32KiB framing remain byte-for-byte unchanged.
    if (operation.type === 'capabilities') operation = { type: 'conversation_capabilities',
      ...(this.generationPolicyVersion === 1 ? { generation_policy_version: 1 } : {}),
      ...(this.executionErrorVersion === 1 ? { execution_error_version: 1 } : {}),
      ...(this.outputConstraintVersion === 1 ? { output_constraint_version: 1 } : {}) };
    try {
      const body = Buffer.from(JSON.stringify({ version: 1, id, operation }));
      check(body.length > 0 && body.length <= (this.caps?.max_request_bytes ?? 32768), 'request_bound');
      check(this.socket && !this.socket.destroyed, 'disconnected');
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      this.socket.write(Buffer.concat([header, body]));
    } catch (error) { this._fail(error.message?.startsWith('private_compute_') ? error : fail('socket_error')); }
  }
  ask() { return Promise.reject(fail('conversation_required')); }
  async submit(conversation, { signal } = {}) {
    check(this.state === 'open', 'not_connected');
    validateConversation(conversation, this.caps);
    check(signal === undefined || signal instanceof AbortSignal, 'invalid_signal');
    check(!this.caps.quarantined, 'cleanup_unconfirmed');
    check(!this.pending, 'busy');
    if (signal?.aborted) throw fail('cancelled');
    const id = this._id();
    // Snapshot before any asynchronous wait; caller mutations cannot change
    // correlation/tool validation after the exact submitted frame has left.
    const input = JSON.parse(JSON.stringify(conversation));
    return new Promise((resolve, reject) => {
      const abort = () => this._cancel();
      this.pending = { id, input, resolve, reject, signal, abort, admitted: false, cancelled: false,
        executionErrorVersion: this.caps.execution_error_version === 1 ? 1 : undefined,
        timer: setTimeout(() => this._cancel(), this.caps.max_seconds * 1000 + 5000) };
      signal?.addEventListener('abort', abort, { once: true });
      this._send(id, { type: 'submit_conversation', conversation: input });
      if (signal?.aborted) abort();
    });
  }
  _allowsExecutionBudgetError(message) {
    return this.state === 'open' && this.pending?.admitted === true &&
      this.pending.executionErrorVersion === 1 && message.id === this.pending.id && !this.cancels.has(message.id);
  }
  _response(message) {
    check(object(message) && message.version === 1 && message.event !== 'capabilities', 'invalid_response');
    if (message.event === 'conversation_capabilities') {
      keys(message, ['version', 'id', 'event', 'capabilities']);
      check(this.state === 'connecting' && message.id === this.handshake?.id, 'invalid_response');
      this.caps = capabilities(message.capabilities, this.generationPolicyVersion, this.executionErrorVersion,
        this.outputConstraintVersion);
      this.state = 'open';
      clearTimeout(this.handshake.timer);
      this.handshake.resolve(this.caps);
      this.handshake = null;
    } else if (message.event === 'result') {
      keys(message, ['version', 'id', 'event', 'result']);
      check(this.pending?.admitted && message.id === this.pending.id, 'invalid_response');
      const result = validateResult(message.result, this.caps, this.pending.input);
      this._settle(this.pending.cancelled ? fail('cancelled') : null, result);
    } else super._response(message);
  }
}

module.exports = { PrivateConversation, validateConversation, validateResult, expectedLimits, requestLimit, capabilities,
  OUTPUT_CONSTRAINT, check, keys, text, identifier, object, fail };
