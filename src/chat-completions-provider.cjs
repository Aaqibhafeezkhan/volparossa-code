// SPDX-License-Identifier: GPL-3.0-only
// OpenCode's Chat Completions transport; execution remains in the typed core service.
// Wire source: OpenCode aec0b9a6d8898f68f923aaf08b7306d931fd9d76 (v1.18.34),
// @ai-sdk/openai-compatible 2.0.41: getArgs/doStream, convertTo...Messages, prepareTools.
// OpenCode's patch changes only how SDK stream errors are forwarded, not these fields.
'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const { PrivateConversation, validateConversation, expectedLimits, check, keys, text,
  identifier, object, fail, OUTPUT_CONSTRAINT } = require('./private-conversation.cjs');
const { parseJson } = require('./responses-provider.cjs');
const { PROVIDER_ERRORS, emptyProviderDiagnostic } = require('./opencode-bridge.cjs');
const { terminalCleanupConfirmed } = require('./private-compute.cjs');
const { PrivateNativeSession } = require('./private-native-session.cjs');

const HTTP_BYTES = 524288;
const EXECUTION = Object.freeze({ scope: 'private_local', distributed: false,
  confidentialPeerExecution: false });

function neutral(value, key, allowed) {
  check(value[key] === undefined || allowed.some(item => JSON.stringify(value[key]) === JSON.stringify(item)),
    'unsupported_feature');
}

function messageText(value, maximum, allowEmpty = false) {
  if (Array.isArray(value)) {
    check(value.length >= 1 && value.length <= 128, 'unsupported_content');
    value = value.map(part => {
      keys(part, ['type', 'text']);
      check(part.type === 'text', 'unsupported_content');
      text(part.text, maximum, false);
      return part.text;
    }).join('\n\n');
  }
  text(value, maximum, !allowEmpty);
  return value;
}

function normalizeTools(value, caps) {
  check(Array.isArray(value) && value.length <= caps.max_tools, 'tool_bound');
  return value.map(tool => {
    keys(tool, ['type', 'function']);
    check(tool.type === 'function', 'unsupported_tool');
    keys(tool.function, ['name', 'parameters'], ['description', 'strict']);
    neutral(tool.function, 'strict', [false]); // No claim of arbitrary JSON-schema constrained decoding.
    identifier(tool.function.name);
    const description = tool.function.description ?? `Tool ${tool.function.name}.`;
    text(description, caps.max_tool_description_bytes);
    return { type: 'function', name: tool.function.name, namespace: null,
      description, parameters: tool.function.parameters };
  });
}

function toolChoice(request, tools) {
  const choice = request.tool_choice ?? 'auto';
  if (typeof choice === 'string') {
    check(['auto', 'none', 'required'].includes(choice), 'unsupported_tool_choice');
    check(choice !== 'required' || tools.length > 0, 'unsupported_tool_choice');
  } else {
    keys(choice, ['type', 'function']);
    keys(choice.function, ['name']);
    check(choice.type === 'function' && tools.some(tool => tool.name === choice.function.name),
      'unsupported_tool_choice');
  }
  return choice;
}

