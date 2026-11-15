import type { QuotaBridge, QuotaV1 } from './configured-quota.js';

const registryKey = Symbol.for('opencode-antigravity-oauth.quota-bridge.v1');
const globals = globalThis as typeof globalThis & { [key: symbol]: unknown };

export interface QuotaBridgeLease { getQuota: (signal: AbortSignal) => Promise<QuotaV1> }
export interface SharedQuotaBridge {
  port: number;
  apiKeyEnv: string;
  autoKey: boolean;
  shared?: boolean;
  stateDirectory?: string;
  statuses?: Set<{ running: boolean }>;
  token: string;
  owned: boolean;
  bridge: QuotaBridge;
  leases: Map<symbol, QuotaBridgeLease>;
}
export interface QuotaBridgeRegistry { version: 1; queue: Promise<void>; entry?: SharedQuotaBridge }

export function quotaBridgeRegistry(): QuotaBridgeRegistry {
  const existing = globals[registryKey] as Partial<QuotaBridgeRegistry> | undefined;
  if (existing) {
    if (existing.version !== 1 || !existing.queue || typeof existing.queue.then !== 'function') throw new Error('Quota bridge registry unavailable.');
    return existing as QuotaBridgeRegistry;
  }
  const created: QuotaBridgeRegistry = { version: 1, queue: Promise.resolve() };
  globals[registryKey] = created;
  return created;
}

export function serializeQuotaBridge<T>(registry: QuotaBridgeRegistry, operation: () => Promise<T>): Promise<T> {
  const pending = registry.queue.then(operation);
  registry.queue = pending.then(() => {}, () => {});
  return pending;
}
