import { randomUUID } from 'node:crypto';
import { AIError, InvalidRequestError, InvalidProviderOutputError, LanguageModel, LLMEvent, Usage, type LLMRequest } from '@opencode/ai';
import { Protocol, Route } from '@opencode/ai/route';
import { Effect, Schema, Stream } from 'effect';
import type { OfflineTransport } from './offline-inference.js';

// The host caches ES modules by URL; the per-runtime query lets a location reload pick up code updates
// without a process restart. OfflineInferenceError keeps a single identity via the stable offline-error module.
const inferenceModule = await import(`./offline-inference.js?runtime=${new URL(import.meta.url).searchParams.get('runtime') ?? ''}`) as typeof import('./offline-inference.js');
const { buildInferenceRequest, inferOffline, OfflineInferenceError } = inferenceModule;
export { OfflineInferenceError };
import { inferenceTimeout, type InferenceTimeout } from './inference-timeout.js';

export interface OfflineModelConfig {
  provider: string;
  model: string;
  project?: string;
  requestId: string | (() => string);
  textSemantics: 'delta' | 'cumulative';
  usageSemantics: 'single-report' | 'cumulative-snapshot';
  transport: OfflineTransport;
  localIdentity?: boolean;
}

const toolInputStages = { outputSchema: 'input_tools_schema', metadata: 'input_tools_metadata', native: 'input_tools_native',
  freeform: 'input_tools_freeform', cache: 'input_tools_cache' } as const;
const partInputStages = { cache: 'input_part_cache', metadata: 'input_part_metadata', providerMetadata: 'input_part_provider_metadata' } as const;
const inputStages = ['input', 'input_root', 'input_headers', 'input_affinity', 'input_http', 'input_timeout', 'input_tools', 'input_message', 'input_part', 'input_generation', 'input_serialization',
  ...Object.values(toolInputStages), ...Object.values(partInputStages)] as const;
type InputStage = typeof inputStages[number];
class NativeInputError extends Error {
  constructor(readonly stage: InputStage) { super('Offline model: unsupported or invalid input'); }
}
function invalid(stage: InputStage = 'input'): never { throw new NativeInputError(stage); }
// The Code Assist backend answers HTTP 429 when the system instruction contains
// this literal Code Mode call expression. Rewrite only that reference to an
// equivalent description; rules, paths, tools and signed history stay intact.
// Isolated by controlled bisection of the outgoing systemInstruction.
const remoteFilteredSystemReferences: ReadonlyArray<readonly [string, string]> = [
  ['tools.opencode.session_move', 'the opencode session_move tool'],
];
function neutralizeSystemText(text: string): string {
  let result = text;
  for (const [from, to] of remoteFilteredSystemReferences) result = result.split(from).join(to);
  return result;
}
function outputError(error?: unknown): AIError {
  const code = error instanceof OfflineInferenceError && ['invalid', 'unsupported', 'remote', 'limit', 'truncated', 'closed', 'cancelled', 'transport'].includes(error.code) ? error.code : 'unsupported';
  const stage = error instanceof OfflineInferenceError ? ['framing', 'response', 'native_usage', 'http_400', 'http_401', 'http_403', 'http_429', 'http_429_capacity', 'http_429_quota', 'http_429_rate', 'http_5xx', 'http_error'].includes(error.stage ?? '') ? error.stage : 'transport' : 'native_output';
  return new AIError({ reason: new InvalidProviderOutputError({ message: `Offline model: invalid or unsupported stream (offline_code=${code} offline_stage=${stage})` }) });
}

function fields(value: object, allowed: readonly string[], stage: InputStage = 'input'): void {
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (property.get || property.set || (!allowed.includes(key) && property.value !== undefined)) {
      if (stage === 'input_tools' && Object.hasOwn(toolInputStages, key)) invalid(toolInputStages[key as keyof typeof toolInputStages]);
      if (stage === 'input_part' && Object.hasOwn(partInputStages, key)) invalid(partInputStages[key as keyof typeof partInputStages]);
      invalid(stage);
    }
  }
}