function toConversation(request, model, caps, outputConstraint) {
  check(outputConstraint === undefined || outputConstraint === OUTPUT_CONSTRAINT, 'unsupported_output_constraint');
  if (outputConstraint !== undefined) check(caps.output_constraint_version === 1 &&
    caps.output_constraints?.includes(outputConstraint) && model === 'qwen3-4b-instruct-2507-v1' &&
    caps.inference_backend === 'llama_cpp_bf16_v1', 'unsupported_output_constraint');
  keys(request, ['model', 'messages'], ['stream', 'stream_options', 'tools', 'tool_choice',
    'max_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'seed',
    'response_format', 'user', 'reasoning_effort', 'verbosity', 'parallel_tool_calls', 'n', 'store']);
  check(request.model === model && caps.model_profile === model, 'model_mismatch');
  neutral(request, 'stream', [false, true]);
  neutral(request, 'store', [false]);
  neutral(request, 'n', [1]);
  neutral(request, 'temperature', [0]);
  neutral(request, 'top_p', [1]);
  // Zero temperature is a requested execution policy, not a harmless hint.
  // Refuse an older core rather than silently use its sampled profile defaults.
  const greedy = request.temperature === 0;
  if (greedy) check(caps.generation_policy_version === 1 &&
    caps.generation_policies?.includes('greedy_v1'), 'unsupported_generation_policy');
  check(request.top_p === undefined || greedy, 'unsupported_top_p');
  neutral(request, 'frequency_penalty', [0]);
  neutral(request, 'presence_penalty', [0]);
  neutral(request, 'stop', [[]]);
  neutral(request, 'seed', [null]);
  neutral(request, 'reasoning_effort', ['none']);
  neutral(request, 'verbosity', [null]);
  neutral(request, 'response_format', [{ type: 'text' }]);
  neutral(request, 'parallel_tool_calls', [false, true]);
  if (request.max_tokens !== undefined) {
    // The core fixes its generation budget at launch. Do not silently ignore a caller's different budget.
    check(request.max_tokens === caps.max_new_tokens, 'unsupported_output_budget');
  }
  if (request.stream_options !== undefined) {
    keys(request.stream_options, ['include_usage']);
    check(request.stream === true && typeof request.stream_options.include_usage === 'boolean', 'unsupported_stream_options');
  }
  // SDK's optional user hint is not task authority, a log field, cache identity or model context.
  if (request.user !== undefined) text(request.user, 512);
  const tools = normalizeTools(request.tools ?? [], caps);
  toolChoice(request, tools);
  check(Array.isArray(request.messages) && request.messages.length >= 1 &&
    request.messages.length <= caps.max_history_items + 8, 'history_bound');
  const instructions = [], history = [], calls = new Map();
  for (const message of request.messages) {
    check(object(message), 'unsupported_history');
    if (message.role === 'tool') {
      keys(message, ['role', 'tool_call_id', 'content']);
      const call = calls.get(message.tool_call_id);
      check(call && !call.done, 'tool_result_correlation');
      call.done = true;
      // 2.0.41 serializes text, JSON, denied and error outputs as literal strings.
      text(message.content, caps.max_message_bytes, false);
      history.push({ type: 'tool_result', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role === 'assistant') {
      keys(message, ['role', 'content'], ['tool_calls']);
      const proposed = message.tool_calls ?? [];
      check(Array.isArray(proposed) && proposed.length <= caps.max_tools, 'tool_bound');
      const content = message.content === null ? '' : messageText(message.content, caps.max_message_bytes, true);
      if (content) history.push({ type: 'message', role: 'assistant', text: content });
      check(content || proposed.length, 'unsupported_history');
      for (const item of proposed) {
        keys(item, ['id', 'type', 'function']);
        keys(item.function, ['name', 'arguments']);
        check(item.type === 'function' && !calls.has(item.id), 'duplicate_or_unsupported_call');
        const call = { type: 'function_call', call_id: item.id, name: item.function.name,
          namespace: null, arguments: parseJson(item.function.arguments) };
        calls.set(item.id, { done: false });
        history.push(call);
      }
      continue;
    }
    keys(message, ['role', 'content']);
    check(['user', 'system', 'developer'].includes(message.role), 'unsupported_role');
    if (message.role === 'system' && !history.length) {
      instructions.push(messageText(message.content, caps.max_instructions_bytes));
    } else {
      history.push({ type: 'message', role: message.role,
        text: messageText(message.content, caps.max_message_bytes) });
    }
  }
  const conversation = { version: 1, visibility: 'private_local',
    instructions: instructions.length ? instructions.join('\n\n') : 'Answer the user; tool proposals require separate execution authority.',
    history, tools, ...(greedy ? { generation_policy: 'greedy_v1' } : {}),
    ...(outputConstraint !== undefined && tools.length ? { output_constraint: outputConstraint } : {}) };
  validateConversation(conversation, caps);
  return conversation;
}

function completion(result, request) {
  // The negotiated client checked correlation, output bounds and its versioned
  // cleanup boundary. A v2 warm session still requires final owner-side close.
  if (!result.turn_complete) check(result.output.reason === 'token_limit', 'invalid_model_output');
  const output = result.output;
  const isCall = output.type === 'function_call';
  const choice = request.tool_choice ?? 'auto';
  if (result.turn_complete) {
    check(choice !== 'none' || !isCall, 'tool_choice_not_met');
    check(choice !== 'required' || isCall, 'tool_choice_not_met');
    if (object(choice)) check(isCall && output.name === choice.function.name, 'tool_choice_not_met');
  }
  const message = { role: 'assistant', content: output.type === 'assistant' ? output.text : null };
  if (isCall) {
    check(output.namespace === null, 'unsupported_tool');
    message.tool_calls = [{ id: output.call_id, type: 'function',
      function: { name: output.name, arguments: JSON.stringify(output.arguments) } }];
  }
  return { id: `chatcmpl-${randomBytes(16).toString('hex')}`, object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: result.model_profile,
    choices: [{ index: 0, message, finish_reason: !result.turn_complete ? 'length' : isCall ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: result.prompt_tokens, completion_tokens: result.generated_tokens,
      total_tokens: result.prompt_tokens + result.generated_tokens,
      ...(result.version === 1 ? { prompt_tokens_details: { cached_tokens: 0 } } : {}),
      completion_tokens_details: { reasoning_tokens: 0 } } };
}

function streamChunks(answer, includeUsage) {
  const { choices, usage, ...metadata } = answer;
  const base = { ...metadata, object: 'chat.completion.chunk' };
  const choice = choices[0], chunks = [];
  const emit = delta => chunks.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] });
  emit({ role: 'assistant', content: '' });
  if (choice.message.content !== null) emit({ content: choice.message.content });
  if (choice.message.tool_calls) {
    emit({ tool_calls: choice.message.tool_calls.map((call, index) => ({ index, ...call })) });
  }
  chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] });
  if (includeUsage) chunks.push({ ...base, choices: [], usage });
  return chunks;
}

