import { createHash } from 'node:crypto';
import { Model } from '@opencode/plugin';
import { Schema } from 'effect';
import { buildAuthorizationUrl } from './oauth-workbench.js';
import { AGY_CONSUMER_CLIENT_ID } from './local-oauth-client.js';
import { localCliUserAgent } from './configured-user-agent.js';
import { inferenceDeadline, inferenceTimeout, type InferenceTimeout } from './inference-timeout.js';
import { OfflineInferenceError } from './offline-inference.js';

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;
export interface OAuthConfiguration {
  authorizationAcknowledged: true;
  integrationId: string;
  name: string;
  oauth: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; clientId: string; redirectUri: string; scopes: readonly string[] };
}
export interface PublicOAuthConfiguration extends OAuthConfiguration {
  mode: 'agy-public-oauth';
}
export interface LocalOAuthConfiguration extends OAuthConfiguration {
  mode: 'agy-local-oauth';
  quotaBridge?: { port: number; apiKeyEnv: string; autoKey: boolean; shared: boolean };
  publishQuota?: true;
}
export type PresetOAuthConfiguration = PublicOAuthConfiguration | LocalOAuthConfiguration;
export interface Configuration extends OAuthConfiguration {
  providerId: string;
  inference: { endpoint: string; project: string; textSemantics: 'delta' | 'cumulative'; usageSemantics: 'single-report' | 'cumulative-snapshot' };
  models: readonly Model.Info[];
}

export function rejectConfigured(): never { throw new Error('Configured OAuth integration: invalid or unsupported operation'); }

class QuotaBridgeOptionError extends Error {}
class QuotaPublicationOptionError extends Error {}

function publishQuotaOption(value: unknown, mode: PresetOAuthConfiguration['mode']): true | undefined {
  if (value === undefined || value === false) return undefined;
  if (mode !== 'agy-local-oauth') throw new QuotaPublicationOptionError('Antigravity publishQuota is available only in agy-local-oauth mode.');
  if (value !== true) throw new QuotaPublicationOptionError('Antigravity publishQuota must be true.');
  return true;
}

// Setting these for the whole plugin lifetime would change process resolution rather than carry a quota key.
const reservedEnvironmentNames = ['PATH', 'HOME', 'HOSTNAME', 'SHELL', 'ENV', 'PROMPT_COMMAND', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_OPTIONS',
  'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'];

function optionLabel(key: string | symbol): string {
  return typeof key === 'symbol' ? 'symbol key' : key.replace(/[^\x20-\x7e]/gu, '?').slice(0, 64);
}

function quotaBridgeOption(value: unknown, mode: PresetOAuthConfiguration['mode']): { port: number; apiKeyEnv: string; autoKey: boolean; shared: boolean } | undefined {
  if (value === undefined || value === false) return undefined;
  if (mode !== 'agy-local-oauth') throw new QuotaBridgeOptionError('Antigravity quotaBridge is available only in agy-local-oauth mode.');
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new QuotaBridgeOptionError('Antigravity quotaBridge requires port and apiKeyEnv.');
  }
  for (const key of Reflect.ownKeys(value)) if (typeof key !== 'string' || !['port', 'apiKeyEnv', 'autoKey', 'shared'].includes(key) || Object.getOwnPropertyDescriptor(value, key)!.get) {
    throw new QuotaBridgeOptionError(`Antigravity quotaBridge does not accept the option "${optionLabel(key)}".`);
  }
  const { port, apiKeyEnv, autoKey, shared } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new QuotaBridgeOptionError('Antigravity quotaBridge requires port 1-65535.');
  if (typeof apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new QuotaBridgeOptionError('Antigravity quotaBridge requires apiKeyEnv as an environment variable name.');
  if (reservedEnvironmentNames.includes(apiKeyEnv)) throw new QuotaBridgeOptionError('Antigravity quotaBridge apiKeyEnv cannot name a process-wide environment variable.');
  if (autoKey !== undefined && typeof autoKey !== 'boolean') throw new QuotaBridgeOptionError('Antigravity quotaBridge autoKey must be a boolean.');
  if (shared !== undefined && typeof shared !== 'boolean') throw new QuotaBridgeOptionError('Antigravity quotaBridge shared must be a boolean.');
  return Object.freeze({ port: Number(port), apiKeyEnv, autoKey: autoKey !== false, shared: shared === true });
}

