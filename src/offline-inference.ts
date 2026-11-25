import { inferenceDeadline, inferenceTimeout, type InferenceTimeout } from './inference-timeout.js';
import { OfflineInferenceError, isOfflineInferenceError, type OfflineErrorCode } from './offline-error.js';

export { OfflineInferenceError };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export interface InferenceChunk {
  candidates: { index: number; parts: JsonObject[]; finishReason?: string }[];
  usage?: Record<string, number>;
}
export type OfflineTransport = (body: string, signal: AbortSignal, options?: { readonly timeout?: InferenceTimeout }) => AsyncIterable<Uint8Array>;

const MAX_BYTES = 1_048_576;
export const REQUEST_MAX_BYTES = 8 * 1_048_576;
const finishReasons = ['FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'MODEL_ARMOR', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'IMAGE_OTHER', 'UNEXPECTED_TOOL_CALL', 'NO_IMAGE', 'MALFORMED_RESPONSE', 'CONTINUATION', 'TOO_MANY_TOOL_CALLS'];
const thinkingLevels = ['THINKING_LEVEL_UNSPECIFIED', 'LOW', 'MEDIUM', 'HIGH', 'MINIMAL', 'EXTRA_HIGH', 'MAX', 'XHIGH'];
const usageFields = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'toolUsePromptTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount'];

function fail(code: OfflineErrorCode = 'invalid'): never { throw new OfflineInferenceError(code); }

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || property.get || property.set) fail();
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported');
}

function text(value: unknown, empty = false, limit = MAX_BYTES): string {
  if (typeof value !== 'string' || (!empty && value.length === 0)) fail();
  if (Buffer.byteLength(value, 'utf8') > limit) fail('limit');
  if (/[\uD800-\uDFFF]/u.test(value)) fail();
  return value;
}

function identifier(value: unknown): string {
  const result = text(value, false, 512);
  if (/[\u0000-\u001f\u007f]/u.test(result)) fail();
  return result;
}

function list(value: unknown, max: number, nonempty = false): unknown[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail();
  if (value.length > max) fail('limit');
  return value;
}

function int32(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) fail();
  return value;
}

function json(value: unknown, limit = MAX_BYTES): JsonValue {
  let nodes = 0, bytes = 0;
  function charge(size: number): void { bytes += size; if (bytes > limit) fail('limit'); }
  function clone(item: unknown, depth: number): JsonValue {
    if (++nodes > 10_000 || depth > 16) fail('limit');
    charge(2);
    if (item === null || typeof item === 'boolean') { charge(5); return item; }
    if (typeof item === 'string') { const s = text(item, true, limit); charge(Buffer.byteLength(JSON.stringify(s))); return s; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); charge(24); return item; }
    if (Array.isArray(item)) return list(item, 10_000).map(entry => clone(entry, depth + 1));
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(object(item))) {
      const safeKey = text(key, true, 1024);
      charge(Buffer.byteLength(JSON.stringify(safeKey)) + 1);
      result[safeKey] = clone(entry, depth + 1);
    }
    return result;
  }
  return clone(value, 0);
}

function parts(value: unknown, limit = MAX_BYTES): JsonObject[] {
  return list(value, 1024, true).map(entry => {
    const part = object(entry);
    keys(part, ['text', 'functionCall', 'functionResponse', 'thought', 'thoughtSignature']);
    const data = ['text', 'functionCall', 'functionResponse'].filter(key => Object.hasOwn(part, key));
    if (data.length !== 1) fail();
    const result: JsonObject = {};
    if (Object.hasOwn(part, 'text')) result.text = text(part.text, true, limit);
    for (const kind of ['functionCall', 'functionResponse']) {
      if (!Object.hasOwn(part, kind)) continue;
      const tool = object(part[kind]);
      const payload = kind === 'functionCall' ? 'args' : 'response';
      keys(tool, ['id', 'name', payload]);
      const converted: JsonObject = { name: identifier(tool.name) };
      if (Object.hasOwn(tool, 'id')) converted.id = identifier(tool.id);
      if (Object.hasOwn(tool, payload)) converted[payload] = json(object(tool[payload]), limit);
      result[kind] = converted;
    }
    if (Object.hasOwn(part, 'thought')) {
      if (typeof part.thought !== 'boolean') fail();
      result.thought = part.thought;
    }
    if (Object.hasOwn(part, 'thoughtSignature')) {
      const signature = text(part.thoughtSignature, true);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(signature)) fail();
      result.thoughtSignature = signature;
    }
    return result;
  });
}

