import assert from 'node:assert/strict';
import { createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { createAntigravityPlugin, createSyntheticAntigravityPlugin } from '../dist/configured-plugin.js';

const production = () => ({ authorizationAcknowledged: true, providerId: 'antigravity', integrationId: 'antigravity-oauth', name: 'Explicit authorized configuration',
  oauth: { issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: 'operator-supplied-public-client', redirectUri: 'https://antigravity.google/oauth-callback', scopes: ['openid', 'https://www.googleapis.com/auth/cloud-platform'] },
  inference: { endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', project: 'operator-project', textSemantics: 'delta', usageSemantics: 'single-report' },
  models: [{ id: 'operator-model', modelID: 'operator-model', providerID: 'antigravity', name: 'Operator supplied model metadata', capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 100, output: 10 } }],
});

test('production accepts reviewed Google cross-origin OAuth policy without network or embedded client identity', () => {
  let calls = 0;
  const plugin = createAntigravityPlugin(production(), { fetch: async () => { calls++; throw Error('not permitted'); } });
  assert.equal(typeof plugin.setup, 'function'); assert.equal(calls, 0);
});

test('production caller cannot expand reviewed destinations, redirect or scopes', () => {
  const changes = [c => { c.oauth.issuer = 'https://other.invalid'; }, c => { c.oauth.authorizationEndpoint += '/'; },
    c => { c.oauth.tokenEndpoint = 'https://accounts.google.com/token'; }, c => { c.oauth.redirectUri = 'https://callback.invalid/complete'; },
    c => { c.oauth.scopes.push('https://www.googleapis.com/auth/drive'); }, c => { c.inference.endpoint = 'https://other.invalid/v1internal:streamGenerateContent'; },
    c => { c.inference.endpoint = 'https://cloudcode-pa.googleapis.com/other'; }, c => { c.inference.endpoint += '&other=value'; },
    c => { c.oauth.authorizationEndpoint += '?redirect=other'; }, c => { c.oauth.clientSecret = 'secret'; }, c => { c.authorizationAcknowledged = false; }];
  for (const change of changes) {
    const config = production(); change(config);
    assert.throws(() => createAntigravityPlugin(config, { fetch: async () => { throw Error('must not request'); } }), e => !e.message.includes('secret'));
  }
});

test('synthetic construction cannot target production and production cannot select reserved-host policy', () => {
  const dependencies = { fetch: async () => { throw Error('must not request'); } };
  assert.throws(() => createSyntheticAntigravityPlugin(production(), dependencies));
  const config = production();
  config.oauth = { ...config.oauth, issuer: 'https://auth.invalid', authorizationEndpoint: 'https://auth.invalid/authorize', tokenEndpoint: 'https://auth.invalid/token', redirectUri: 'https://callback.invalid/complete' };
  config.inference.endpoint = 'https://inference.invalid/stream';
  assert.equal(typeof createSyntheticAntigravityPlugin(config, dependencies).setup, 'function');
  assert.throws(() => createAntigravityPlugin(config, dependencies));
});

test('root is an inert native plugin and setup reads ctx.options without starting authorization or inference', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0, integrations = 0, providers = 0;
  globalThis.fetch = async () => { requests++; throw Error('unexpected network'); };
  try {
    const { default: plugin } = await import('opencode-google-antigravity-oauth');
    assert.equal(typeof plugin.setup, 'function'); assert.equal(requests, 0);
    await assert.rejects(plugin.setup({ options: {} }));
    const providerHost = createProviderHost(() => { providers++; });
    const cleanup = await plugin.setup({ options: production(),
      integration: { transform: async callback => { integrations++; await callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; }, connection: { active: async () => undefined } },
      event: providerHost.event, provider: providerHost.provider,
      storage: new Proxy({}, { get() { throw Error('credential storage access'); } }),
    });
    assert.equal(integrations, 1); assert.equal(providers, 0); assert.equal(requests, 0); await cleanup();
  } finally { globalThis.fetch = originalFetch; }
});