const diagnosticStages = ['authorization_input', 'local_client', 'token_request', 'token_response', 'response_read', 'token_validation', 'credential_binding'] as const;
const diagnosticReasons = ['invalid', 'network', 'timeout', 'aborted', 'http_error', 'redirect', 'destination', 'body', 'json',
  'unsupported_response_fields', 'schema', 'token_type', 'access_token', 'expires_in', 'refresh_token', 'scope', 'unreadable', 'invalid_client_configuration', 'reauthorization_required'] as const;
const oauthErrors = ['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type',
  'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error', 'unknown'] as const;
export type OAuthDiagnosticReason = typeof diagnosticReasons[number];

export class PublicOAuthDiagnostic extends Error {
  readonly stage: typeof diagnosticStages[number];
  readonly reason: OAuthDiagnosticReason;
  readonly status: number | undefined;
  readonly oauthError: typeof oauthErrors[number] | undefined;
  constructor(stage: typeof diagnosticStages[number], reason: OAuthDiagnosticReason, status?: number, oauthError?: unknown, localClient = false) {
    const safeStage = diagnosticStages.includes(stage) ? stage : 'token_validation';
    const safeReason = diagnosticReasons.includes(reason) ? reason : 'schema';
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const safeError = oauthError === undefined ? undefined : oauthErrors.find(value => value === oauthError) ?? 'unknown';
    const prefix = localClient === true ? 'Local OAuth diagnostic:' : safeError === 'invalid_client'
      ? 'Public OAuth client rejected (invalid_client); secretless compatibility is unverified;'
      : 'Public OAuth diagnostic:';
    super(`${prefix} stage=${safeStage} reason=${safeReason}${safeStatus === undefined ? '' : ` http_status=${safeStatus}`}${safeError === undefined ? '' : ` oauth_error=${safeError}`}${localClient === true && safeReason === 'reauthorization_required' ? '; Authorize again using "Google Antigravity" to consent to the updated scopes.' : ''}`);
    this.stage = safeStage; this.reason = safeReason; this.status = safeStatus; this.oauthError = safeError;
  }
}

export function rejectOAuth(error: unknown): never {
  if (error instanceof PublicOAuthDiagnostic) throw error;
  return rejectConfigured();
}

export function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) rejectConfigured();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !allowed.includes(key) || descriptor.get || descriptor.set) rejectConfigured();
  }
  return value as Record<string, unknown>;
}

export function configuredText(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[^\x20-\x7e]/u.test(value)) rejectConfigured();
  return value;
}