function content(value: unknown, system = false, limit = MAX_BYTES): JsonObject {
  const entry = object(value);
  keys(entry, ['role', 'parts']);
  const result: JsonObject = { parts: parts(entry.parts, limit) };
  if (Object.hasOwn(entry, 'role')) {
    if (!['user', 'model'].includes(entry.role as string)) fail('unsupported');
    result.role = entry.role as string;
  } else if (!system) fail();
  if (system && (result.parts as JsonObject[]).some(part => !Object.hasOwn(part, 'text'))) fail('unsupported');
  return result;
}

function generation(value: unknown): JsonObject {
  const entry = object(value);
  keys(entry, ['temperature', 'topP', 'maxOutputTokens', 'stopSequences', 'thinkingConfig']);
  const result: JsonObject = {};
  for (const key of ['temperature', 'topP']) {
    if (!Object.hasOwn(entry, key)) continue;
    const n = entry[key];
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isFinite(Math.fround(n))) fail();
    result[key] = n;
  }
  if (Object.hasOwn(entry, 'maxOutputTokens')) {
    const n = int32(entry.maxOutputTokens); if (n <= 0) fail(); result.maxOutputTokens = n;
  }
  if (Object.hasOwn(entry, 'stopSequences')) result.stopSequences = list(entry.stopSequences, 32).map(v => text(v));
  if (Object.hasOwn(entry, 'thinkingConfig')) {
    const thinking = object(entry.thinkingConfig);
    keys(thinking, ['includeThoughts', 'thinkingBudget', 'thinkingLevel']);
    const config: JsonObject = {};
    if (Object.hasOwn(thinking, 'includeThoughts')) {
      if (typeof thinking.includeThoughts !== 'boolean') fail(); config.includeThoughts = thinking.includeThoughts;
    }
    if (Object.hasOwn(thinking, 'thinkingBudget')) config.thinkingBudget = int32(thinking.thinkingBudget);
    if (Object.hasOwn(thinking, 'thinkingLevel')) {
      if (!thinkingLevels.includes(thinking.thinkingLevel as string)) fail('unsupported');
      config.thinkingLevel = thinking.thinkingLevel as string;
    }
    result.thinkingConfig = config;
  }
  return result;
}

export function buildInferenceRequest(value: unknown, options: { localIdentity?: boolean } = {}): string {
  if (options.localIdentity !== undefined && typeof options.localIdentity !== 'boolean') fail();
  const entry = object(json(value, REQUEST_MAX_BYTES));
  keys(entry, ['project', 'model', 'requestId', 'contents', 'systemInstruction', 'generationConfig', 'tools']);
  const request: JsonObject = { contents: list(entry.contents, 1024, true).map(v => content(v, false, REQUEST_MAX_BYTES)) };
  if (Object.hasOwn(entry, 'systemInstruction')) request.systemInstruction = content(entry.systemInstruction, true, REQUEST_MAX_BYTES);
  if (Object.hasOwn(entry, 'generationConfig')) request.generationConfig = generation(entry.generationConfig);
  if (Object.hasOwn(entry, 'tools')) {
    request.tools = [{ functionDeclarations: list(entry.tools, 256, true).map(v => {
      const tool = object(v); keys(tool, ['name', 'description', 'parametersJsonSchema', 'responseJsonSchema']);
      const result: JsonObject = { name: identifier(tool.name) };
      if (Object.hasOwn(tool, 'description')) result.description = text(tool.description, true, REQUEST_MAX_BYTES);
      if (Object.hasOwn(tool, 'parametersJsonSchema')) result.parametersJsonSchema = json(object(tool.parametersJsonSchema), REQUEST_MAX_BYTES);
      if (Object.hasOwn(tool, 'responseJsonSchema')) result.responseJsonSchema = json(object(tool.responseJsonSchema), REQUEST_MAX_BYTES);
      return result;
    }) }];
  }
  const project = Object.hasOwn(entry, 'project') ? identifier(entry.project) : undefined;
  if (project !== undefined && !project.trim()) fail();
  const body = JSON.stringify({ ...(project === undefined ? {} : { project }), model: identifier(entry.model), requestId: identifier(entry.requestId), request, ...(options.localIdentity ? { userAgent: 'antigravity', requestType: 'agent' } : {}) });
  if (Buffer.byteLength(body) > REQUEST_MAX_BYTES) fail('limit');
  return body;
}

