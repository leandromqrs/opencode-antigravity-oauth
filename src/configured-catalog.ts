import { Model, Provider } from '@opencode/plugin';
import type { Fetch } from './configured-security.js';
import { localCliUserAgent } from './configured-user-agent.js';

export const LOCAL_PROVIDER_ID = 'antigravity-local';
export const LOCAL_INFERENCE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const origin = 'https://daily-cloudcode-pa.googleapis.com';
const stages = ['loadCodeAssist', 'onboardUser', 'operation', 'fetchAvailableModels', 'inference'] as const;
const reasons = ['network', 'aborted', 'timeout', 'http_error', 'redirect', 'body', 'json', 'schema', 'eligibility', 'no_models', 'project_required'] as const;
type Stage = typeof stages[number];
type Reason = typeof reasons[number];
const serviceErrors = ['PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'INVALID_ARGUMENT', 'FAILED_PRECONDITION', 'UNAVAILABLE', 'INTERNAL', 'NOT_FOUND', 'INSUFFICIENT_SCOPE'] as const;
const serviceReasons = ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SERVICE_DISABLED', 'CONSUMER_INVALID', 'ACCESS_DENIED', 'IAM_PERMISSION_DENIED', 'SECURITY_POLICY_VIOLATED'] as const;
const ineligibleReasonCodes = ['UNKNOWN', 'INELIGIBLE_ACCOUNT', 'UNKNOWN_LOCATION', 'UNSUPPORTED_LOCATION', 'RESTRICTED_NETWORK', 'RESTRICTED_AGE',
  'NON_USER_ACCOUNT', 'DASHER_USER', 'BYOID_USER', 'RESTRICTED_DASHER_USER', 'VALIDATION_REQUIRED', 'GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT', 'UNSUPPORTED_CLIENT'] as const;
interface EligibilityDiagnostic {
  source?: unknown;
  projectStatusCode?: unknown;
  ineligibleReasonCodes?: unknown;
}
const fallbackProjects = new WeakMap<CatalogDiagnostic, string>();

export function getCatalogFallbackProject(error: unknown): string | undefined {
  return error instanceof CatalogDiagnostic ? fallbackProjects.get(error) : undefined;
}

export class CatalogDiagnostic extends Error {
  readonly stage: Stage;
  readonly reason: Reason;
  readonly status: number | undefined;
  readonly excluded: number | undefined;
  readonly serviceError: typeof serviceErrors[number] | 'unknown' | undefined;
  readonly serviceReason: typeof serviceReasons[number] | 'unknown' | undefined;
  readonly eligibilitySource: 'projectValidationError' | 'ineligibleTiers' | undefined;
  readonly projectStatusCode: number | undefined;
  readonly ineligibleReasonCodes: readonly typeof ineligibleReasonCodes[number][];
  constructor(stage: Stage, reason: Reason, status?: number, error?: unknown, excluded?: number, eligibility?: EligibilityDiagnostic, serviceReason?: unknown) {
    const safeStage = stages.find(value => value === stage) ?? 'fetchAvailableModels';
    const safeReason = reasons.find(value => value === reason) ?? 'schema';
    const safeStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const safeExcluded = typeof excluded === 'number' && Number.isInteger(excluded) && excluded >= 0 && excluded <= 2048 ? excluded : undefined;
    const safeError = error === undefined ? undefined : serviceErrors.find(value => value === error) ?? 'unknown';
    const safeServiceReason = serviceReason === undefined ? undefined : serviceReasons.find(value => value === serviceReason) ?? 'unknown';
    const input = object(eligibility);
    const source = input?.source === 'projectValidationError' || input?.source === 'ineligibleTiers' ? input.source : undefined;
    const code = input?.projectStatusCode;
    const safeCode = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 16 ? code : undefined;
    const safeReasons = Array.isArray(input?.ineligibleReasonCodes) ? [...new Set(input.ineligibleReasonCodes.slice(0, 256).flatMap(value => {
      const known = typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < ineligibleReasonCodes.length
        ? ineligibleReasonCodes[value] : ineligibleReasonCodes.find(code => code === value);
      return known === undefined ? [] : [known];
    }))] : [];
    super(`Antigravity catalog: stage=${safeStage} reason=${safeReason}${safeStatus === undefined ? '' : ` http_status=${safeStatus}`}${safeError === undefined ? '' : ` service_error=${safeError}`}${safeServiceReason === undefined ? '' : ` service_reason=${safeServiceReason}`}${safeExcluded === undefined ? '' : ` excluded_models=${safeExcluded}`}${source === undefined ? '' : ` eligibility_source=${source}`}${safeCode === undefined ? '' : ` project_status=${safeCode}`}${safeReasons.length ? ` ineligible_reasons=${safeReasons.join(',')}` : ''}`);
    this.stage = safeStage; this.reason = safeReason; this.status = safeStatus; this.excluded = safeExcluded; this.serviceError = safeError;
    this.serviceReason = safeServiceReason;
    this.eligibilitySource = source; this.projectStatusCode = safeCode; this.ineligibleReasonCodes = Object.freeze(safeReasons);
  }
}

export interface Catalog {
  project?: string;
  models: readonly Model.Info[];
  excluded: number;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function serviceReason(error: Record<string, unknown> | undefined, nonSuccess = false): unknown {
  const info = Array.isArray(error?.details)
    ? error.details.map(object).find(detail => detail?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo') : undefined;
  if (info) return info.reason ?? 'unknown';
  if (nonSuccess && (error?.message === 'Request had insufficient authentication scopes.' || error?.message === 'Request had insufficient authentication scopes')) return 'ACCESS_TOKEN_SCOPE_INSUFFICIENT';
  return undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/u.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
}

function boundedJSON(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const pending: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++nodes > 50_000 || depth > 32) throw new Error();
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return value;
}

function decodeModels(value: unknown): Pick<Catalog, 'models' | 'excluded'> {
  const root = object(value), entries = object(root?.models);
  if (!root || !entries || Object.keys(entries).length > 2048) throw new CatalogDiagnostic('fetchAvailableModels', 'schema');
  const agent = new Set<string>(), nonChat = new Set<string>();
  if (identifier(root.defaultAgentModelId)) agent.add(root.defaultAgentModelId);
  if (Array.isArray(root.agentModelSorts)) for (const sort of root.agentModelSorts) {
    const groups = object(sort)?.groups;
    if (Array.isArray(groups)) for (const group of groups) {
      const ids = object(group)?.modelIds;
      if (Array.isArray(ids)) for (const id of ids) if (identifier(id)) agent.add(id);
    }
  }
  for (const field of ['imageGenerationModelIds', 'audioTranscriptionModelIds']) {
    const ids = root[field];
    if (Array.isArray(ids)) for (const id of ids) if (identifier(id)) nonChat.add(id);
  }
  const models: Model.Info[] = [];
  for (const [id, raw] of Object.entries(entries)) {
    const detail = object(raw);
    if (!identifier(id) || !agent.has(id) || nonChat.has(id) || !detail || (detail.disabled !== undefined && detail.disabled !== false)
      || typeof detail.maxTokens !== 'number' || !Number.isSafeInteger(detail.maxTokens) || detail.maxTokens <= 0 || detail.maxTokens > 2147483647
      || typeof detail.maxOutputTokens !== 'number' || !Number.isSafeInteger(detail.maxOutputTokens) || detail.maxOutputTokens <= 0 || detail.maxOutputTokens > 2147483647) continue;
    const name = typeof detail.displayName === 'string' && detail.displayName.trim() && detail.displayName.length <= 512 && !/[\x00-\x1f\x7f]/u.test(detail.displayName) ? detail.displayName : id;
    models.push({ id: Model.ID.make(id), modelID: Model.ID.make(id), providerID: Provider.ID.make(LOCAL_PROVIDER_ID), name,
      capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true,
      limit: { context: detail.maxTokens, output: detail.maxOutputTokens } });
  }
  return { models: groupEffortModels(models), excluded: Object.keys(entries).length - models.length };
}

const effortLevels = ['minimal', 'low', 'medium', 'high'] as const;
type Effort = typeof effortLevels[number];

function splitEffort(id: string): { base: string; effort: Effort } | undefined {
  for (const effort of effortLevels) {
    const suffix = `-${effort}`;
    if (id.endsWith(suffix) && id.length > suffix.length) return { base: id.slice(0, -suffix.length), effort };
  }
  return undefined;
}

export function groupEffortModels(flat: readonly Model.Info[]): Model.Info[] {
  const groups = new Map<string, Map<Effort, Model.Info>>();
  const passthrough: Model.Info[] = [];
  for (const model of flat) {
    const split = splitEffort(model.id);
    if (!split) { passthrough.push(model); continue; }
    let group = groups.get(split.base);
    if (!group) { group = new Map(); groups.set(split.base, group); }
    group.set(split.effort, model);
  }
  const result = passthrough.filter(model => !groups.has(model.id));
  for (const [base, group] of groups) {
    const defaultEffort = (['medium', 'high', 'low', 'minimal'] as const).find(effort => group.has(effort))!;
    const template = group.get(defaultEffort)!;
    result.push({ ...template, id: Model.ID.make(base), modelID: Model.ID.make(base),
      name: template.name.replace(new RegExp(`\\s*\\(${defaultEffort}\\)(?=\\s|$)`, 'i'), ''),
      settings: { antigravityModel: template.id },
      variants: effortLevels.filter(effort => group.has(effort)).map(effort => ({ id: Model.VariantID.make(effort), settings: { antigravityModel: group.get(effort)!.id } })),
    });
  }
  return result;
}

export function createCatalogClient(fetcher: Fetch, signal: AbortSignal, timeoutMs = 60_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Invalid catalog timeout');
  async function request(stage: 'loadCodeAssist' | 'onboardUser' | 'operation' | 'fetchAvailableModels', body: unknown, access: string, deadline: AbortSignal, operation?: string): Promise<unknown> {
    const bounded = AbortSignal.any([deadline, AbortSignal.timeout(30_000)]);
    const url = stage === 'operation' ? `${origin}/v1internal/${operation}` : `${origin}/v1internal:${stage}`;
    let status: number | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let reason: Reason = 'network';
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error()); };
      const cleanup = () => bounded.removeEventListener('abort', abort);
      bounded.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new Error()); });
      if (bounded.aborted) abort();
    });
    try {
      if (!/^[\x21-\x7e]{1,32768}$/u.test(access) || bounded.aborted) throw new Error();
      const response = await wait(Promise.resolve().then(() => fetcher(url, { method: stage === 'operation' ? 'GET' : 'POST', ...(stage === 'operation' ? {} : { body: JSON.stringify(body) }),
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': localCliUserAgent() },
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: bounded })).then(value => {
          if (bounded.aborted) void value.body?.cancel().catch(() => {});
          return value;
        }));
      status = response.status;
      if (response.redirected || status >= 300 && status < 400 || response.url && response.url !== url) {
        void response.body?.cancel().catch(() => {});
        throw new CatalogDiagnostic(stage, 'redirect', status);
      }
      reason = 'body'; reader = response.body?.getReader();
      if (!reader) {
        if (!response.ok) throw new CatalogDiagnostic(stage, 'http_error', status);
        throw new Error();
      }
      bounded.addEventListener('abort', cancel, { once: true });
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const part = await wait(reader.read());
        if (bounded.aborted) throw new Error();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 2 * 1048576) throw new Error();
        chunks.push(part.value);
      }
      reason = 'json';
      let value: unknown;
      try { value = boundedJSON(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new CatalogDiagnostic(stage, response.ok ? 'json' : 'http_error', status); }
      const root = object(value);
      const serviceError = object(root?.error);
      if (!response.ok) throw new CatalogDiagnostic(stage, 'http_error', status, serviceError?.status, undefined, undefined, serviceReason(serviceError, true));
      if (root && Object.hasOwn(root, 'error')) throw new CatalogDiagnostic(stage, 'schema', status, serviceError?.status ?? 'unknown', undefined, undefined, serviceReason(serviceError));
      return value;
    } catch (error) {
      if (error instanceof CatalogDiagnostic) throw error;
      throw new CatalogDiagnostic(stage, bounded.aborted ? signal.aborted ? 'aborted' : 'timeout' : reason, status);
    } finally {
      bounded.removeEventListener('abort', cancel); cancel();
      try { reader?.releaseLock(); } catch { /* Pending caller-supplied reads may outlive cancellation. */ }
    }
  }
  return {
    async discover(access: string, assertCurrent: () => Promise<void>): Promise<Catalog> {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const check = async () => {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { cleanup(); reject(new CatalogDiagnostic('loadCodeAssist', signal.aborted ? 'aborted' : 'timeout')); };
          const cleanup = () => deadline.removeEventListener('abort', abort);
          deadline.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(assertCurrent).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
          if (deadline.aborted) abort();
        });
      };
      await check();
      const loaded = await request('loadCodeAssist', { metadata: { ideType: 9 } }, access, deadline);
      await check();
      const load = object(loaded);
      if (!load) throw new CatalogDiagnostic('loadCodeAssist', 'schema');
      const projectStatus = object(load.projectValidationError);
      const tierReasons = Array.isArray(load.ineligibleTiers) ? load.ineligibleTiers.slice(0, 256).map(tier => object(tier)?.reasonCode) : [];
      if (load.projectValidationError && (!projectStatus || (projectStatus.code ?? 0) !== 0)) throw new CatalogDiagnostic('loadCodeAssist', 'eligibility', undefined, undefined, undefined,
        { source: 'projectValidationError', projectStatusCode: projectStatus?.code, ineligibleReasonCodes: tierReasons });
      const rawProject = load.cloudaicompanionProject;
      let project = typeof rawProject === 'string' ? rawProject : object(rawProject)?.id;
      if (Object.hasOwn(load, 'cloudaicompanionProject') && !identifier(project)) throw new CatalogDiagnostic('loadCodeAssist', 'schema');
      if (project === undefined && !load.currentTier && Array.isArray(load.allowedTiers) && load.allowedTiers.length > 0) {
        if (tierReasons.some(reason => reason === 'VALIDATION_REQUIRED' || reason === ineligibleReasonCodes.indexOf('VALIDATION_REQUIRED'))) throw new CatalogDiagnostic('loadCodeAssist', 'eligibility', undefined, undefined, undefined,
          { source: 'ineligibleTiers', ineligibleReasonCodes: tierReasons });
        const tiers = load.allowedTiers.map(object);
        const defaults = tiers.filter(value => value?.isDefault === true);
        const tier = defaults[0];
        if (defaults.length === 1 && tier?.id === 'free-tier') {
          await check();
          let onboard = object(await request('onboardUser', { tierId: tier.id, metadata: { ideType: 9 } }, access, deadline));
          await check();
          for (let attempt = 0; onboard?.done === false && attempt < 5; attempt++) {
            const name = onboard.name;
            if (typeof name !== 'string' || !/^operations\/[A-Za-z0-9_-]{1,200}$/u.test(name)) throw new CatalogDiagnostic('onboardUser', 'schema');
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => { deadline.removeEventListener('abort', abort); resolve(); }, 5000);
              const abort = () => { clearTimeout(timer); reject(new CatalogDiagnostic('operation', signal.aborted ? 'aborted' : 'timeout')); };
              deadline.addEventListener('abort', abort, { once: true });
              if (deadline.aborted) abort();
            });
            await check();
            onboard = object(await request('operation', undefined, access, deadline, name));
            await check();
          }
          if (onboard?.done !== true) throw new CatalogDiagnostic('onboardUser', 'schema');
          const resultProject = object(object(onboard.response)?.cloudaicompanionProject)?.id;
          if (!identifier(resultProject)) throw new CatalogDiagnostic('onboardUser', 'schema');
          project = resultProject;
        }
      }
      let response: unknown;
      try {
        response = await request('fetchAvailableModels', project === undefined ? {} : { project }, access, deadline);
      } catch (error) {
        if (error instanceof CatalogDiagnostic && error.stage === 'fetchAvailableModels' && error.reason === 'http_error' && error.status === 403 && identifier(project)) fallbackProjects.set(error, project);
        throw error;
      }
      await check();
      return { ...(project === undefined ? {} : { project: project as string }), ...decodeModels(response) };
    },
  };
}
