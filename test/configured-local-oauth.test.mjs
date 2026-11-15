import assert from 'node:assert/strict';
import { createProviderHost } from './helpers/provider-host.mjs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as plugins from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration, validatePublicOAuthConfiguration } from '../dist/configured-security.js';

const options = () => ({ mode: 'agy-local-oauth', authorizationAcknowledged: true });
const clientId = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const fakeSecret = 's'.repeat(35);
const baseScopes = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(scope => `https://www.googleapis.com/auth/${scope}`);
const localScopes = [...baseScopes, 'https://www.googleapis.com/auth/aicode', 'openid'];
const response = () => Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600 });
async function setup(plugin, rootOptions = options()) {
  let method, selected;
  const providerHost = createProviderHost(() => { throw Error('no provider without an active credential'); });
  const cleanup = await plugin.setup({ options: rootOptions,
    integration: { transform: async callback => { await callback({ method: { update(value) { method = value; } }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => selected, resolve() { throw Error('unexpected credential read'); } } },
    event: providerHost.event, provider: providerHost.provider, get storage() { throw Error('host owns storage'); },
  });
  return { method, cleanup, select(value) { selected = value; } };
}

test('explicit local client setup is inert; only code/refresh requests lazily load the local secret', async () => {
  let loads = 0;
  const requests = [];
  const host = await setup(plugins.createAntigravityPlugin(options(), { loadLocalClientSecret: async () => { loads++; return fakeSecret; }, fetch: async (url, init) => {
    requests.push({ url, init }); return response();
  } }));
  assert.equal(loads, 0); assert.equal(requests.length, 0);
  assert.equal(host.method.integrationID, 'agy-local-oauth');
  const transaction = await host.method.authorize();
  assert.equal(loads, 0); assert.equal(new URL(transaction.url).searchParams.has('client_secret'), false);
  assert.match(transaction.instructions, /Copy the code shown/u);
  const credential = await transaction.callback('fixture-local-code');
  await host.method.refresh(credential);
  assert.equal(loads, 2); assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init.redirect, 'error');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), clientId); assert.equal(form.get('client_secret'), fakeSecret);
    assert.equal(new Headers(init.headers).has('authorization'), false);
  }
  const first = new URLSearchParams(requests[0].init.body);
  assert.equal(first.get('redirect_uri'), 'https://antigravity.google/oauth-callback');
  assert.equal(createHash('sha256').update(first.get('code_verifier')).digest('base64url'), new URL(transaction.url).searchParams.get('code_challenge'));
  assert.equal(JSON.stringify(credential).includes(fakeSecret), false);
  await assert.rejects(transaction.callback('fixture-local-code')); await host.cleanup();
});

test('only local mode appends recovered consumer aicode and openid scopes and changes its binding', async () => {
  const config = validateLocalOAuthConfiguration(options());
  assert.deepEqual(config.oauth.scopes, localScopes); assert.equal(Object.isFrozen(config.oauth.scopes), true);
  assert.equal(binding(config), 'ff8bf766f5408bd56343805747f4d583789f72c4cdc0c035c4d501ee1f183a6f');
  assert.equal(binding({ ...config, oauth: { ...config.oauth, scopes: baseScopes } }), '7eca6879fc90dd2666d8a537421ef1e17afee1d529cc76b845156cfd9a3df635');
  const publicConfig = validatePublicOAuthConfiguration({ mode: 'agy-public-oauth', authorizationAcknowledged: true });
  assert.deepEqual(publicConfig.oauth.scopes, baseScopes);
  assert.equal(binding(publicConfig), '19425013774ec709c63cebd5dd4a5908082cd26daeec7f05d187b2f43ff4e508');
  const host = await setup(plugins.createLocalAntigravityOAuthPlugin(options(), { fetch: async () => { throw Error('unexpected network'); } }));
  try {
    const transaction = await host.method.authorize();
    assert.deepEqual(new URL(transaction.url).searchParams.get('scope').split(' '), localScopes);
    assert.equal(host.method.label(), 'Google Antigravity');
    assert.equal(validateLocalOAuthConfiguration(options()).name, 'Google Antigravity');
    assert.equal(host.method.method.label, 'Sign in with Google Antigravity');
    assert.match(transaction.instructions, /Copy the code shown/u);
    assert.match(transaction.instructions, /Paste only that code/u);
    assert.equal(/unverified|entitlement/u.test(transaction.instructions), false);
    assert.equal(host.method.integrationID, 'agy-local-oauth'); assert.equal(host.method.method.id, 'configured-pkce');
  } finally { await host.cleanup(); }
});

test('local token grants with returned scopes must include both new scopes', async () => {
  for (const scopes of [baseScopes, [...baseScopes, 'openid'], [...baseScopes, 'https://www.googleapis.com/auth/aicode'], localScopes]) {
    const host = await setup(plugins.createLocalAntigravityOAuthPlugin(options(), { loadLocalClientSecret: async () => fakeSecret,
      fetch: async () => Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') }),
    }));
    try {
      const transaction = await host.method.authorize();
      if (scopes.length === 7) {
        const credential = await transaction.callback('fixture-new-scope-code');
        assert.equal(credential.metadata.configuration, 'ff8bf766f5408bd56343805747f4d583789f72c4cdc0c035c4d501ee1f183a6f');
      } else await assert.rejects(transaction.callback('fixture-new-scope-code'), error => error.stage === 'token_validation' && error.reason === 'scope');
    } finally { await host.cleanup(); }
  }
});

