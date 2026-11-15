import { Plugin, Provider, Integration, type Credential } from '@opencode/plugin';
import { createOAuthClient, type OAuthDependencies } from './configured-oauth.js';
import { fetchQuotaSummary, quotaV1FromSummary, unavailableQuotaV1, type QuotaV1 } from './configured-quota.js';
import { acquireQuotaBridge } from './configured-quota-bridge-plugin.js';
import { registerConfiguredRuntime } from './configured-driver.js';
import { createCatalogClient, CatalogDiagnostic, getCatalogFallbackProject, LOCAL_PROVIDER_ID, LOCAL_INFERENCE_ENDPOINT } from './configured-catalog.js';
import { staticFallbackModels } from './configured-static-models.js';
import { binding, PublicOAuthDiagnostic, rejectConfigured, validateProductionConfiguration, validatePublicOAuthConfiguration, validateLocalOAuthConfiguration, validateSyntheticConfiguration, type Configuration, type PresetOAuthConfiguration } from './configured-security.js';

const sharedRuntimeDriverPackage = new URL('./configured-driver.js?runtime=shared-v53', import.meta.url).href;

export function createAntigravityPlugin(configuration: unknown, dependencies: OAuthDependencies): Plugin.Plugin {
  return configuredPlugin(validateProductionConfiguration(configuration), dependencies);
}

export function createPublicAntigravityOAuthPlugin(options: unknown, dependencies: OAuthDependencies): Plugin.Plugin {
  return configuredPlugin(validatePublicOAuthConfiguration(options), dependencies);
}

export function createLocalAntigravityOAuthPlugin(options: unknown, dependencies: OAuthDependencies): Plugin.Plugin {
  return configuredPlugin(validateLocalOAuthConfiguration(options), dependencies);
}

export function createSyntheticAntigravityPlugin(configuration: unknown, dependencies: OAuthDependencies): Plugin.Plugin {
  return configuredPlugin(validateSyntheticConfiguration(configuration), dependencies);
}