export function convertInferenceResponse(value: unknown): InferenceChunk {
  const wrapper = object(json(value));
  if (Object.hasOwn(wrapper, 'error')) fail('remote');
  keys(wrapper, ['response', 'traceId', 'consumedCredits', 'remainingCredits', 'metadata']);
  const response = object(wrapper.response);
  keys(response, ['candidates', 'usageMetadata', 'promptFeedback', 'modelVersion', 'responseId', 'createTime']);
  if (Object.hasOwn(response, 'promptFeedback')) {
    const feedback = object(response.promptFeedback);
    if (Object.hasOwn(feedback, 'blockReason') && ![0, 'BLOCKED_REASON_UNSPECIFIED'].includes(feedback.blockReason as string | number)) fail('remote');
  }
  const candidates = Object.hasOwn(response, 'candidates') ? list(response.candidates, 1).map(v => {
    const candidate = object(v); keys(candidate, ['index', 'content', 'finishReason']);
    const index = Object.hasOwn(candidate, 'index') ? int32(candidate.index) : 0;
    if (index !== 0) fail('unsupported');
    const converted: InferenceChunk['candidates'][number] = { index, parts: [] };
    if (Object.hasOwn(candidate, 'content')) {
      const c = object(candidate.content); keys(c, ['role', 'parts']);
      if (Object.hasOwn(c, 'role') && c.role !== 'model') fail('unsupported');
      if (Object.hasOwn(c, 'parts')) converted.parts = parts(c.parts);
    }
    if (Object.hasOwn(candidate, 'finishReason')) {
      const reason = candidate.finishReason;
      const normalized = typeof reason === 'number' ? finishReasons[int32(reason)] : reason;
      if (typeof normalized !== 'string' || !finishReasons.includes(normalized)) fail('unsupported');
      converted.finishReason = normalized;
    }
    return converted;
  }) : [];
  const result: InferenceChunk = { candidates };
  if (Object.hasOwn(response, 'usageMetadata')) {
    const usage = object(response.usageMetadata); keys(usage, usageFields);
    result.usage = {};
    for (const [key, v] of Object.entries(usage)) { const n = int32(v); if (n < 0) fail(); result.usage[key] = n; }
  }
  if (!candidates.length && !result.usage) fail();
  return result;
}

