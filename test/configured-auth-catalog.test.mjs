import assert from 'node:assert/strict';
import { assertDiagnostic, createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { Credential, Model, Provider } from '@opencode/plugin';
import { Schema } from 'effect';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';

const ACCESS_A = 'synthetic-ACCESS_A';
const ACCESS_B = 'synthetic-ACCESS_B';
const REFRESH_A = 'synthetic-REFRESH_A';
const ID_A = 'synthetic-ID_A';
const clientSecret = 's'.repeat(35);
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const loadEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const modelsEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const selected = id => ({ type: 'credential', id, method: 'oauth' });
const catalog = () => ({ defaultAgentModelId: 'synthetic-chat', models: {
  'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 },
} });

function assertNoTokens(value) {
  const serialized = JSON.stringify(value);
  for (const token of [ACCESS_A, ACCESS_B, REFRESH_A, ID_A, clientSecret]) assert.equal(serialized.includes(token), false);
}

async function setup(t) {
  const unexpected = [];
  t.mock.method(globalThis, 'fetch', async () => {
    unexpected.push('global fetch');
    throw Error('Uninjected network request');
  });
  t.after(() => assert.deepEqual(unexpected, []));
  let now = 1000, method;
  const accounts = new Map(), resolved = [], requests = [], added = [];
  const state = { active: undefined, afterResolve: undefined, afterLoad: undefined };
  const providerHost = createProviderHost(value => { added.push(value); });
  const persist = value => { accounts.set(state.active.id, value); return value; };
  const cleanup = await createLocalAntigravityOAuthPlugin({ mode: 'agy-local-oauth', authorizationAcknowledged: true }, {
    now: () => now,
    loadLocalClientSecret: async () => clientSecret,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (init.method !== 'POST' || ![tokenEndpoint, loadEndpoint, modelsEndpoint].includes(url)) {
        unexpected.push('unhandled endpoint or method');
        throw Error('Unhandled offline request');
      }
      if (url === tokenEndpoint) {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('client_secret'), clientSecret);
        const refresh = form.get('grant_type') === 'refresh_token';
        assert.equal(form.get('grant_type'), refresh ? 'refresh_token' : 'authorization_code');
        if (refresh) assert.equal(form.get('refresh_token'), REFRESH_A);
        else assert.equal(form.get('code'), 'synthetic-code');
        return Response.json({ access_token: refresh ? ACCESS_B : ACCESS_A,
          ...(refresh ? {} : { refresh_token: REFRESH_A, id_token: ID_A }), token_type: 'Bearer', expires_in: 3600 });
      }
      if (url === loadEndpoint) {
        state.afterLoad?.();
        return Response.json({ cloudaicompanionProject: 'synthetic-project' });
      }
      return Response.json(catalog());
    },
  }).setup({
    integration: {
      transform: async callback => {
        await callback({ method: { update(value) { method = value; } }, update() {} });
        return { dispose: async () => {} };
      },
      connection: {
        active: async () => state.active,
        resolve: async connection => {
          assert.equal(connection, state.active);
          let value = accounts.get(connection.id);
          if (value && value.expires <= now + 5000) value = persist(await method.refresh(value));
          resolved.push(value);
          state.afterResolve?.();
          return value;
        },
      },
    },
    event: providerHost.event, provider: providerHost.provider,
  });
  t.after(cleanup);
  return {
    state, requests, resolved, added, accounts, diagnostics: providerHost.diagnostics,
    discover: providerHost.run,
    advanceTo: value => { now = value; },
    async login() {
      state.active = selected('account-a');
      const authorization = await method.authorize();
      const callback = new URL('https://antigravity.google/oauth-callback');
      callback.searchParams.set('state', new URL(authorization.url).searchParams.get('state'));
      callback.searchParams.set('code', 'synthetic-code');
      const value = await authorization.callback(callback.href);
      Schema.decodeUnknownSync(Credential.OAuth)(value);
      return persist(value);
    },
  };
}

test('should discover with the callback access token and rediscover with the host-persisted refreshed access token', async t => {
  const host = await setup(t);
  assert.equal(host.requests.length, 0);
  const credentialA = await host.login();
  assert.equal(host.accounts.get('account-a'), credentialA);
  assert.equal(credentialA.access, ACCESS_A);
  assert.equal(credentialA.refresh, REFRESH_A);
  assert.equal(JSON.stringify(credentialA).includes(ID_A), false);
  assertNoTokens(credentialA.metadata);

  await host.discover();
  assert.equal(host.resolved[0], credentialA);
  await host.discover();
  assert.equal(host.requests.length, 3);

  host.advanceTo(credentialA.expires + 1);
  await host.discover();
  const credentialB = host.accounts.get('account-a');
  assert.notEqual(credentialB, credentialA);
  assert.equal(host.resolved.at(-1), credentialB);
  assert.equal(credentialB.access, ACCESS_B);
  assert.equal(credentialB.refresh, REFRESH_A);
  assert.equal(credentialA.access, ACCESS_A);
  assertNoTokens(credentialB.metadata);

  assert.deepEqual(host.requests.map(request => request.url), [
    tokenEndpoint, loadEndpoint, modelsEndpoint, tokenEndpoint, loadEndpoint, modelsEndpoint,
  ]);
  const catalogRequests = host.requests.filter(request => request.url !== tokenEndpoint);
  assert.deepEqual(catalogRequests.map(({ init }) => new Headers(init.headers).get('authorization')), [
    `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`,
  ]);
  for (const { url, init } of catalogRequests) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.deepEqual(JSON.parse(init.body), url === loadEndpoint ? { metadata: { ideType: 9 } } : { project: 'synthetic-project' });
    assertNoTokens({ url, body: init.body });
    assert.equal(JSON.stringify(init.headers).includes(REFRESH_A), false);
    assert.equal(JSON.stringify(init.headers).includes(ID_A), false);
    assert.equal(JSON.stringify(init.headers).includes(clientSecret), false);
  }
  for (const provider of host.added) {
    Schema.decodeUnknownSync(Provider.Info)(provider.info);
    Schema.decodeUnknownSync(Model.Info)(provider.models[0]);
    assert.equal(provider.sourceConnection, host.state.active);
    assert.equal(provider.models[0].id, 'synthetic-chat');
    assert.equal(provider.info.settings.configuredConnection, 'account-a');
    assertNoTokens(provider);
  }
  assert.equal(host.added.length, 3);
});

for (const boundary of ['resolution', 'loadCodeAssist']) {
  test(`should report discovery failure without publishing when the selected account changes during ${boundary}`, async t => {
    const host = await setup(t);
    const credential = await host.login();
    const switchAccount = () => { host.state.active = selected('account-b'); };
    if (boundary === 'resolution') host.state.afterResolve = switchAccount;
    else host.state.afterLoad = switchAccount;

    await host.discover();
    assertDiagnostic(host, error => {
      assert.match(error.message, /invalid or unsupported operation/u);
      assertNoTokens({ message: error.message, ...error });
      return true;
    });

    assert.equal(host.resolved[0], credential);
    assert.equal(host.accounts.get('account-a'), credential);
    assert.equal(host.accounts.has('account-b'), false);
    assert.deepEqual(host.added, []);
    assert.deepEqual(host.requests.map(request => request.url), boundary === 'resolution' ? [tokenEndpoint] : [tokenEndpoint, loadEndpoint]);
  });
}