test('old local scope binding requires explicit reauthorization before refresh without loading or mutating credentials', async () => {
  let requests = 0, loads = 0;
  const host = await setup(plugins.createLocalAntigravityOAuthPlugin(options(), { loadLocalClientSecret: async () => { loads++; return fakeSecret; },
    fetch: async () => { requests++; return response(); },
  }));
  const old = { type: 'oauth', methodID: 'configured-pkce', access: 'private-access', refresh: 'private-refresh', expires: Date.now() + 3600000,
    metadata: { issuer: 'https://accounts.google.com', configuration: '7eca6879fc90dd2666d8a537421ef1e17afee1d529cc76b845156cfd9a3df635' } };
  const before = structuredClone(old);
  try {
    await assert.rejects(host.method.refresh(old), error => {
      assert.equal(error.stage, 'credential_binding'); assert.equal(error.reason, 'reauthorization_required');
      assert.match(error.message, /Authorize again using "Google Antigravity"/u);
      assert.equal(/private-access|private-refresh|7eca6879/u.test(error.message + JSON.stringify(error)), false); return true;
    });
    assert.equal(requests, 0); assert.equal(loads, 0); assert.deepEqual(old, before);
  } finally { await host.cleanup(); }
});

test('local preset is explicit, immutable, root-loadable, and never an implicit public fallback', async () => {
  const { default: root } = await import('opencode-antigravity-oauth');
  const host = await setup(root); await host.cleanup();
  const dependencies = { fetch: async () => { throw Error('unexpected network'); }, loadLocalClientSecret: async () => { throw Error('must not load local client'); } };
  for (const config of [{ mode: 'agy-local-oauth' }, { ...options(), authorizationAcknowledged: false }, { ...options(), path: '/other/binary' }, { ...options(), clientSecret: fakeSecret }]) {
    assert.throws(() => plugins.createAntigravityPlugin(config, dependencies));
  }
  assert.throws(() => plugins.createPublicAntigravityOAuthPlugin(options(), dependencies));
  assert.throws(() => plugins.createSyntheticAntigravityPlugin(options(), dependencies));
  const publicHost = await setup(plugins.createPublicAntigravityOAuthPlugin({ mode: 'agy-public-oauth', authorizationAcknowledged: true }, dependencies));
  const transaction = await publicHost.method.authorize();
  await assert.rejects(transaction.callback('fixture-public-code'), error => error.stage === 'token_request');
  await publicHost.cleanup();
});

test('local loader failures are actionable and sanitized; no request is made after loader failure or cancellation', { timeout: 2000 }, async () => {
  const { LocalOAuthClientError } = await import('../dist/local-oauth-client.js');
  for (const reason of ['unreadable', 'invalid_client_configuration']) {
    let requests = 0;
    const host = await setup(plugins.createAntigravityPlugin(options(), { loadLocalClientSecret: async () => { throw new LocalOAuthClientError(reason); }, fetch: async () => { requests++; return response(); } }));
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback('fixture-loader-code'), error => error.stage === 'local_client' && error.reason === reason && error.cause === undefined);
    assert.equal(requests, 0); await host.cleanup();
  }
  let release, requests = 0;
  const host = await setup(plugins.createAntigravityPlugin(options(), { loadLocalClientSecret: async () => new Promise(resolve => { release = resolve; }), fetch: async () => { requests++; return response(); } }));
  const transaction = await host.method.authorize();
  const pending = transaction.callback('fixture-cancelled-code');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await host.cleanup(); release(fakeSecret); await assert.rejects(pending); assert.equal(requests, 0);
});

test('local mode retains safe diagnostics and duplicate-winner/account-switch fences with synthetic secrets', { timeout: 2000 }, async () => {
  for (const fetch of [async () => { throw Error(fakeSecret); }, async () => Response.json({ error: 'invalid_grant', error_description: fakeSecret }, { status: 400 }),
    async () => Response.json({ error: 'invalid_client', error_description: fakeSecret }, { status: 401 })]) {
    const host = await setup(plugins.createLocalAntigravityOAuthPlugin(options(), { loadLocalClientSecret: async () => fakeSecret, fetch }));
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback('fixture-local-error'), error => {
      assert.match(error.message, /^Local OAuth diagnostic:/u);
      assert.equal(`${error.message}${JSON.stringify(error)}`.includes(fakeSecret), false);
      assert.equal(error.cause, undefined); return true;
    });
    await host.cleanup();
  }
  let release;
  const host = await setup(plugins.createLocalAntigravityOAuthPlugin(options(), { loadLocalClientSecret: async () => fakeSecret,
    fetch: async () => new Promise(resolve => { release = () => resolve(response()); }),
  }));
  const transaction = await host.method.authorize();
  const winner = transaction.callback('fixture-local-winner');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transaction.callback('fixture-local-winner')); release();
  const credential = await winner;
  release = undefined;
  const refresh = host.method.refresh(credential);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  host.select({ type: 'credential', id: 'other-account', method: 'oauth' }); release();
  await assert.rejects(refresh); await host.cleanup();
});