function validateSystemInstructionMetadata(value: unknown, rendered: string): void {
  const data = (input: unknown, keys: string[]): Record<string, PropertyDescriptor> => {
    if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid('input_part_metadata');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== keys.length || Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))) invalid('input_part_metadata');
    if (Object.values(descriptors).some(property => property.get || property.set)) invalid('input_part_metadata');
    return descriptors;
  };
  const metadata = data(value, ['experimental']);
  const experimental = data(metadata.experimental!.value, ['instructions']);
  const entries: unknown = experimental.instructions!.value;
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype || entries.length > 256) invalid('input_part_metadata');
  const descriptors = Object.getOwnPropertyDescriptors(entries);
  if (Reflect.ownKeys(descriptors).length !== entries.length + 1) invalid('input_part_metadata');
  const texts: string[] = [];
  let bytes = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(entries, String(i));
    if (!entry || entry.get || entry.set) invalid('input_part_metadata');
    const properties = data(entry.value, ['key', 'text']);
    const key: unknown = properties.key!.value, text: unknown = properties.text!.value;
    if (typeof key !== 'string' || !key.length || key.length > 1024 || /[^\x20-\x7e]/u.test(key) || typeof text !== 'string') invalid('input_part_metadata');
    bytes += Buffer.byteLength(key) + Buffer.byteLength(text);
    if (bytes > 1_048_576) invalid('input_part_metadata');
    texts.push(text);
  }
  if (texts.join('\n\n') !== rendered) invalid('input_part_metadata');
}

function toolResponseSchema(value: unknown): object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('input_tools_schema');
  const pending: object[] = [value], seen = new WeakSet<object>();
  let properties = 0;
  while (pending.length) {
    const schema = pending.pop()!;
    if (seen.has(schema)) continue;
    seen.add(schema);
    for (const key of Reflect.ownKeys(schema)) {
      if (++properties > 10_000) invalid('input_tools_schema');
      // Enveloping changes the root and scope of relative schema references.
      if (typeof key !== 'string' || ['$ref', '$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor'].includes(key)) invalid('input_tools_schema');
      const property = Object.getOwnPropertyDescriptor(schema, key)!;
      if (property.get || property.set) invalid('input_tools_schema');
      if (property.value && typeof property.value === 'object') pending.push(property.value);
    }
  }
  return { anyOf: [
    { type: 'object', properties: { result: value }, required: ['result'], additionalProperties: false },
    { type: 'object', properties: { error: {} }, required: ['error'], additionalProperties: false },
  ] };
}

type Lowered = { input: unknown; names: Map<string, string>; timeout?: InferenceTimeout };
type NativeRequest = LLMRequest & {
  readonly timeout?: number | false | InferenceTimeout;
  readonly headers?: Readonly<Record<string, string>>;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stop?: readonly string[];
};

