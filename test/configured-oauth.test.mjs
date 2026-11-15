import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthClient } from '../dist/configured-oauth.js';
import { validateSyntheticConfiguration as validateConfiguration, createHTTP } from '../dist/configured-security.js';

export const options = () => ({ authorizationAcknowledged: true, providerId: 'configured-antigravity', integrationId: 'configured-antigravity-oauth', name: 'Synthetic configured OAuth',
  oauth: { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', clientId: 'synthetic-public-client', redirectUri: 'https://callback.example/complete', scopes: ['synthetic.inference'] },
  inference: { endpoint: 'https://inference.example/stream', project: 'synthetic-project', textSemantics: 'delta', usageSemantics: 'single-report' },
  models: [{ id: 'synthetic-model', modelID: 'synthetic-model', providerID: 'configured-antigravity', name: 'Synthetic fixture model',
    capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 100, output: 10 } }],
});
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const grant = (patch = {}) => ({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600, ...patch });
const callback = login => `${options().oauth.redirectUri}?state=${new URL(login.url).searchParams.get('state')}&code=synthetic-code`;
const sanitized = e => !e.message.includes('synthetic-access') && !e.message.includes('secret');

test('PKCE manual full-URL transaction exchanges a one-shot code with pinned form destination', async () => {
  let request;
  const client = createOAuthClient(validateConfiguration(options()), { fetch: async (url, init) => { request = { url, init }; return response(grant()); } });
  const login = client.begin(); const url = new URL(login.url);
  assert.equal(url.origin, 'https://auth.example'); assert.equal(url.searchParams.get('client_id'), 'synthetic-public-client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.equal(url.searchParams.get('client_secret'), null);
  const credential = await login.complete(callback(login));
  assert.equal(credential.type, 'oauth'); assert.equal(credential.access, 'synthetic-access'); assert.equal(credential.refresh, 'synthetic-refresh');
  assert.equal(request.url, options().oauth.tokenEndpoint); assert.equal(request.init.redirect, 'error'); assert.equal(request.init.credentials, 'omit');
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code'); assert.equal(form.get('code'), 'synthetic-code');
  const { deriveS256Challenge } = await import('../dist/oauth-workbench.js');
  assert.equal(deriveS256Challenge(form.get('code_verifier')), url.searchParams.get('code_challenge'));
  await assert.rejects(login.complete(callback(login)), sanitized);
  client.close();
});

test('state, denial, expiration and cancellation consume transactions without requests', async () => {
  let calls = 0, now = 1000;
  const client = createOAuthClient(validateConfiguration(options()), { now: () => now, fetch: async () => { calls++; return response(grant()); } });
  for (const kind of ['state', 'deny', 'expire', 'cancel', 'code-only']) {
    const login = client.begin(); let value = callback(login);
    if (kind === 'state') value = value.replace(/state=[^&]+/, 'state=invalid-state-with-enough-length');
    if (kind === 'deny') value = value.replace('code=synthetic-code', 'error=access_denied');
    if (kind === 'expire') now += 300_001;
    if (kind === 'cancel') login.cancel();
    if (kind === 'code-only') value = 'synthetic-code';
    await assert.rejects(login.complete(value), sanitized);
    await assert.rejects(login.complete(callback(login)));
  }
  assert.equal(calls, 0); client.close(); assert.throws(() => client.begin());
});

test('refresh is configuration-bound, single-flight and preserves/rotates refresh token', async () => {
  let calls = 0; const requests = [];
  const client = createOAuthClient(validateConfiguration(options()), { fetch: async (_url, init) => {
    requests.push(new URLSearchParams(init.body)); calls++;
    return response(calls === 1 ? grant() : grant({ access_token: `synthetic-access-${calls}`, refresh_token: undefined }));
  } });
  const login = client.begin(); const original = await login.complete(callback(login));
  const [a, b] = await Promise.all([client.refresh(original), client.refresh(original)]);
  assert.deepEqual(a, b); assert.equal(calls, 2); assert.equal(a.refresh, original.refresh);
  assert.equal(requests[1].get('grant_type'), 'refresh_token'); assert.equal(requests[1].get('client_secret'), null);
  const foreignOptions = options(); foreignOptions.oauth.clientId = 'different-client';
  const foreign = createOAuthClient(validateConfiguration(foreignOptions), { fetch: async () => { throw Error('must not call'); } });
  await assert.rejects(foreign.refresh(original), sanitized);
  await assert.rejects(client.refresh({ ...original, refresh: '', metadata: original.metadata }));
  client.close(); foreign.close();
});

test('token response validation refuses malformed, excess and ambiguous credentials', async () => {
  for (const body of [grant({ token_type: 'MAC' }), grant({ expires_in: 0 }), grant({ expires_in: '3600' }), grant({ access_token: 'secret\r\n' }),
    grant({ scope: 'unexpected.scope' }), grant({ id_token: 'secret\r\n' }), grant({ extra: 'secret' })]) {
    const client = createOAuthClient(validateConfiguration(options()), { fetch: async () => response(body) });
    const login = client.begin(); await assert.rejects(login.complete(callback(login)), sanitized); client.close();
  }
});

test('endpoint configuration refuses unsafe URLs, issuer mismatches, injected secrets and model capabilities', () => {
  for (const change of [o => { o.oauth.tokenEndpoint = 'http://auth.example/token'; }, o => { o.oauth.tokenEndpoint = 'https://other.example/token'; },
    o => { o.inference.endpoint = 'https://user:secret@inference.example/stream'; }, o => { o.oauth.clientSecret = 'secret'; },
    o => { o.oauth.scopes = ['']; }, o => { o.models[0].capabilities.tools = true; }, o => { o.models[0].settings = { apiKey: 'secret' }; },
    o => { o.models[0].limit.context = 0; }, o => { o.models[0].providerID = 'other'; }, o => { o.inference.textSemantics = 'auto'; }]) {
    const config = options(); change(config); assert.throws(() => validateConfiguration(config), sanitized);
  }
});

test('usage policy accepts explicit snapshots but not inferred aggregation', () => {
  const config = options(); config.inference.usageSemantics = 'cumulative-snapshot';
  assert.equal(validateConfiguration(config).inference.usageSemantics, 'cumulative-snapshot');
  for (const policy of ['auto', 'sum', '', undefined]) {
    const invalid = options(); invalid.inference.usageSemantics = policy;
    assert.throws(() => validateConfiguration(invalid));
  }
});

test('HTTP helper refuses redirects/errors, bounds JSON, strips exceptions and aborts pending readers', { timeout: 5000 }, async () => {
  for (const fetcher of [...[302, 307, 308].map(status => async () => new Response('secret', { status, headers: { location: 'https://other.example' } })),
    async () => new Response('secret', { status: 401 }), async () => new Response('x'.repeat(65537)), async () => { throw Error('secret'); }]) {
    const http = createHTTP(fetcher);
    await assert.rejects(http.json(options().oauth.tokenEndpoint, new URLSearchParams(), new AbortController().signal), sanitized);
  }
  let entered, cancelled = false;
  const started = new Promise(resolve => { entered = resolve; });
  const http = createHTTP(async () => new Response(new ReadableStream({ pull() { entered(); return new Promise(() => {}); }, cancel() { cancelled = true; } })));
  const controller = new AbortController();
  const pending = http.json(options().oauth.tokenEndpoint, new URLSearchParams(), controller.signal);
  await started; controller.abort('secret'); await assert.rejects(pending, sanitized); assert.equal(cancelled, true);
});

test('configuration is a bounded immutable JSON snapshot, never executes nested accessors', () => {
  let touched = false;
  const malicious = options();
  Object.defineProperty(malicious.oauth, 'clientId', { enumerable: true, get() { touched = true; throw Error('secret'); } });
  assert.throws(() => validateConfiguration(malicious), sanitized); assert.equal(touched, false);
  const circular = options(); circular.oauth.scopes.push(circular);
  assert.throws(() => validateConfiguration(circular), sanitized);
  const sparse = options(); sparse.models[0].capabilities.input = new Array(1_000_000_000);
  assert.throws(() => validateConfiguration(sparse), sanitized);
  const prototype = options(); prototype.oauth = JSON.parse('{"__proto__":{},"issuer":"https://auth.example"}');
  assert.throws(() => validateConfiguration(prototype), sanitized);
  const original = options(), validated = validateConfiguration(original);
  original.oauth.tokenEndpoint = 'https://other.example/token'; original.models[0].name = 'changed';
  assert.equal(validated.oauth.tokenEndpoint, options().oauth.tokenEndpoint); assert.equal(Object.isFrozen(validated.models[0].capabilities), true);
});

test('transaction bound, concurrent completion and cancelled in-flight fetch cannot issue credentials', { timeout: 5000 }, async () => {
  let called, release;
  const started = new Promise(resolve => { called = resolve; });
  const client = createOAuthClient(validateConfiguration(options()), { fetch: () => { called(); return new Promise(resolve => { release = resolve; }); } });
  const logins = Array.from({ length: 32 }, () => client.begin());
  assert.throws(() => client.begin()); logins[1].cancel(); const extra = client.begin(); extra.cancel();
  const pending = logins[0].complete(callback(logins[0]));
  await started; await assert.rejects(logins[0].complete(callback(logins[0])));
  logins[0].cancel(); await assert.rejects(pending, sanitized);
  release(response(grant())); client.close();
});

test('missing refresh is SDK empty-string sentinel, invalid_grant is sanitized and rotation is returned', async () => {
  const client = createOAuthClient(validateConfiguration(options()), { fetch: async () => response(grant({ refresh_token: undefined })) });
  const login = client.begin(); const credential = await login.complete(callback(login));
  assert.equal(credential.refresh, ''); await assert.rejects(client.refresh(credential)); client.close();
  let calls = 0;
  const rotating = createOAuthClient(validateConfiguration(options()), { fetch: async () => response(calls++ ? grant({ refresh_token: 'rotated-refresh' }) : grant()) });
  const first = rotating.begin(); const initial = await first.complete(callback(first));
  assert.equal((await rotating.refresh(initial)).refresh, 'rotated-refresh'); rotating.close();
  let requests = 0;
  const denied = createOAuthClient(validateConfiguration(options()), { fetch: async () => requests++ === 0 ? response(grant())
    : new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'secret' }), { status: 400 }) });
  const authorization = denied.begin(); const saved = await authorization.complete(callback(authorization));
  await assert.rejects(denied.refresh(saved), sanitized); assert.equal(requests, 2); denied.close();
});