export function endpoint(value: unknown, allowQuery = false): string {
  const input = configuredText(value, 8192);
  if (/[\\#]/u.test(input) || (!allowQuery && input.includes('?'))) rejectConfigured();
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== input) rejectConfigured();
  for (const key of url.searchParams.keys()) if (/^(?:access_token|refresh_token|id_token|token|key|api_key|client_secret|code)$/iu.test(key)) rejectConfigured();
  return input;
}

function parseConfiguration(value: unknown): Configuration {
  try {
    let nodes = 0, bytes = 0;
    const snapshot = (item: unknown, depth = 0): unknown => {
      if (++nodes > 10000 || depth > 16) rejectConfigured();
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'number') { if (!Number.isFinite(item)) rejectConfigured(); return item; }
      if (typeof item === 'string') { bytes += Buffer.byteLength(item); if (bytes > 262144) rejectConfigured(); return item; }
      if (!item || typeof item !== 'object') rejectConfigured();
      const array = Array.isArray(item);
      if (array && (item.length > 10000 || Reflect.ownKeys(item).length !== item.length + 1)) rejectConfigured();
      if (!array && Object.getPrototypeOf(item) !== Object.prototype) rejectConfigured();
      const result: Record<string, unknown> | unknown[] = array ? [] : {};
      for (const key of Reflect.ownKeys(item)) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || descriptor.get || descriptor.set
          || (array && !/^(0|[1-9][0-9]*)$/u.test(key))) rejectConfigured();
        bytes += Buffer.byteLength(key);
        if (bytes > 262144) rejectConfigured();
        Object.defineProperty(result, key, { value: snapshot(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
      return result;
    };
    value = snapshot(value);
    const root = record(value, ['authorizationAcknowledged', 'providerId', 'integrationId', 'name', 'oauth', 'inference', 'models']);
    if (root.authorizationAcknowledged !== true) rejectConfigured();
    const oauth = record(root.oauth, ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'clientId', 'redirectUri', 'scopes']);
    const inference = record(root.inference, ['endpoint', 'project', 'textSemantics', 'usageSemantics']);
    const providerId = configuredText(root.providerId), integrationId = configuredText(root.integrationId);
    if (![providerId, integrationId].every(v => /^[a-z][a-z0-9-]{1,63}$/u.test(v))) rejectConfigured();
    const issuer = configuredText(oauth.issuer);
    if (new URL(issuer).origin !== issuer || new URL(issuer).protocol !== 'https:') rejectConfigured();
    for (const key of ['authorizationEndpoint', 'tokenEndpoint'] as const) endpoint(oauth[key]);
    endpoint(oauth.redirectUri);
    if (!Array.isArray(oauth.scopes)) rejectConfigured();
    buildAuthorizationUrl({ authorizationEndpoint: oauth.authorizationEndpoint as string, clientId: configuredText(oauth.clientId, 256),
      redirectUri: oauth.redirectUri as string, scopes: oauth.scopes, state: 'synthetic-validation-state-123', verifier: 'v'.repeat(43) });
    endpoint(inference.endpoint, true); configuredText(inference.project);
    if (!['delta', 'cumulative'].includes(inference.textSemantics as string) || !['single-report', 'cumulative-snapshot'].includes(inference.usageSemantics as string)) rejectConfigured();
    if (!Array.isArray(root.models) || !root.models.length || root.models.length > 64) rejectConfigured();
    const models = root.models.map(value => {
      const entry = record(value, ['id', 'modelID', 'providerID', 'name', 'capabilities', 'variants', 'time', 'cost', 'status', 'enabled', 'limit']);
      const model = Schema.decodeUnknownSync(Model.Info)(entry, { onExcessProperty: 'error' });
      configuredText(model.id); configuredText(model.name);
      if (model.providerID !== providerId || model.modelID !== model.id || model.variants.length || model.capabilities.tools
        || JSON.stringify(model.capabilities.input) !== '["text"]' || JSON.stringify(model.capabilities.output) !== '["text"]'
        || model.limit.context <= 0 || model.limit.output <= 0) rejectConfigured();
      return model;
    });
    if (new Set(models.map(m => m.id)).size !== models.length) rejectConfigured();
    const config = JSON.parse(JSON.stringify({ authorizationAcknowledged: true, providerId, integrationId, name: configuredText(root.name), oauth, inference, models })) as Configuration;
    const freeze = (value: object): void => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); };
    freeze(config);
    return config;
  } catch { return rejectConfigured(); }
}

const reviewedScopes: readonly string[] = Object.freeze(['openid', 'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog', 'https://www.googleapis.com/auth/experimentsandconfigs', 'https://www.googleapis.com/auth/aicode']);