function lower(request: NativeRequest, config: OfflineModelConfig): Lowered {
  fields(request, ['id', 'model', 'system', 'messages', 'tools', 'generation', 'http', 'headers', 'temperature', 'topP', 'maxTokens', 'stop', 'timeout', 'promptCacheKey'], 'input_root');
  let timeout: InferenceTimeout | undefined;
  try { timeout = inferenceTimeout(request.timeout); } catch { invalid('input_timeout'); }
  if (request.promptCacheKey !== undefined && (typeof request.promptCacheKey !== 'string'
    || !request.promptCacheKey.length || request.promptCacheKey.length > 512 || /[^\x21-\x7e]/u.test(request.promptCacheKey))) invalid('input_affinity');
  if (request.headers !== undefined) {
    const headers = request.headers;
    if (!headers || typeof headers !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(headers))) invalid('input_headers');
    const allowed = ['x-opencode-session', 'x-opencode-session-id', 'x-opencode-parent-session-id', 'x-session-affinity',
      'x-session-id', 'x-parent-session-id', 'user-agent', 'x-opencode-project', 'x-opencode-client'];
    const seen = new Set<string>();
    for (const key of Reflect.ownKeys(headers)) {
      if (typeof key !== 'string') invalid('input_headers');
      const name = key.toLowerCase();
      const property = Object.getOwnPropertyDescriptor(headers, key)!;
      if (!allowed.includes(name) || seen.has(name) || property.get || property.set) invalid('input_headers');
      seen.add(name);
      const value: unknown = property.value;
      if (typeof value !== 'string' || !value.trim() || value.length > 512
        || (name === 'user-agent' ? /[^\x20-\x7e]/u : /[^\x21-\x7e]/u).test(value)) invalid('input_headers');
    }
    if (!seen.has('x-opencode-session')) invalid('input_headers');
  }
  const requestId = typeof config.requestId === 'function' ? request.id ?? config.requestId() : config.requestId;
  if (typeof config.requestId === 'string' && request.id !== undefined && request.id !== requestId) invalid();
  if (request.http && Object.values(request.http).some(v => v !== undefined)) invalid('input_http');
  const forward = new Map<string, string>(), names = new Map<string, string>();
  const mapName = (name: string): string => {
    if (typeof name !== 'string' || !name) invalid();
    const existing = forward.get(name);
    if (existing) return existing;
    let base = name.replace(/[^a-zA-Z0-9_]/g, '_');
    if (!/^[a-zA-Z_]/.test(base)) base = `_${base}`;
    let mapped = base, suffix = 1;
    while (names.has(mapped)) mapped = `${base}_${suffix++}`;
    forward.set(name, mapped); names.set(mapped, name);
    return mapped;
  };
  const tools = request.tools.map(tool => {
    fields(tool, ['type', 'name', 'description', 'inputSchema', 'outputSchema'], 'input_tools');
    if ('type' in tool && tool.type !== 'tool') invalid();
    if (!('inputSchema' in tool)) invalid();
    return { name: mapName(tool.name), description: tool.description, parametersJsonSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { responseJsonSchema: toolResponseSchema(tool.outputSchema) }) };
  });
  const declared = new Map(names);
  const parts = (values: ReadonlyArray<{ readonly type: string; readonly text?: unknown }>, system = false) => values.map(part => {
    fields(part, system ? ['type', 'text', 'metadata'] : ['type', 'text'], 'input_part');
    if (part.type !== 'text' || typeof part.text !== 'string') invalid();
    const metadata: unknown = Object.getOwnPropertyDescriptor(part, 'metadata')?.value;
    if (system && metadata !== undefined) validateSystemInstructionMetadata(metadata, part.text);
    return { text: system ? neutralizeSystemText(part.text) : part.text };
  });
  const contentResultValue = (value: unknown): unknown => {
    if (!Array.isArray(value)) invalid();
    return value.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid();
      const entry = item as { type?: unknown; text?: unknown; uri?: unknown; mime?: unknown; name?: unknown };
      if (entry.type === 'text' && typeof entry.text === 'string') return { type: 'text', text: entry.text };
      if (entry.type === 'file' && typeof entry.uri === 'string' && typeof entry.mime === 'string')
        return { type: 'file', uri: entry.uri, mime: entry.mime, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) };
      return invalid();
    });
  };
  // Claude rejects a replayed thinking block without a signature. Signatures are model-scoped and are dropped
  // on a model/provider switch (and Antigravity does not expose Claude's), so unsigned reasoning is sent as
  // readable text instead of a thought block for Claude wire models.
  const claudeWire = config.model.toLowerCase().includes('claude');
  const contents = request.messages.map(message => {
    fields(message, ['id', 'role', 'content'], 'input_message');
    const messageId: unknown = Object.getOwnPropertyDescriptor(message, 'id')?.value;
    if (messageId !== undefined && (typeof messageId !== 'string' || !messageId.length
      || messageId.length > 512 || /[^\x21-\x7e]/u.test(messageId))) invalid('input_message');
    if (message.role === 'system') {
      const text = neutralizeSystemText(parts(message.content).map(part => part.text).join('\n'))
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      return { role: 'user', parts: [{ text: `<system-update>\n${text}\n</system-update>` }] };
    }
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') invalid('input_message');
    const converted = message.content.map(part => {
      if ((part.type === 'text' || part.type === 'reasoning') && message.role === 'assistant') {
        fields(part, ['type', 'text', 'providerMetadata'], 'input_part');
        if (typeof part.text !== 'string') invalid();
        const metadata = part.providerMetadata;
        let signature: string | undefined;
        if (metadata !== undefined) {
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) invalid();
          // History carried over from other providers carries their metadata; only our own signature is forwarded.
          const meta = metadata.offlineInference;
          if (meta !== undefined) {
            if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.thoughtSignature !== 'string') invalid();
            signature = meta.thoughtSignature;
          }
        }
        const thought = part.type === 'reasoning' && (signature !== undefined || !claudeWire);
        return { text: part.text, ...(thought ? { thought: true } : {}),
          ...(signature === undefined ? {} : { thoughtSignature: signature }) };
      }
      if (part.type === 'text' && message.role === 'user') return parts([part])[0];
      if (part.type === 'tool-call' && message.role === 'assistant') {
        fields(part, ['type', 'id', 'name', 'namespace', 'input', 'providerMetadata', 'providerExecuted', 'cache'], 'input_part');
        const providerExecuted: unknown = Object.getOwnPropertyDescriptor(part, 'providerExecuted')?.value;
        if (providerExecuted !== undefined && providerExecuted !== false) invalid('input_part');
        const meta = part.providerMetadata?.offlineInference;
        if (meta !== undefined && (!meta || typeof meta !== 'object' || Array.isArray(meta))) invalid();
        return { functionCall: { id: part.id, name: mapName(part.name), args: part.input },
          ...(meta?.thoughtSignature === undefined ? {} : { thoughtSignature: meta.thoughtSignature }) };
      }
      if (part.type === 'tool-result' && message.role === 'tool') {
        fields(part, ['type', 'id', 'name', 'namespace', 'result', 'output', 'providerMetadata', 'providerExecuted', 'cache'], 'input_part');
        const providerExecuted: unknown = Object.getOwnPropertyDescriptor(part, 'providerExecuted')?.value;
        if (providerExecuted !== undefined && providerExecuted !== false) invalid('input_part');
        const resultMeta = part.providerMetadata?.offlineInference;
        if (resultMeta !== undefined && (!resultMeta || typeof resultMeta !== 'object' || Array.isArray(resultMeta))) invalid();
        fields(part.result, ['type', 'value']);
        if (!['json', 'text', 'error', 'content'].includes(part.result.type)) invalid();
        const value = part.result.type === 'content' ? contentResultValue(part.result.value) : part.result.value;
        return { functionResponse: { id: part.id, name: mapName(part.name), response: { [part.result.type === 'error' ? 'error' : 'result']: value } } };
      }
      const unknownPart = part as { type?: unknown; id?: unknown; name?: unknown; message?: unknown };
      if (unknownPart.type === 'tool-error' && message.role === 'tool') {
        fields(part, ['type', 'id', 'name', 'namespace', 'message', 'providerMetadata', 'providerExecuted', 'cache'], 'input_part');
        if (typeof unknownPart.message !== 'string') invalid();
        return { functionResponse: { id: unknownPart.id as string, name: mapName(unknownPart.name as string), response: { error: unknownPart.message } } };
      }
      return invalid('input_part');
    });
    return { role: message.role === 'assistant' ? 'model' : 'user', parts: converted };
  });
  const generationConfig: Record<string, unknown> = {};
  const modelId = config.model.toLowerCase();
  if (config.localIdentity && modelId.startsWith('gemini-') && !modelId.includes('image')) {
    generationConfig.thinkingConfig = { thinkingBudget: modelId.endsWith('-low') ? 1000 : 10001, includeThoughts: true };
  }
  const nativeGeneration = ['temperature', 'topP', 'maxTokens', 'stop'] as const;
  const hasNativeGeneration = nativeGeneration.some(key => request[key] !== undefined);
  if (request.generation) fields(request.generation, nativeGeneration, 'input_generation');
  if (request.generation && hasNativeGeneration && Object.values(request.generation).some(value => value !== undefined)) invalid();
  const generation = hasNativeGeneration ? Object.fromEntries(nativeGeneration.map(key => [key, request[key]])) : request.generation;
  if (generation) {
    for (const [source, target] of [['temperature', 'temperature'], ['topP', 'topP'], ['maxTokens', 'maxOutputTokens'], ['stop', 'stopSequences']] as const) {
      if (generation[source] !== undefined) generationConfig[target] = generation[source];
    }
  }
  const input = { ...(config.project === undefined ? {} : { project: config.project }), model: config.model, requestId, contents,
    ...(request.system.length ? { systemInstruction: { parts: parts(request.system, true) } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    ...(tools.length ? { tools } : {}),
  };
  try { buildInferenceRequest(input); } catch (error) {
    console.warn('Antigravity inference serialization rejected:', JSON.stringify({
      code: error instanceof OfflineInferenceError ? error.code : 'unknown',
      contents: contents.length, tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(input)),
    }));
    invalid('input_serialization');
  }
  return { input, names: declared, ...(timeout === undefined ? {} : { timeout }) };
}

