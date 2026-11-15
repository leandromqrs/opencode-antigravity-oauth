import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { startQuotaBridge, unavailableQuotaV1, type QuotaV1 } from './configured-quota.js';
import { prepareQuotaBridgeState } from './configured-quota-bridge-storage.js';
import { startSharedQuotaBridge } from './configured-quota-bridge-shared.js';
import { quotaBridgeRegistry, serializeQuotaBridge, type QuotaBridgeLease, type QuotaBridgeRegistry, type SharedQuotaBridge } from './configured-quota-bridge-state.js';

export interface QuotaBridgeConfig { port: number; apiKeyEnv: string; autoKey: boolean; shared: boolean }
export interface QuotaBridgeStatus { enabled: boolean; running: boolean; url?: string; diagnostic?: 'missing-key' | 'invalid-key' | 'start-failed' | 'incompatible-config' }
export interface AcquiredQuotaBridge { status: QuotaBridgeStatus; release(): Promise<void> }

const noopRelease = async (): Promise<void> => {};

function releaseLease(registry: QuotaBridgeRegistry, entry: SharedQuotaBridge, id: symbol, status: QuotaBridgeStatus): () => Promise<void> {
  return () => serializeQuotaBridge(registry, async () => {
    if (registry.entry !== entry) return;
    entry.leases.delete(id);
    entry.statuses?.delete(status);
    if (entry.leases.size) return;
    await entry.bridge.close().catch(() => {});
    if (entry.owned && process.env[entry.apiKeyEnv] === entry.token) delete process.env[entry.apiKeyEnv];
    delete registry.entry;
  });
}

// One loopback bridge is shared by every plugin instance in the process through a
// lease registry, so a reload or an inactive location no longer tears the bridge
// down or pins it to a single instance's catalog state. getQuota tries each live
// lease until one resolves a real quota, mirroring the QwenCloud/Junie bridges.
// With shared:true the token lives in a private state file and the port is elected
// across processes: a live owner that proves the token is reused, and the monitor
// retakes the port when the owner dies (service restarts keep the quota visible).
export async function acquireQuotaBridge(config: QuotaBridgeConfig | undefined, lease: QuotaBridgeLease, dependencies: { stateDirectory?: string } = {}): Promise<AcquiredQuotaBridge> {
  const status: QuotaBridgeStatus = { enabled: !!config, running: false };
  if (!config) return { status, release: noopRelease };
  const registry = quotaBridgeRegistry();
  try {
    return await serializeQuotaBridge(registry, async () => {
      const id = Symbol();
      const existing = registry.entry;
      if (existing) {
        if (existing.port !== config.port || existing.apiKeyEnv !== config.apiKeyEnv || existing.autoKey !== config.autoKey
          || !!existing.shared !== config.shared
          || (dependencies.stateDirectory !== undefined && resolve(dependencies.stateDirectory) !== existing.stateDirectory)
          || process.env[config.apiKeyEnv] !== existing.token) {
          return { status: { ...status, diagnostic: 'incompatible-config' }, release: noopRelease };
        }
        if (config.shared) await prepareQuotaBridgeState({ stateDirectory: existing.stateDirectory, workspaceRoots: [], token: existing.token });
        existing.leases.set(id, lease);
        existing.statuses?.add(status);
        Object.assign(status, { running: true, url: existing.bridge.url });
        return { status, release: releaseLease(registry, existing, id, status) };
      }
      const previous = process.env[config.apiKeyEnv];
      if (previous === undefined && !config.autoKey) return { status: { ...status, diagnostic: 'missing-key' }, release: noopRelease };
      if (previous !== undefined && !/^[\x21-\x7e]{32,512}$/u.test(previous)) return { status: { ...status, diagnostic: 'invalid-key' }, release: noopRelease };
      if (config.shared && !config.autoKey) return { status: { ...status, diagnostic: 'incompatible-config' }, release: noopRelease };
      const sharedState = config.shared ? await prepareQuotaBridgeState({ stateDirectory: dependencies.stateDirectory, workspaceRoots: [], token: previous }) : undefined;
      const token = sharedState?.token ?? previous ?? randomBytes(32).toString('hex');
      const owned = previous === undefined;
      const leases = new Map<symbol, QuotaBridgeLease>([[id, lease]]);
      const statuses = new Set<{ running: boolean }>([status]);
      if (owned && !config.shared) process.env[config.apiKeyEnv] = token;
      const getQuota = async (signal: AbortSignal): Promise<QuotaV1> => {
        let last: QuotaV1 | undefined;
        for (const current of leases.values()) {
          try {
            const quota = await current.getQuota(signal);
            if (quota.entries.some(entry => entry.resultType === 'quota')) return quota;
            last = quota;
          } catch { /* try the next live lease */ }
        }
        return last ?? unavailableQuotaV1(new Date().toISOString());
      };
      try {
        const bridge = config.shared
          ? await startSharedQuotaBridge({ port: config.port, token, getQuota, onAvailability: available => {
            if (owned) {
              if (!available && process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv];
              if (available && process.env[config.apiKeyEnv] === undefined) process.env[config.apiKeyEnv] = token;
            }
            for (const current of statuses) current.running = available && process.env[config.apiKeyEnv] === token;
          } })
          : await startQuotaBridge({ port: config.port, token, getQuota });
        if (owned) process.env[config.apiKeyEnv] = token;
        const entry: SharedQuotaBridge = { port: config.port, apiKeyEnv: config.apiKeyEnv, autoKey: config.autoKey, shared: config.shared, stateDirectory: sharedState?.directory, token, owned, bridge, leases, statuses };
        registry.entry = entry;
        Object.assign(status, { running: true, url: bridge.url });
        return { status, release: releaseLease(registry, entry, id, status) };
      } catch {
        if (owned && process.env[config.apiKeyEnv] === token) delete process.env[config.apiKeyEnv];
        return { status: { ...status, diagnostic: 'start-failed' }, release: noopRelease };
      }
    });
  } catch {
    return { status: { ...status, diagnostic: 'start-failed' }, release: noopRelease };
  }
}