function configuredPlugin(config: Configuration | PresetOAuthConfiguration, dependencies: OAuthDependencies): Plugin.Plugin {
  if (!dependencies || typeof dependencies.fetch !== 'function' || (dependencies.now !== undefined && typeof dependencies.now !== 'function')) rejectConfigured();
  return Plugin.define({
    id: `opencode-antigravity-oauth:${config.integrationId}`,
    async setup(ctx) {
      const controller = new AbortController();
      const oauth = createOAuthClient(config, dependencies);
      const registrations: { dispose(): Promise<void> }[] = [];
      const local = 'mode' in config && config.mode === 'agy-local-oauth';
      const now = dependencies.now ?? Date.now;
      let disposed = false;
      const credential = async (expectedConnection: string): Promise<Credential.OAuth> => {
          if (disposed) rejectConfigured();
          const active = await ctx.integration.connection.active(config.integrationId);
          if (!active || active.type !== 'credential' || active.method !== 'oauth' || active.id !== expectedConnection) rejectConfigured();
          const credential = await ctx.integration.connection.resolve(active);
          const current = await ctx.integration.connection.active(config.integrationId);
           if (disposed || !credential || credential.type !== 'oauth' || current?.type !== 'credential' || current.id !== expectedConnection || current.method !== 'oauth') rejectConfigured();
           if (local && credential.metadata?.configuration !== binding(config)) throw new PublicOAuthDiagnostic('credential_binding', 'reauthorization_required', undefined, undefined, true);
           if (!oauth.accepts(credential)) rejectConfigured();
          return credential;
      };
      type Inventory = { config: Configuration; excluded: number; expires: number; staticFallback?: boolean };
      const inventories = new Map<string, Inventory>();
      const discovering = new Map<string, Promise<Inventory>>();
      const failures = new Map<string, { error: CatalogDiagnostic; expires: number }>();
      type Editor = Parameters<Parameters<typeof ctx.provider.transform>[0]>[0];
      type Snapshot = { entry?: Parameters<Editor['add']>[0]; configuration?: Configuration; error?: Error };
      let snapshot: Snapshot = {};
      let refreshing: Promise<void> | undefined;
      let pending = false;
      let providerReady = false;
      let reloadPending = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const quotaConfig = 'mode' in config && config.mode === 'agy-local-oauth' ? config.quotaBridge : undefined;
      let quotaRelease: (() => Promise<void>) | undefined;
      let quotaCache: { value: QuotaV1; expires: number } | undefined;
      let quotaPending: Promise<QuotaV1> | undefined;
      const catalog = createCatalogClient(dependencies.fetch, controller.signal);
      const runtime = 'inference' in config || local ? registerConfiguredRuntime({ config, fetch: dependencies.fetch, signal: controller.signal,
        credential, ...(local ? { configuration: (connection: string) => {
          const inventory = inventories.get(connection);
          return inventory && inventory.expires > now() ? inventory.config : undefined;
        } } : {}),
      }) : undefined;
      const selection = async () => {
        try {
          const current = await ctx.integration.connection.active(config.integrationId);
          return current?.type === 'credential' ? JSON.stringify([current.type, current.id, current.method]) : JSON.stringify(current ?? null);
        } catch { return rejectConfigured(); }
      };
      const assertSelection = async (expected: string) => {
        if (disposed || await selection() !== expected || disposed) rejectConfigured();
      };
      const getQuota = async (signal: AbortSignal): Promise<QuotaV1> => {
        const observed = () => new Date(now()).toISOString();
        if (disposed) return unavailableQuotaV1(observed());
        if (quotaCache && quotaCache.expires > now()) return quotaCache.value;
        if (quotaPending) return quotaPending;
        const operation = (async (): Promise<QuotaV1> => {
          const current = await ctx.integration.connection.active(config.integrationId);
          if (disposed || !current || current.type !== 'credential' || current.method !== 'oauth') return unavailableQuotaV1(observed());
          const resolved = await credential(current.id);
          const inventory = inventories.get(current.id);
          let project = inventory && inventory.expires > now() ? inventory.config.inference.project : '';
          if (!project && !disposed) {
            const selected = JSON.stringify([current.type, current.id, current.method]);
            project = (await catalog.discover(resolved.access, () => assertSelection(selected))).project ?? '';
          }
          if (!project) return unavailableQuotaV1(observed());
          return quotaV1FromSummary(await fetchQuotaSummary(dependencies.fetch, resolved.access, project, signal), observed());
        })().catch(() => unavailableQuotaV1(observed()));
        quotaPending = operation;
        try {
          const value = await operation;
          quotaCache = { value, expires: now() + (value.entries.some(entry => entry.resultType === 'quota') ? 5000 : 2000) };
          return value;
        } finally {
          if (quotaPending === operation) quotaPending = undefined;
        }
      };
      const cleanup = async () => {
        if (disposed) return;
        disposed = true; clearInterval(timer); controller.abort(); oauth.close(); runtime?.dispose(); inventories.clear(); discovering.clear(); failures.clear(); snapshot = {};
        quotaCache = undefined; quotaPending = undefined;
        const release = quotaRelease; quotaRelease = undefined;
        if (release) await release();
        await Promise.allSettled(registrations.reverse().map(registration => registration.dispose()));
      };
      try {
        registrations.push(await ctx.integration.transform(editor => {
          editor.method.update({ integrationID: config.integrationId,
            method: { id: 'configured-pkce', type: 'oauth', label: 'mode' in config ? config.mode === 'agy-local-oauth' ? 'Sign in with Google Antigravity' : 'Experimental public-client login (secretless, unverified)' : 'Authorize configured public PKCE client' },
            authorize: async () => {
              const selected = await selection();
              if (disposed) rejectConfigured();
              const transaction = oauth.begin();
              return { mode: 'code', url: transaction.url, expiresAt: transaction.expiresAt,
                instructions: 'mode' in config
                  ? config.mode === 'agy-local-oauth'
                    ? 'Sign in with your Google account to use Antigravity models. Copy the code shown on the Antigravity callback page and paste it here. Paste only that code, never an access/refresh token or the address-bar URL. Uses the approved AGY OAuth client from a private local file; no agy executable is required.'
                    : 'Experimental secretless public-client login; Google acceptance is unverified. Copy the code shown on Antigravity callback page and paste it here. Do not paste access/refresh tokens. With a code alone, returned state cannot be checked; PKCE binding depends on the token server. This does not verify account identity or entitlement.'
                  : 'Authorize only with the configured service/client. Paste the full callback URL, including state and code; a code alone is not accepted. This does not verify account identity or entitlement.',
                 callback: async responseUrl => {
                   try { await assertSelection(selected); }
                   catch { transaction.cancel(); return rejectConfigured(); }
                   const credential = await transaction.complete(responseUrl);
                   await assertSelection(selected);
                   return credential;
                },
              };
            }, refresh: async credential => {
              const selected = await selection();
              if (disposed) rejectConfigured();
              const refreshed = await oauth.refresh(credential);
              await assertSelection(selected);
              return refreshed;
            }, label: () => config.name,
          });
          editor.update(config.integrationId, value => { value.name = config.name; });
        }));
        if (!runtime) return cleanup;
        const prepare = async (): Promise<Snapshot> => {
          const sourceConnection = await ctx.integration.connection.active(config.integrationId);
          if (disposed) return {};
          if (!sourceConnection || sourceConnection.type !== 'credential' || sourceConnection.method !== 'oauth') { inventories.clear(); return {}; }
          const selected = JSON.stringify([sourceConnection.type, sourceConnection.id, sourceConnection.method]);
          await assertSelection(selected);
          let discovered: Configuration;
          let excluded = 0;
          let staticFallback = false;
          if ('inference' in config) discovered = config;
          else {
            const failure = failures.get(sourceConnection.id);
            if (failure && failure.expires > now()) throw failure.error;
            failures.delete(sourceConnection.id);
            const resolved = await credential(sourceConnection.id);
            await assertSelection(selected);
            const previous = inventories.get(sourceConnection.id);
            let inventory = previous;
            if (!inventory || inventory.expires <= now()) {
              inventories.delete(sourceConnection.id);
              let operation = discovering.get(sourceConnection.id);
              if (!operation) {
                if (discovering.size >= 4) rejectConfigured();
                operation = (async () => {
                  let result;
                  let fallback = false;
                  try { result = await catalog.discover(resolved.access, () => assertSelection(selected)); }
                  catch (error) {
                    if (!local || !(error instanceof CatalogDiagnostic) || error.stage !== 'fetchAvailableModels' || error.reason !== 'http_error' || error.status !== 403) throw error;
                    await assertSelection(selected);
                    fallback = true;
                    result = { models: staticFallbackModels(), excluded: 0, project: getCatalogFallbackProject(error) };
                  }
                  if (!result.models.length) throw new CatalogDiagnostic('fetchAvailableModels', 'no_models', undefined, undefined, result.excluded);
                  const freeze = (value: object): void => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child); };
                  const value: Inventory = { config: { ...config, providerId: LOCAL_PROVIDER_ID,
                    inference: { endpoint: LOCAL_INFERENCE_ENDPOINT, project: result.project ?? '', textSemantics: 'delta', usageSemantics: 'cumulative-snapshot' },
                    models: result.models }, excluded: result.excluded, staticFallback: fallback, expires: Math.min(now() + (fallback ? 30_000 : 60_000), resolved.expires - 5000) };
                  if (previous && JSON.stringify(previous.config) === JSON.stringify(value.config)) value.config = previous.config;
                  freeze(value.config);
                  await assertSelection(selected);
                  inventories.clear(); inventories.set(sourceConnection.id, value);
                  return value;
                })();
                discovering.set(sourceConnection.id, operation);
              }
              try { inventory = await operation; }
              catch (error) {
                if (error instanceof CatalogDiagnostic && !disposed) {
                  await assertSelection(selected);
                  const safeError = new CatalogDiagnostic(error.stage, error.reason, error.status, error.serviceError, error.excluded,
                    { source: error.eligibilitySource, projectStatusCode: error.projectStatusCode, ineligibleReasonCodes: error.ineligibleReasonCodes }, error.serviceReason);
                  if (failures.size >= 16) failures.delete(failures.keys().next().value!);
                  failures.set(sourceConnection.id, { error: Object.freeze(safeError), expires: now() + 30_000 });
                  throw safeError;
                }
                throw error;
              }
              finally { if (discovering.get(sourceConnection.id) === operation) discovering.delete(sourceConnection.id); }
            }
            discovered = inventory.config; excluded = inventory.excluded; staticFallback = inventory.staticFallback ?? false;
          }
          await assertSelection(selected);
          return { configuration: discovered, entry: { info: { ...Provider.Info.empty(Provider.ID.make(discovered.providerId)), name: staticFallback ? `${config.name} (static experimental; entitlement unverified${discovered.inference.project ? '' : '; projectless'})` : config.name, activation: 'enabled',
            integrationID: Integration.ID.make(config.integrationId), package: sharedRuntimeDriverPackage,
            settings: { configuredRuntime: runtime.id, configuredConnection: sourceConnection.id, ...(local ? { catalogExcludedModels: excluded } : {}) },
          }, sourceConnection, models: discovered.models.map(model => ({ ...model, package: sharedRuntimeDriverPackage })) } };
        };
        const fingerprint = (value: Snapshot) => JSON.stringify([value.entry, value.error && [value.error.name, value.error.message, value.error]]);
        const refresh = (): Promise<void> => {
          if (disposed) return Promise.resolve();
          pending = true;
          if (refreshing) return refreshing;
          refreshing = (async () => {
            try {
              while (pending && !disposed) {
                pending = false;
                let next: Snapshot;
                let selected: string | undefined;
                try { selected = await selection(); next = await prepare(); }
                catch (error) {
                  next = { error: error instanceof CatalogDiagnostic || error instanceof PublicOAuthDiagnostic ? error : new Error('Configured OAuth integration: invalid or unsupported operation') };
                }
                if (disposed) return;
                try {
                  if (selected !== await selection()) next = { error: new Error('Configured OAuth integration: invalid or unsupported operation') };
                } catch { next = { error: new Error('Configured OAuth integration: invalid or unsupported operation') }; }
                if (disposed) return;
                const changed = snapshot.configuration !== next.configuration || fingerprint(snapshot) !== fingerprint(next);
                snapshot = next;
                if (changed && next.error) console.warn('Antigravity catalog discovery failed:', next.error);
                if (changed) reloadPending = true;
                if (reloadPending && providerReady && !disposed) {
                  reloadPending = false;
                  try { await ctx.provider.reload(); } catch { reloadPending = true; }
                }
              }
            } finally { refreshing = undefined; }
          })();
          return refreshing;
        };
        const observe = async () => {
          try {
            for await (const event of ctx.event.subscribe({ types: ['credential.updated', 'credential.switched', 'integration.updated'], signal: controller.signal })) {
              if (disposed) return;
              if (event.type === 'credential.switched' && event.data.integrationID !== config.integrationId) continue;
              if (event.type === 'credential.switched' || event.type === 'credential.updated') { quotaCache = undefined; quotaPending = undefined; }
              await refresh();
            }
          } catch { if (!disposed) await refresh(); }
        };
        void observe();
        await refresh();
        reloadPending = false;
        registrations.push(await ctx.provider.transform(editor => {
          if (disposed) return;
          if (snapshot.entry) editor.add(snapshot.entry);
        }));
        providerReady = true;
        if (reloadPending) await refresh();
        timer = setInterval(() => { void refresh(); }, 5000);
        timer.unref();
        if (quotaConfig) {
          const acquired = await acquireQuotaBridge(quotaConfig, { getQuota });
          if (acquired.status.diagnostic) console.warn('Antigravity quota bridge unavailable:', acquired.status.diagnostic);
          if (disposed) await acquired.release();
          else quotaRelease = acquired.release;
        }
        return cleanup;
      } catch (error) { await cleanup(); if (error instanceof CatalogDiagnostic || error instanceof PublicOAuthDiagnostic) throw error; return rejectConfigured(); }
    },
  });
}
