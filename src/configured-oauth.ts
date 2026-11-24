import { randomBytes } from 'node:crypto';
import { Credential, Integration } from '@opencode/plugin';
import { buildAuthorizationUrl, encodeStateEntropy, validateAuthorizationResponse } from './oauth-workbench.js';
import { binding, configuredText, createHTTP, PublicOAuthDiagnostic, record, rejectConfigured, rejectOAuth, type Configuration, type PresetOAuthConfiguration, type Fetch, type OAuthDiagnosticReason } from './configured-security.js';
import { LocalOAuthClientError, loadLocalConsumerSecret } from './local-oauth-client.js';

export interface OAuthDependencies { fetch: Fetch; now?: () => number; loadLocalClientSecret?: () => Promise<string>; publicationDelays?: { initialMs?: number; intervalMs?: number } }

export function createOAuthClient(config: Configuration | PresetOAuthConfiguration, dependencies: OAuthDependencies) {
  const http = createHTTP(dependencies.fetch), now = dependencies.now ?? Date.now;
  const boundary = binding(config), methodID = Integration.MethodID.make('configured-pkce');
  const controller = new AbortController();
  const pending = new Set<() => void>(), refreshing = new Map<string, Promise<Credential.OAuth>>();
  const localClient = 'mode' in config && config.mode === 'google-agy-oauth';
  function assertCredential(value: Credential.OAuth): void {
    if (localClient && value.type === 'oauth' && value.metadata?.configuration !== boundary) throw new PublicOAuthDiagnostic('credential_binding', 'reauthorization_required', undefined, undefined, true);
    if (value.type !== 'oauth' || value.methodID !== methodID || value.metadata?.configuration !== boundary || value.metadata?.issuer !== config.oauth.issuer) rejectConfigured();
  }
  async function loadClientSecret(signal: AbortSignal): Promise<string> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    const diagnostic = () => new PublicOAuthDiagnostic('local_client', signal.aborted ? 'aborted' : 'timeout', undefined, undefined, true);
    let abort = () => {};
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(diagnostic());
      bounded.addEventListener('abort', abort, { once: true });
      if (bounded.aborted) abort();
    });
    try {
      return await Promise.race([cancellation, Promise.resolve().then(() => {
        if (bounded.aborted) throw diagnostic();
        return (dependencies.loadLocalClientSecret ?? loadLocalConsumerSecret)();
      })]);
    } finally { bounded.removeEventListener('abort', abort); }
  }
  async function exchange(form: URLSearchParams, signal: AbortSignal, previous?: Credential.OAuth): Promise<Credential.OAuth> {
    let reason: OAuthDiagnosticReason = 'schema', status: number | undefined;
    try {
      if (localClient) {
        try {
          if (signal.aborted) throw new PublicOAuthDiagnostic('token_request', 'aborted', undefined, undefined, true);
          const secret = await loadClientSecret(signal);
          if (!/^[\x21-\x7e]{35}$/u.test(secret)) throw new LocalOAuthClientError('invalid_client_configuration');
          if (signal.aborted) throw new PublicOAuthDiagnostic('token_request', 'aborted', undefined, undefined, true);
          form.set('client_secret', secret);
        } catch (error) {
          if (error instanceof PublicOAuthDiagnostic) throw error;
          throw new PublicOAuthDiagnostic('local_client', error instanceof LocalOAuthClientError ? error.reason : 'unreadable', undefined, undefined, true);
        }
      }
      const raw = await http.json(config.oauth.tokenEndpoint, form, signal, localClient ? 'local' : 'mode' in config, value => { status = value; });
      const allowed = ['access_token', 'refresh_token', 'token_type', 'expires_in', 'scope', 'id_token'];
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).some(key => !allowed.includes(key))) reason = 'unsupported_response_fields';
      const value = record(raw, allowed);
      if (value.id_token !== undefined) configuredText(value.id_token, 32768);
      reason = 'access_token';
      const access = configuredText(value.access_token, 32768);
      if (/\s/u.test(access)) rejectConfigured();
      reason = 'token_type';
      if (value.token_type !== 'Bearer') rejectConfigured();
      reason = 'expires_in';
      if (typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in)
        || value.expires_in < 1 || value.expires_in > 31_536_000) rejectConfigured();
      reason = 'refresh_token';
      const refresh = value.refresh_token === undefined ? previous?.refresh ?? '' : configuredText(value.refresh_token, 32768);
      if (refresh && /\s/u.test(refresh)) rejectConfigured();
      reason = 'scope';
      if (value.scope !== undefined && (typeof value.scope !== 'string' || !config.oauth.scopes.every(scope => (value.scope as string).split(' ').includes(scope)))) rejectConfigured();
      reason = 'expires_in';
      const expires = now() + value.expires_in * 1000;
      if (!Number.isSafeInteger(expires)) rejectConfigured();
      reason = 'aborted';
      if (signal.aborted) rejectConfigured();
      return { type: 'oauth', methodID, access, refresh, expires, metadata: { configuration: boundary, issuer: config.oauth.issuer } };
    } catch (error) {
      if ('mode' in config && !(error instanceof PublicOAuthDiagnostic)) throw new PublicOAuthDiagnostic('token_validation', reason, status, undefined, localClient);
      return rejectOAuth(error);
    } finally { form.delete('client_secret'); }
  }
  function authorizationCode(response: string, expectedState: string): string {
    if ('mode' in config) {
      if (typeof response !== 'string' || response.length > 8192) rejectConfigured();
      response = response.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, '');
      if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(response)) {
        if (!/^[\x21-\x7e]{1,2048}$/u.test(response)) rejectConfigured();
        return response;
      }
    }
    const result = validateAuthorizationResponse({ responseUrl: response, redirectUri: config.oauth.redirectUri, expectedState });
    if (result.kind !== 'code') rejectConfigured();
    return result.code;
  }
  return {
    begin() {
      if (controller.signal.aborted || pending.size >= 32) rejectConfigured();
      const state = encodeStateEntropy(randomBytes(16));
      let verifier = randomBytes(32).toString('base64url');
      let used = false;
      const issued = now(), expiresAt = issued + 300_000;
      if (!Number.isSafeInteger(issued) || issued < 0 || !Number.isSafeInteger(expiresAt)) rejectConfigured();
      const local = new AbortController();
      const signal = AbortSignal.any([controller.signal, local.signal, AbortSignal.timeout(300_000)]);
      const cancel = () => { signal.removeEventListener('abort', cancel); used = true; verifier = ''; local.abort(); pending.delete(cancel); };
      pending.add(cancel);
      signal.addEventListener('abort', cancel, { once: true });
      const authorization = new URL(buildAuthorizationUrl({ ...config.oauth, state, verifier }));
      if (config.oauth.issuer === 'https://accounts.google.com') authorization.searchParams.set('access_type', 'offline');
      const url = authorization.href;
      return { url, expiresAt, cancel,
        async complete(response: string): Promise<Credential.OAuth> {
          if (used) return rejectConfigured();
          if (signal.aborted || now() < issued || now() >= expiresAt) { cancel(); return rejectConfigured(); }
          used = true;
          try {
            let code: string;
            try { code = authorizationCode(response, state); }
            catch (error) {
              if ('mode' in config) throw new PublicOAuthDiagnostic('authorization_input', 'invalid', undefined, undefined, localClient);
              return rejectOAuth(error);
            }
            const form = new URLSearchParams({ grant_type: 'authorization_code', client_id: config.oauth.clientId,
              redirect_uri: config.oauth.redirectUri, code, code_verifier: verifier });
            return await exchange(form, signal);
          } catch (error) { return rejectOAuth(error); }
          finally { cancel(); }
        },
      };
    },
    async refresh(credential: Credential.OAuth): Promise<Credential.OAuth> {
      try {
        if (controller.signal.aborted) rejectConfigured();
        assertCredential(credential);
        const refresh = configuredText(credential.refresh, 32768);
        if (/\s/u.test(refresh)) rejectConfigured();
        let operation = refreshing.get(refresh);
        if (!operation) {
          operation = exchange(new URLSearchParams({ grant_type: 'refresh_token', client_id: config.oauth.clientId, refresh_token: refresh }), controller.signal, credential);
          refreshing.set(refresh, operation);
        }
        try { return await operation; }
        finally { if (refreshing.get(refresh) === operation) refreshing.delete(refresh); }
      } catch (error) { return rejectOAuth(error); }
    },
    accepts(credential: Credential.OAuth): boolean {
      try { assertCredential(credential); return Number.isSafeInteger(credential.expires) && credential.expires > now() + 5000 && /^[\x21-\x7e]{1,32768}$/u.test(credential.access); }
      catch { return false; }
    },
    close() { controller.abort(); for (const cancel of pending) cancel(); pending.clear(); refreshing.clear(); },
  };
}