function validatePresetOAuthConfiguration<M extends PresetOAuthConfiguration['mode']>(value: unknown, mode: M): OAuthConfiguration & { mode: M; quotaBridge?: { port: number; apiKeyEnv: string; autoKey: boolean; shared: boolean }; publishQuota?: true } {
  try {
    const options = record(value, ['mode', 'authorizationAcknowledged', 'quotaBridge', 'publishQuota']);
    if (options.mode !== mode || options.authorizationAcknowledged !== true) rejectConfigured();
    const quotaBridge = quotaBridgeOption(options.quotaBridge, mode);
    const publishQuota = publishQuotaOption(options.publishQuota, mode);
    return Object.freeze({ mode, authorizationAcknowledged: true,
      integrationId: mode, name: mode === 'agy-local-oauth' ? 'Google Antigravity' : 'Antigravity public OAuth (experimental, login only)',
      ...(quotaBridge ? { quotaBridge } : {}),
      ...(publishQuota ? { publishQuota } : {}),
      oauth: Object.freeze({ issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        clientId: AGY_CONSUMER_CLIENT_ID,
        redirectUri: 'https://antigravity.google/oauth-callback',
        scopes: Object.freeze([...['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(scope => `https://www.googleapis.com/auth/${scope}`),
          ...(mode === 'agy-local-oauth' ? ['https://www.googleapis.com/auth/aicode', 'openid'] : [])]),
      }),
    });
  } catch (error) { if (error instanceof QuotaBridgeOptionError || error instanceof QuotaPublicationOptionError) throw error; return rejectConfigured(); }
}

export function validatePublicOAuthConfiguration(value: unknown): PublicOAuthConfiguration {
  return validatePresetOAuthConfiguration(value, 'agy-public-oauth');
}

export function validateLocalOAuthConfiguration(value: unknown): LocalOAuthConfiguration {
  return validatePresetOAuthConfiguration(value, 'agy-local-oauth');
}

export function validateProductionConfiguration(value: unknown): Configuration | PresetOAuthConfiguration {
  const mode = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'mode') : undefined;
  if (mode && 'value' in mode) {
    if (mode.value === 'agy-public-oauth') return validatePublicOAuthConfiguration(value);
    if (mode.value === 'agy-local-oauth') return validateLocalOAuthConfiguration(value);
  }
  return validateConfiguration(value);
}

export function validateConfiguration(value: unknown): Configuration {
  const config = parseConfiguration(value);
  if (config.oauth.issuer !== 'https://accounts.google.com'
    || config.oauth.authorizationEndpoint !== 'https://accounts.google.com/o/oauth2/v2/auth'
    || config.oauth.tokenEndpoint !== 'https://oauth2.googleapis.com/token'
    || config.oauth.redirectUri !== 'https://antigravity.google/oauth-callback'
    || !config.oauth.scopes.every(scope => reviewedScopes.includes(scope))
    || !['https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
      'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'].includes(config.inference.endpoint)) rejectConfigured();
  return config;
}

export function validateSyntheticConfiguration(value: unknown): Configuration {
  const config = parseConfiguration(value);
  for (const destination of [config.oauth.issuer, config.oauth.authorizationEndpoint, config.oauth.tokenEndpoint, config.oauth.redirectUri, config.inference.endpoint]) {
    if (!/\.(?:invalid|example)$/u.test(new URL(destination).hostname)) rejectConfigured();
  }
  if ([config.oauth.authorizationEndpoint, config.oauth.tokenEndpoint].some(url => new URL(url).origin !== config.oauth.issuer)) rejectConfigured();
  return config;
}

export function binding(config: Configuration | PresetOAuthConfiguration): string {
  if ('mode' in config) return createHash('sha256').update(JSON.stringify([config.mode, config.integrationId, config.oauth])).digest('hex');
  return createHash('sha256').update(JSON.stringify([config.providerId, config.integrationId, config.oauth, config.inference, config.models.map(model => model.id)])).digest('hex');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('Configured HTTP operation cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(v => { cleanup(); resolve(v); }, () => { cleanup(); reject(new Error('Configured HTTP operation failed')); });
    if (signal.aborted) abort();
  });
}