test('duplicate completion cannot cancel the transaction already exchanging its code', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const client = createOAuthClient(validateConfiguration(options()), { fetch: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const transaction = client.begin();
  const first = transaction.complete(callback(transaction));
  const outcome = first.then(value => ({ value }), error => ({ error }));
  await started; await assert.rejects(transaction.complete(callback(transaction)));
  release(response(grant()));
  const result = await outcome;
  assert.equal(result.error, undefined); assert.equal(result.value.access, 'synthetic-access'); client.close();
});

test('local configuration requires explicit operator authorization acknowledgment', () => {
  const configuration = options();
  delete configuration.authorizationAcknowledged;
  assert.throws(() => validateConfiguration(configuration));
  configuration.authorizationAcknowledged = false;
  assert.throws(() => validateConfiguration(configuration));
});

test('bounded opaque id_token is ignored rather than decoded, persisted or used as identity', async () => {
  const configuration = options(); configuration.oauth.scopes.push('openid');
  const client = createOAuthClient(validateConfiguration(configuration), { fetch: async () => response(grant({ id_token: 'synthetic.opaque.not-verified' })) });
  const login = client.begin(); const credential = await login.complete(callback(login));
  assert.equal(JSON.stringify(credential).includes('synthetic.opaque'), false);
  assert.equal('id_token' in credential, false); assert.equal('sub' in credential.metadata, false); client.close();
});

test('two independent PKCE transactions cannot cross-complete or exchange swapped callbacks', async () => {
  let calls = 0;
  const client = createOAuthClient(validateConfiguration(options()), { fetch: async () => { calls++; return response(grant()); } });
  const a = client.begin(), b = client.begin();
  assert.notEqual(new URL(a.url).searchParams.get('state'), new URL(b.url).searchParams.get('state'));
  assert.notEqual(new URL(a.url).searchParams.get('code_challenge'), new URL(b.url).searchParams.get('code_challenge'));
  await assert.rejects(a.complete(callback(b))); await assert.rejects(b.complete(callback(a)));
  await assert.rejects(a.complete(callback(a))); await assert.rejects(b.complete(callback(b)));
  assert.equal(calls, 0); client.close();
});

test('explicit granted scope must contain every required scope; extra grants do not become metadata or entitlement', async () => {
  const configuration = options(); configuration.oauth.scopes.push('synthetic.required');
  for (const [scope, accepted] of [['synthetic.inference synthetic.required synthetic.extra', true], ['synthetic.inference', false], ['synthetic.required', false]]) {
    const client = createOAuthClient(validateConfiguration(configuration), { fetch: async () => response(grant({ scope })) });
    const login = client.begin();
    if (accepted) {
      const credential = await login.complete(callback(login));
      assert.equal(JSON.stringify(credential).includes('synthetic.extra'), false);
    } else await assert.rejects(login.complete(callback(login)), sanitized);
    client.close();
  }
});