async function* events(lowered: Lowered, config: OfflineModelConfig, signal: AbortSignal): AsyncGenerator<LLMEvent> {
  let reason: string | undefined, usage: Usage | undefined, called = false;
  let usageSnapshot: Record<string, number> | undefined;
  const text = { text: '', reasoning: '' };
  const sealed = { text: false, reasoning: false };
  let block: { kind: 'text' | 'reasoning'; id: string; offset: number; signature?: string } | undefined;
  let blockIndex = 0, textBytes = 0;
  const endBlock = (): LLMEvent | undefined => {
    if (!block) return undefined;
    const event: LLMEvent = { type: block.kind === 'text' ? 'text-end' : 'reasoning-end', id: block.id,
      ...(block.signature === undefined ? {} : { providerMetadata: { offlineInference: { thoughtSignature: block.signature } } }) };
    block = undefined;
    return event;
  };
  const callIds = new Set<string>(), idlessCalls = new Set<string>(), fingerprints = new Set<string>();
  const calls: Array<Extract<LLMEvent, { type: 'tool-call' }>> = [];
  let callBytes = 0;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  yield { type: 'step-start', index: 0 };
  for await (const chunk of inferOffline(lowered.input, config.transport, { signal, ...(lowered.timeout === undefined ? {} : { timeout: lowered.timeout }), ...(config.localIdentity === undefined ? {} : { localIdentity: config.localIdentity }),
    onTransportError: error => {
      const cause = (error as { cause?: { code?: unknown } })?.cause;
      console.warn('Antigravity inference transport failed:', JSON.stringify({
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message.slice(0, 160) : '',
        causeCode: cause && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : undefined,
      }));
    } })) {
    for (const candidate of chunk.candidates) {
      for (const part of candidate.parts) {
        if (typeof part.text === 'string' && Object.keys(part).every(key => ['text', 'thought', 'thoughtSignature'].includes(key))) {
          const kind = part.thought === true ? 'reasoning' : 'text';
          const incoming = part.text;
          const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined;
          const offset = text[kind].length;
          if (config.textSemantics === 'cumulative') {
            if (sealed[kind] || !incoming.startsWith(text[kind])) throw outputError();
            // Keep a cumulative signature with its entire snapshot, never a suffix or revision.
            if (signature !== undefined && offset && (!block || block.kind !== kind || block.offset !== 0)) throw outputError();
          }
          const delta = config.textSemantics === 'cumulative' ? incoming.slice(offset) : incoming;
          text[kind] = config.textSemantics === 'cumulative' ? incoming : text[kind] + incoming;
          textBytes += Buffer.byteLength(delta);
          if (textBytes > 1_048_576) throw outputError();
          if (block && (block.kind !== kind || (config.textSemantics === 'delta' && signature !== undefined))) {
            const end = endBlock(); if (end) yield end;
          }
          if (!block) {
            block = { kind, id: `${kind}-${blockIndex++}`, offset };
            yield { type: kind === 'text' ? 'text-start' : 'reasoning-start', id: block.id };
          }
          if (delta) yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', id: block.id, text: delta };
          if (signature !== undefined) {
            block.signature = signature;
            sealed[kind] = true;
            const end = endBlock(); if (end) yield end;
          }
        } else if (part.functionCall && typeof part.functionCall === 'object' && !Array.isArray(part.functionCall)
          && Object.keys(part).every(key => key === 'functionCall' || key === 'thoughtSignature')) {
          const end = endBlock(); if (end) yield end;
          const call = part.functionCall;
          const name = typeof call.name === 'string' ? lowered.names.get(call.name) : undefined;
          const args = call.args === undefined ? {} : call.args;
          if (!name || !args || typeof args !== 'object' || Array.isArray(args)) throw outputError();
          const fingerprint = canonical([name, args]);
          callBytes += Buffer.byteLength(fingerprint);
          if (callBytes > 1_048_576 || calls.length >= 256) throw outputError();
          if (idlessCalls.has(fingerprint) || (call.id === undefined && fingerprints.has(fingerprint))) throw outputError();
          if (call.id === undefined) idlessCalls.add(fingerprint);
          fingerprints.add(fingerprint);
          const id = typeof call.id === 'string' ? call.id : randomUUID();
          if (callIds.has(id)) throw outputError();
          callIds.add(id); called = true;
          const providerMetadata = typeof part.thoughtSignature === 'string' ? { offlineInference: { thoughtSignature: part.thoughtSignature } } : undefined;
          calls.push({ type: 'tool-call', id, name, input: args, ...(providerMetadata ? { providerMetadata } : {}) });
        } else throw outputError();
      }
      if (candidate.finishReason && candidate.finishReason !== 'FINISH_REASON_UNSPECIFIED') reason = candidate.finishReason;
    }
    if (chunk.usage !== undefined) {
      const incomingUsage = chunk.usage;
      if (usageSnapshot !== undefined && (config.usageSemantics === 'single-report'
        || Object.entries(usageSnapshot).some(([key, count]) => incomingUsage[key] === undefined || incomingUsage[key] < count))) {
        throw new OfflineInferenceError('unsupported', 'native_usage');
      }
      usageSnapshot = incomingUsage;
      usage = new Usage({
        ...(chunk.usage.promptTokenCount === undefined ? {} : { inputTokens: chunk.usage.promptTokenCount }),
        ...(chunk.usage.totalTokenCount === undefined ? {} : { totalTokens: chunk.usage.totalTokenCount }),
        providerMetadata: { offlineInference: { ...chunk.usage } },
      });
    }
  }
  if (!reason || signal.aborted || (called && reason !== 'STOP')) throw outputError();
  const end = endBlock(); if (end) yield end;
  for (const call of calls) yield call;
  const normalized = reason === 'STOP' ? (called ? 'tool-calls' : 'stop') : reason === 'MAX_TOKENS' ? 'length'
    : ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MODEL_ARMOR', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'].includes(reason) ? 'content-filter' : 'unknown';
  const finish = { reason: { normalized, raw: reason }, ...(usage === undefined ? {} : { usage }) } as const;
  yield { type: 'step-finish', index: 0, ...finish };
  yield { type: 'finish', ...finish };
}