export function createHTTP(fetcher: Fetch) {
  if (typeof fetcher !== 'function') rejectConfigured();
  async function open(url: string, init: RequestInit, signal: AbortSignal, mode: 'strict' | 'oauth' | 'inference' = 'strict', localClient = false, attempt = 1): Promise<Response> {
    endpoint(url, true);
    if (signal.aborted) rejectConfigured();
    const response = await abortable(Promise.resolve().then(() => fetcher(url, { ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal })).then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    }), signal);
    if ((!response.ok && mode !== 'oauth') || response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
      if (mode === 'oauth') {
        void response.body?.cancel().catch(() => {});
        throw new PublicOAuthDiagnostic('token_response', response.url && response.url !== url ? 'destination' : 'redirect', response.status, undefined, localClient);
      }
      if (mode === 'inference' && !response.ok && !response.redirected && !(response.status >= 300 && response.status < 400) && (!response.url || response.url === url)) {
        const stage = response.status === 400 ? 'http_400' : response.status === 401 ? 'http_401'
          : response.status === 403 ? 'http_403' : response.status === 429 ? await inference429Stage(response, signal)
          : response.status >= 500 && response.status < 600 ? 'http_5xx' : 'http_error';
        void response.body?.cancel().catch(() => {});
        if (localClient && attempt < 3 && ['http_429', 'http_429_rate', 'http_5xx'].includes(stage)) {
          const delay = retryDelay(response.headers, attempt, stage === 'http_429_rate');
          if (delay !== undefined) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), signal);
            } finally { if (timer !== undefined) clearTimeout(timer); }
            return open(url, init, signal, mode, localClient, attempt + 1);
          }
        }
        throw new OfflineInferenceError('remote', stage);
      }
      void response.body?.cancel().catch(() => {});
      rejectConfigured();
    }
    return response;
  }
  function retryDelay(headers: Headers, attempt: number, rateLimited: boolean): number | undefined {
    const milliseconds = headers.get('retry-after-ms');
    const secondsOrDate = headers.get('retry-after');
    let delay = rateLimited ? 10000 : 5000 * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6);
    if (milliseconds !== null && /^\d+(?:\.\d+)?$/u.test(milliseconds)) delay = Number(milliseconds);
    else if (secondsOrDate !== null) {
      const parsed = /^\d+(?:\.\d+)?$/u.test(secondsOrDate) ? Number(secondsOrDate) * 1000 : Date.parse(secondsOrDate) - Date.now();
      if (Number.isFinite(parsed)) delay = Math.max(0, parsed);
    }
    return Number.isFinite(delay) && delay <= 30000 ? Math.round(delay) : undefined;
  }
  async function* read(response: Response, signal: AbortSignal, maxBytes: number, deadline?: { controller: AbortController; chunk?: number | false }): AsyncGenerator<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) rejectConfigured();
    let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        const clear = deadline ? inferenceDeadline(deadline.controller, deadline.chunk) : () => {};
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await abortable(reader.read(), signal); } finally { clear(); }
        if (signal.aborted) rejectConfigured();
        if (part.done) return;
        size += part.value.byteLength;
        if (size > maxBytes) rejectConfigured();
        yield part.value;
      }
    } finally {
      signal.removeEventListener('abort', cancel); cancel();
      try { reader.releaseLock(); } catch { /* A caller-supplied stream may retain a pending read after cancellation. */ }
    }
  }
  async function inference429Stage(response: Response, signal: AbortSignal): Promise<'http_429' | 'http_429_capacity' | 'http_429_quota' | 'http_429_rate'> {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (mime !== 'application/json' && mime !== 'text/event-stream') return 'http_429';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const buffers: Uint8Array[] = [];
      for await (const chunk of read(response, AbortSignal.any([signal, controller.signal]), 16_384)) buffers.push(chunk);
      let text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers));
      if (mime === 'text/event-stream' && !['{', '['].includes(text.trimStart()[0] ?? '')) {
        const events = text.split(/\r?\n\r?\n/u).map(event => event.split(/\r?\n/u)
          .filter(line => line === 'data' || line.startsWith('data:'))).filter(lines => lines.length)
          .map(lines => lines.map(line => line.slice(5).replace(/^ /u, '')).join('\n'));
        if (events.length !== 1) return 'http_429';
        text = events[0]!;
      }
      const parsed: unknown = JSON.parse(text);
      const body: unknown = Array.isArray(parsed) ? parsed.length === 1 ? parsed[0] : undefined : parsed;
      if (!body || typeof body !== 'object' || !('error' in body)) return 'http_429';
      const error = body.error;
      if (!error || typeof error !== 'object' || !('details' in error) || !Array.isArray(error.details)) return 'http_429';
      const details = error.details.filter((value: unknown) => value && typeof value === 'object'
        && '@type' in value && value['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
      if (details.length !== 1) return 'http_429';
      switch (details[0].reason) {
        case 'MODEL_CAPACITY_EXHAUSTED': return 'http_429_capacity';
        case 'QUOTA_EXHAUSTED': return 'http_429_quota';
        case 'RATE_LIMIT_EXCEEDED': return 'http_429_rate';
        default: return 'http_429';
      }
    } catch { return 'http_429'; }
    finally { clearTimeout(timer); controller.abort(); }
  }
  return {
    async json(url: string, body: URLSearchParams, signal: AbortSignal, publicOAuth: boolean | 'local' = false, onStatus?: (status: number) => void): Promise<unknown> {
      const diagnostic = publicOAuth && url === 'https://oauth2.googleapis.com/token';
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      let stage: 'token_request' | 'response_read' = 'token_request', reason: OAuthDiagnosticReason = 'network', status: number | undefined;
      try {
        const response = await open(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() }, bounded,
          diagnostic ? 'oauth' : 'strict', publicOAuth === 'local');
        status = response.status; onStatus?.(status);
        stage = 'response_read'; reason = 'body';
        const buffers: Uint8Array[] = [];
        for await (const chunk of read(response, bounded, 65_536)) buffers.push(chunk);
        reason = 'json';
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)));
        if (!response.ok) {
          if (diagnostic) throw new PublicOAuthDiagnostic('token_response', 'http_error', status,
            value && typeof value === 'object' && !Array.isArray(value) && 'error' in value ? value.error : 'unknown', publicOAuth === 'local');
          rejectConfigured();
        }
        return value;
      } catch (error) {
        if (diagnostic && !(error instanceof PublicOAuthDiagnostic)) throw new PublicOAuthDiagnostic(stage, bounded.aborted ? signal.aborted ? 'aborted' : 'timeout' : reason, status, undefined, publicOAuth === 'local');
        return rejectOAuth(error);
      }
    },
    async *stream(url: string, body: string, access: string, signal: AbortSignal, localClient = false, requestTimeout?: InferenceTimeout): AsyncGenerator<Uint8Array> {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      let clearTotal = () => {}, clearHeaders = () => {};
      try {
        if (!/^[\x21-\x7e]{1,32768}$/u.test(access) || Buffer.byteLength(body) > 1_048_576) rejectConfigured();
        const timeout = inferenceTimeout(requestTimeout);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) controller.abort();
        clearTotal = inferenceDeadline(controller, timeout === undefined ? 120_000 : timeout.total);
        clearHeaders = inferenceDeadline(controller, timeout?.headers);
        const response = await open(url, { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(localClient ? { 'User-Agent': configuredText(localCliUserAgent('1.5.8')) } : {}) }, body }, controller.signal, 'inference', localClient);
        clearHeaders();
        yield* read(response, controller.signal, 16 * 1_048_576, { controller, chunk: timeout?.chunk });
      } catch (error) { if (error instanceof OfflineInferenceError) throw error; rejectConfigured(); }
      finally { clearHeaders(); clearTotal(); signal.removeEventListener('abort', cancel); controller.abort(); }
    },
  };
}