function errorReply(response, status, code) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Connection': 'close' });
  response.end(JSON.stringify({ error: { type: 'volparossa_provider_error', code,
    message: 'The VOLPAROSSA local provider rejected or could not complete this operation.' } }));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    check(size <= HTTP_BYTES, 'request_bound');
    chunks.push(chunk);
  }
  check(size > 0, 'invalid_request');
  try { return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch (error) { throw error.message?.startsWith('private_compute_') ? error : fail('invalid_json'); }
}

async function startChatCompletionsProvider({ socketPath, model, diagnostics = false, outputConstraint,
  nativeSession = false }) {
  expectedLimits(model);
  check(outputConstraint === undefined || outputConstraint === OUTPUT_CONSTRAINT &&
    model === 'qwen3-4b-instruct-2507-v1', 'unsupported_output_constraint');
  check(typeof diagnostics === 'boolean', 'diagnostic_scope');
  check(typeof nativeSession === 'boolean' && (!nativeSession || model === 'qwen3-4b-instruct-2507-v1'),
    'incompatible_capabilities');
  new PrivateConversation(socketPath); // Path validation only; launch does not start compute.
  const bearerToken = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${bearerToken}`);
  let host, active = null, closing = false, closingPromise;
  let warm = null, taskDeadline = null, nativeFailure = false;
  const warmOwners = new Set();
  const observed = { submitted: 0, completed: 0, incomplete: 0, cleanup_confirmed: 0 };
  const records = [];
  const summary = emptyProviderDiagnostic();
  let truncated = false;
  const count = (object, key) => {
    if (object[key] < 65535) object[key]++;
    else summary.truncated = true;
  };
  const creditCleanup = owner => {
    if (!owner?.client.sessionCleanupConfirmed) return;
    while (owner.credited < owner.submitted) {
      owner.credited++; observed.cleanup_confirmed++;
      if (diagnostics) count(summary, 'cleanup_confirmed');
    }
  };
  const server = http.createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000,
    keepAliveTimeout: 1000 }, (request, response) => {
    const received = Buffer.from(request.headers.authorization ?? '');
    if (received.length !== authorization.length || !timingSafeEqual(received, authorization)) {
      errorReply(response, 401, 'unauthorized'); return;
    }
    if (request.headers.host !== host || request.headers.origin !== undefined || request.headers.referer !== undefined ||
        request.method !== 'POST' || request.url !== '/v1/chat/completions' ||
        !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
        request.headers['content-encoding'] !== undefined || request.headers.expect !== undefined) {
      errorReply(response, 400, 'unsupported_request'); return;
    }
    if (closing || active) { errorReply(response, 503, 'busy'); return; }
    if (nativeFailure) { errorReply(response, 422, 'execution_failed'); return; }
    if (nativeSession && observed.submitted >= 128) {
      errorReply(response, 422, 'execution_budget_exceeded'); return;
    }
    if (Number(request.headers['content-length'] ?? 0) > HTTP_BYTES) { errorReply(response, 413, 'request_bound'); return; }
    const controller = new AbortController();
    const clientOptions = { generationPolicyVersion: 1, executionErrorVersion: 1,
      ...(outputConstraint !== undefined ? { outputConstraintVersion: 1 } : {}) };
    if (nativeSession && warm?.client.sessionCleanupConfirmed) {
      creditCleanup(warm); warm = null;
    }
    if (nativeSession && !warm) {
      warm = {client: new PrivateNativeSession(socketPath, clientOptions), submitted: 0, credited: 0};
      warmOwners.add(warm);
    }
    const client = nativeSession ? warm.client : new PrivateConversation(socketPath, clientOptions);
    const owner = { controller, client, warm: nativeSession ? warm : null, done: null, taskTimer: null };
    active = owner;
    response.once('close', () => { if (!response.writableFinished) controller.abort(); });
    request.once('aborted', () => controller.abort());
    owner.done = (async () => {
      try {
        const requestBody = await readBody(request);
        if (controller.signal.aborted) throw fail('cancelled');
        if (nativeSession) {
          taskDeadline ??= performance.now() + 2400000;
          const remaining = Math.floor(taskDeadline - performance.now());
          check(remaining > 0, 'execution_budget_exceeded');
          owner.taskTimer = setTimeout(() => controller.abort(), remaining);
        }
        const caps = nativeSession && client.sessionState === 'new' ? await client.open() : await client.connect();
        const conversation = toConversation(requestBody, model, caps, outputConstraint);
        if (controller.signal.aborted) throw fail('cancelled');
        observed.submitted++;
        if (owner.warm) owner.warm.submitted++;
        if (diagnostics) count(summary, 'submitted');
        const started = performance.now();
        const result = await client.submit(conversation, { signal: controller.signal });
        if (!nativeSession) observed.cleanup_confirmed++;
        if (result.turn_complete) observed.completed++; else observed.incomplete++;
        if (diagnostics) {
          if (!nativeSession) count(summary, 'cleanup_confirmed');
          count(summary, result.turn_complete ? 'completed' : 'incomplete');
          count(summary.results, result.output.type);
          if (!result.turn_complete) count(summary.incomplete_reasons, result.output.reason);
          if (records.length === 16) truncated = true;
          else records.push(Object.freeze({ output_kind: result.output.type,
            prompt_tokens: result.prompt_tokens, generated_tokens: result.generated_tokens,
            turn_complete: result.turn_complete, incomplete_reason: result.turn_complete ? null : result.output.reason,
            elapsed_ms: Math.floor(performance.now() - started) }));
        }
        if (controller.signal.aborted || response.destroyed) return;
        const answer = completion(result, requestBody);
        const streaming = requestBody.stream === true;
        response.writeHead(200, { 'Content-Type': streaming ? 'text/event-stream' : 'application/json',
          'Cache-Control': 'no-store', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff',
          'X-Volparossa-Execution': 'private-local', 'X-Volparossa-Confidential-Peer': 'unavailable' });
        // SSE adaptation, not model token streaming. Legacy results require
        // worker cleanup. Native-session v2 requires request-file cleanup while
        // private KV remains in this task's worker until verified session close.
        response.end(streaming ? streamChunks(answer, requestBody.stream_options?.include_usage === true)
          .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n' : JSON.stringify(answer));
      } catch (error) {
        if (nativeSession) nativeFailure = true;
        if (!nativeSession && terminalCleanupConfirmed(error)) {
          observed.cleanup_confirmed++;
          if (diagnostics) count(summary, 'cleanup_confirmed');
        }
        const code = error.message?.startsWith('private_compute_') ? error.code : 'provider_failed';
        if (diagnostics) count(summary.request_errors, PROVIDER_ERRORS.includes(code) ? code : 'other');
        // Output errors follow a terminal, cleanup-confirmed model result. The
        // negotiated execution budget error instead follows confirmed cleanup
        // without a model result; it must not restart the same expensive turn.
        // OpenCode v1.18.34 retries every 5xx, so 502 would repeatedly regenerate
        // the same unusable greedy turn. Preserve transient/uncertain failures.
        const status = nativeSession && ['cleanup_unconfirmed', 'socket_unavailable', 'socket_error',
          'disconnected', 'execution_failed', 'execution_budget_exceeded'].includes(code) ? 422 :
          ['busy', 'cleanup_unconfirmed', 'socket_unavailable', 'execution_failed'].includes(code) ? 503 :
          ['invalid_model_output', 'tool_choice_not_met', 'execution_budget_exceeded'].includes(code) ? 422 :
          code === 'request_bound' ? 413 : 400;
        errorReply(response, status, code);
      } finally {
        clearTimeout(owner.taskTimer);
        if (nativeSession) {
          if (controller.signal.aborted) nativeFailure = true;
          if (controller.signal.aborted && client.sessionState === 'open' && !client.pending) {
            // Cancellation also ends an idle warm worker, not just an admitted
            // request. Keep uncertainty visible to the final owner close.
            try { await client.finish(); } catch { client.close(); }
          }
          creditCleanup(owner.warm);
        }
        else client.close();
        if (active === owner) active = null;
      }
    })();
  });
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 1;
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`;
  return { baseUrl: `http://${host}/v1`, bearerToken, execution: EXECUTION,
    get observations() { return Object.freeze({ ...observed }); },
    get diagnostics() { return diagnostics ? Object.freeze({ version: 1,
      records: Object.freeze([...records]), truncated,
      summary: Object.freeze({...summary, results: Object.freeze({...summary.results}),
        incomplete_reasons: Object.freeze({...summary.incomplete_reasons}),
        request_errors: Object.freeze({...summary.request_errors})}) }) : null; },
    close() {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = (async () => {
        const owner = active;
        owner?.controller.abort();
        server.closeAllConnections();
        await owner?.done;
        let cleanupError;
        if (nativeSession) {
          try {
            for (const session of warmOwners) {
              // A failed handshake started no session. Once open was sent, an
              // absent receipt is uncertainty even if no model turn was sent.
              if (session.client.openId !== null) await session.client.finish();
              creditCleanup(session);
            }
          } catch (error) { cleanupError = error; }
          finally {
            for (const session of warmOwners) session.client.close();
            warmOwners.clear();
          }
        }
        await new Promise(resolve => server.close(resolve));
        if (cleanupError) throw cleanupError;
      })();
      return closingPromise;
    } };
}

module.exports = { startChatCompletionsProvider, toConversation, completion, streamChunks };
