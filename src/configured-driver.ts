import { randomUUID } from 'node:crypto';
import { createOfflineModel } from './offline-opencode.js';
import { OfflineInferenceError } from './offline-inference.js';
import { binding, createHTTP, record, rejectConfigured, type Configuration, type Fetch, type PresetOAuthConfiguration } from './configured-security.js';
import { CatalogDiagnostic } from './configured-catalog.js';
import type { LanguageModel } from '@opencode/ai';
import type { Credential } from '@opencode/plugin';

interface Runtime {
  config: Configuration | PresetOAuthConfiguration;
  configuration?(connection: string): Configuration | undefined;
  credential(connection: string): Promise<Credential.OAuth>;
  fetch: Fetch;
  signal: AbortSignal;
}
const runtimeRegistry = Symbol.for('opencode-antigravity-oauth.configured-runtimes.v1');
const processState = globalThis as typeof globalThis & { [runtimeRegistry]?: Map<string, Runtime> };
const runtimes = processState[runtimeRegistry] ??= new Map<string, Runtime>();

export function registerConfiguredRuntime(runtime: Runtime): { id: string; dispose(): void } {
  const id = randomUUID(); runtimes.set(id, runtime);
  return { id, dispose() { if (runtimes.get(id) === runtime) runtimes.delete(id); } };
}

export function model(modelID: string, settings: Record<string, unknown>): LanguageModel {
  try {
    const input = record(settings, ['configuredRuntime', 'configuredConnection', 'configuration', 'issuer', 'apiKey', 'headers', 'body', 'catalogExcludedModels', 'antigravityModel']);
    const runtime = typeof input.configuredRuntime === 'string' ? runtimes.get(input.configuredRuntime) : undefined;
    if (!runtime || runtime.signal.aborted) rejectConfigured();
    const connection = input.configuredConnection;
    if (typeof connection !== 'string' || !connection || connection.length > 512) rejectConfigured();
    const config = 'inference' in runtime.config ? runtime.config : runtime.configuration?.(connection);
    const base = config?.models.find(m => m.id === modelID && m.enabled);
    if (!config || !base) rejectConfigured();
    const wireOf = (value: unknown): unknown => value && typeof value === 'object' ? (value as Record<string, unknown>).antigravityModel : undefined;
    const variants = base.variants ?? [];
    let wire = modelID;
    if (variants.length) {
      const allowed = new Set<string>();
      for (const value of [wireOf(base.settings), ...variants.map(variant => wireOf(variant.settings))]) if (typeof value === 'string') allowed.add(value);
      const candidate = input.antigravityModel === undefined ? wireOf(base.settings) : input.antigravityModel;
      if (typeof candidate !== 'string' || !allowed.has(candidate)) rejectConfigured();
      wire = candidate;
    } else if (input.antigravityModel !== undefined && input.antigravityModel !== modelID) rejectConfigured();
    if (input.configuration !== undefined && input.configuration !== binding(runtime.config)) rejectConfigured();
    if (input.issuer !== undefined && input.issuer !== runtime.config.oauth.issuer) rejectConfigured();
    for (const key of ['headers', 'body']) if (input[key] !== undefined && Object.keys(record(input[key], [])).length) rejectConfigured();
    const http = createHTTP(runtime.fetch);
    return createOfflineModel({ provider: config.providerId, model: wire, ...(config.inference.project === '' && !('inference' in runtime.config) ? {} : { project: config.inference.project }),
      ...('mode' in runtime.config && runtime.config.mode === 'agy-local-oauth' ? { localIdentity: true } : {}),
      requestId: () => randomUUID(), textSemantics: config.inference.textSemantics, usageSemantics: config.inference.usageSemantics,
      transport: async function* (body, signal, options) {
        try {
          const bounded = AbortSignal.any([signal, runtime.signal]);
          if (bounded.aborted) rejectConfigured();
          const credential = await runtime.credential(connection);
          if (bounded.aborted) rejectConfigured();
          if (runtime.configuration && runtime.configuration(connection) !== config) rejectConfigured();
          yield* http.stream(config.inference.endpoint, body, credential.access, bounded, 'mode' in runtime.config && runtime.config.mode === 'agy-local-oauth', options?.timeout);
        } catch (error) { if (error instanceof OfflineInferenceError) throw error; rejectConfigured(); }
      },
    });
  } catch (error) { if (error instanceof CatalogDiagnostic) throw error; return rejectConfigured(); }
}