export function createOfflineModel(config: OfflineModelConfig): LanguageModel {
  try {
    if (!config || typeof config !== 'object') invalid();
    fields(config, ['provider', 'model', 'project', 'requestId', 'textSemantics', 'usageSemantics', 'transport', 'localIdentity']);
    if (Object.getPrototypeOf(config) !== Object.prototype || Reflect.ownKeys(config).some(key => typeof key !== 'string' || !['provider', 'model', 'project', 'requestId', 'textSemantics', 'usageSemantics', 'transport', 'localIdentity'].includes(key))) invalid();
    for (const key of ['provider', 'model', ...(Object.hasOwn(config, 'project') ? ['project'] as const : [])] as const) {
      if (typeof config[key] !== 'string' || !config[key].trim() || config[key].length > 512 || /[\u0000-\u001f\u007f]/u.test(config[key])) invalid();
    }
    if (typeof config.requestId !== 'function' && (typeof config.requestId !== 'string' || !config.requestId.trim() || config.requestId.length > 512 || /[\u0000-\u001f\u007f]/u.test(config.requestId))) invalid();
    if (config.localIdentity !== undefined && typeof config.localIdentity !== 'boolean') invalid();
    if (!['delta', 'cumulative'].includes(config.textSemantics) || !['single-report', 'cumulative-snapshot'].includes(config.usageSemantics) || typeof config.transport !== 'function') invalid();
    const snapshot = Object.freeze({ ...config });
    const protocol = Protocol.make({
      id: 'offline-inference',
      body: { schema: Schema.Unknown, from: (request: LLMRequest) => Effect.try({
        try: () => lower(request, snapshot),
        catch: error => {
          const stage = error instanceof NativeInputError && inputStages.includes(error.stage) ? error.stage : 'input';
          const fingerprint = (request.messages ?? []).slice(0, 64).map(message => ({
            role: message.role,
            parts: (message.content ?? []).slice(0, 16).map(raw => {
              const part = raw as { type?: unknown; text?: unknown; providerMetadata?: unknown };
              return {
                type: part.type, text: typeof part.text, empty: part.text === '', keys: Object.keys(raw),
                ...(part.providerMetadata && typeof part.providerMetadata === 'object' ? { meta: Object.keys(part.providerMetadata) } : {}),
              };
            }),
          }));
          console.warn('Antigravity inference input rejected:', JSON.stringify({ stage, tools: (request.tools ?? []).length, system: (request.system ?? []).length, messages: fingerprint }).slice(0, 16000));
          return new AIError({ reason: new InvalidRequestError({ message: `Offline model: unsupported or invalid input (offline_stage=${stage})` }) });
        },
      }) },
      stream: { event: Schema.toType(LLMEvent), initial: () => undefined,
        step: (_state: undefined, event: LLMEvent) => Effect.succeed([undefined, [event]] as const),
      },
    });
    const route = Route.make({
      id: 'offline-inference', provider: snapshot.provider, providerMetadataKey: 'offlineInference', protocol,
      endpoint: { path: '/offline-only' },
      transport: {
        id: 'injected-offline', prepare: ({ body }) => Effect.succeed(body),
        execute: input => Effect.gen(function* () {
          const controller = yield* Effect.acquireRelease(Effect.sync(() => new AbortController()), controller => Effect.sync(() => controller.abort()));
          return { frames: Stream.fromAsyncIterable(events(input as Lowered, snapshot, controller.signal), outputError) };
        }),
      },
    });
    return LanguageModel.make({ id: snapshot.model, provider: snapshot.provider, route });
  } catch { invalid(); }
}