export function createInferenceDecoder(): { push(bytes: Uint8Array): InferenceChunk[]; finish(): InferenceChunk[] } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const frameDecoder = new TextDecoder('utf-8', { fatal: true });
  const buffer = new Uint8Array(MAX_BYTES + 4);
  let pending = 0, total = 0, count = 0, closed = false, terminal = false;
  function parse(frame: string): InferenceChunk | undefined {
    if (!frame.trim()) return;
    if (++count > 1024) fail('limit');
    if (frame.trim().startsWith('{')) {
      let raw: unknown; try { raw = JSON.parse(frame); } catch { fail(); }
      if (Object.hasOwn(object(raw), 'error')) fail('remote');
      fail('unsupported');
    }
    let data: string | undefined;
    for (const line of frame.split('\n')) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!clean) continue;
      if (!clean.startsWith('data:') || data !== undefined) fail('unsupported');
      data = clean.slice(5).trim();
    }
    if (data === undefined) fail('unsupported');
    let raw: unknown; try { raw = JSON.parse(data); } catch { fail(); }
    let chunk: InferenceChunk;
    try { chunk = convertInferenceResponse(raw); }
    catch (error) { throw new OfflineInferenceError(isOfflineInferenceError(error) ? error.code : 'invalid', 'response'); }
    if (terminal && chunk.candidates.length) fail('unsupported');
    if (chunk.candidates.some(candidate => candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED')) terminal = true;
    return chunk;
  }
  function safely(run: () => InferenceChunk[]): InferenceChunk[] {
    if (closed) fail('closed');
    try { return run(); } catch (error) {
      closed = true; pending = 0; buffer.fill(0);
      throw isOfflineInferenceError(error) ? new OfflineInferenceError(error.code, error.stage ?? 'framing') : new OfflineInferenceError('invalid', 'framing');
    }
  }
  return {
    push(bytes) {
      return safely(() => {
        if (!(bytes instanceof Uint8Array)) fail();
        total += bytes.byteLength;
        if (total > 16 * MAX_BYTES) fail('limit');
        decoder.decode(bytes, { stream: true });
        const chunks: InferenceChunk[] = [];
        for (const byte of bytes) {
          if (pending === buffer.length) fail('limit');
          buffer[pending++] = byte;
          let width = 0;
          if (pending >= 2 && byte === 10 && buffer[pending - 2] === 10) width = 2;
          else if (pending >= 4 && byte === 10 && buffer[pending - 2] === 13 && buffer[pending - 3] === 10 && buffer[pending - 4] === 13) width = 4;
          if (!width) continue;
          if (pending - width > MAX_BYTES) fail('limit');
          if (pending > width) {
            const chunk = parse(frameDecoder.decode(buffer.subarray(0, pending - width)));
            if (chunk) chunks.push(chunk);
          }
          pending = 0;
        }
        return chunks;
      });
    },
    finish() {
      return safely(() => {
        decoder.decode();
        if (pending > MAX_BYTES) fail('limit');
        const chunk = pending ? parse(frameDecoder.decode(buffer.subarray(0, pending))) : undefined;
        const result = chunk ? [chunk] : [];
        if (!terminal) fail('truncated');
        closed = true; pending = 0; buffer.fill(0);
        return result;
      });
    },
  };
}

function nextWithAbort(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(new OfflineInferenceError('cancelled')); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    Promise.resolve().then(() => { if (signal.aborted) fail('cancelled'); return iterator.next(); }).then(value => {
      signal.removeEventListener('abort', cancel); resolve(value);
    }, error => { signal.removeEventListener('abort', cancel); reject(error); });
  });
}

export async function* inferOffline(input: unknown, transport: OfflineTransport, options: { signal?: AbortSignal; localIdentity?: boolean; timeout?: InferenceTimeout; onTransportError?: (error: unknown) => void } = {}): AsyncGenerator<InferenceChunk> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const signal = options.signal;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let complete = false;
  let clearDeadline = () => {};
  try {
    if (typeof transport !== 'function') fail();
    if (signal?.aborted) fail('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = inferenceTimeout(options.timeout);
    clearDeadline = inferenceDeadline(controller, timeout?.total);
    const body = buildInferenceRequest(input, { ...(options.localIdentity === undefined ? {} : { localIdentity: options.localIdentity }) });
    iterator = transport(body, controller.signal, timeout === undefined ? undefined : { timeout })[Symbol.asyncIterator]();
    const decoder = createInferenceDecoder();
    for (;;) {
      const step = await nextWithAbort(iterator, controller.signal);
      if (controller.signal.aborted) fail('cancelled');
      if (step.done) {
        yield* decoder.finish();
        if (controller.signal.aborted) fail('cancelled');
        complete = true;
        return;
      }
      for (const chunk of decoder.push(step.value)) {
        if (controller.signal.aborted) fail('cancelled');
        yield chunk;
      }
    }
  } catch (error) {
    if (!isOfflineInferenceError(error)) options.onTransportError?.(error);
    throw isOfflineInferenceError(error) ? error : new OfflineInferenceError('transport');
  } finally {
    clearDeadline();
    signal?.removeEventListener('abort', cancel);
    controller.abort();
    if (!complete && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Caller-owned cleanup cannot replace the sanitized outcome. */ }
    }
  }
}
