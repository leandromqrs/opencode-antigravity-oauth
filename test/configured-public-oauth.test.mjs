import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as plugins from '../dist/configured-plugin.js';
import { binding, createHTTP, PublicOAuthDiagnostic, validateConfiguration } from '../dist/configured-security.js';

const options = () => ({ mode: 'agy-public-oauth', authorizationAcknowledged: true });
const clientID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const callback = 'https://antigravity.google/oauth-callback';
const scopes = ['cloud-platform', 'userinfo.email', 'userinfo.profile', 'cclog', 'experimentsandconfigs'].map(s => `https://www.googleapis.com/auth/${s}`);
const response = (extra = {}) => Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', token_type: 'Bearer', expires_in: 3600, ...extra });

async function setup(plugin, supplied = {}) {
  let method, disposals = 0, reads = 0, selected;
  const context = {
    options: options(),
    integration: {
      transform: async edit => { await edit({ method: { update: value => { method = value; } }, update() {} }); return { dispose: async () => { disposals++; } }; },
      connection: { active: async () => { reads++; return selected; }, resolve() { throw Error('unexpected credential resolution'); } },
    },
    get provider() { throw Error('OAuth-only must not register a provider/runtime'); },
    get storage() { throw Error('host owns credential storage'); },
    ...supplied,
  };
  const cleanup = await plugin.setup(context);
  return { method, cleanup, reads: () => reads, disposals: () => disposals, select: value => { selected = value; } };
}
const completion = transaction => `${callback}?state=${new URL(transaction.url).searchParams.get('state')}&code=fixture-code`;

test('public login accepts the displayed authorization code with clipboard padding, retaining registered redirect and PKCE', async () => {
  let sent;
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async (url, init) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token'); sent = new URLSearchParams(init.body); return response();
  } }));
  const transaction = await host.method.authorize();
  const credential = await transaction.callback(' \n4/fixture+authorization=code\r\n ');
  assert.match(transaction.instructions, /Copy the code shown on Antigravity callback page/u);
  assert.match(transaction.instructions, /Do not paste access\/refresh tokens/u);
  assert.equal(credential.access, 'fixture-access');
  assert.equal(sent.get('code'), '4/fixture+authorization=code');
  assert.equal(sent.get('redirect_uri'), callback); assert.equal(sent.get('client_id'), clientID);
  assert.equal(sent.has('client_secret'), false);
  assert.equal(createHash('sha256').update(sent.get('code_verifier')).digest('base64url'), new URL(transaction.url).searchParams.get('code_challenge'));
  await assert.rejects(transaction.callback('4/fixture+authorization=code'));
  await host.cleanup();
});

test('public pasted codes reject malformed input before HTTP and retain expiry and one-use limits', async () => {
  let requests = 0, now = 1_000;
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { now: () => now, fetch: async () => { requests++; return response(); } }));
  for (const value of ['', ' \r\n ', 'has space', 'has\tcontrol', 'code\0value', 'code\u007f', 'é', 'x'.repeat(2049), ' '.repeat(8193),
    'https://untrusted.invalid/?code=fixture', 'http://antigravity.google/oauth-callback?code=fixture', '//untrusted.invalid/code',
    callback, `${callback}?code=fixture&state=wrong`, 'javascript:fixture']) {
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback(value), error => !error.message.includes(value) || value.length === 0);
    await assert.rejects(transaction.callback('fixture-valid-code'));
  }
  const expired = await host.method.authorize(); now = expired.expiresAt;
  await assert.rejects(expired.callback('fixture-expired-code'));
  assert.equal(requests, 0); await host.cleanup();
});

test('public bare-code cross-transaction binding is enforced by the token server PKCE check, not fabricated returned state', async () => {
  const expected = new Map(); let requests = 0;
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async (_url, init) => {
    requests++;
    const form = new URLSearchParams(init.body);
    const challenge = createHash('sha256').update(form.get('code_verifier')).digest('base64url');
    return expected.get(form.get('code')) === challenge ? response() : Response.json({ error: 'invalid_grant', error_description: 'PRIVATE-DETAIL' }, { status: 400 });
  } }));
  const a = await host.method.authorize(), b = await host.method.authorize();
  expected.set('fixture-code-a', new URL(a.url).searchParams.get('code_challenge'));
  expected.set('fixture-code-b', new URL(b.url).searchParams.get('code_challenge'));
  await assert.rejects(a.callback('fixture-code-b'), error => !error.message.includes('PRIVATE-DETAIL'));
  await assert.rejects(b.callback('fixture-code-a'));
  assert.equal(requests, 2);
  await assert.rejects(a.callback('fixture-code-a'));
  await host.cleanup();
});

test('explicit public OAuth-only root setup is inert and registers only integration authorize/refresh', async () => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw Error('network forbidden'); };
  try {
  const { default: root } = await import('opencode-google-antigravity-oauth');
    const host = await setup(root);
    assert.equal(host.reads(), 0); assert.equal(requests, 0);
    assert.equal(host.method.integrationID, 'agy-public-oauth');
    assert.equal(typeof host.method.authorize, 'function'); assert.equal(typeof host.method.refresh, 'function');
    await host.cleanup(); await host.cleanup(); assert.equal(host.disposals(), 1);
  } finally { globalThis.fetch = previous; }
});

test('public preset pins public client, five evidenced base scopes and full HTTPS callback with PKCE; grants and refresh omit secrets', async () => {
  const requests = [];
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async (url, init) => {
    requests.push({ url, init }); return response({ id_token: 'discarded-opaque-id-token', scope: [...scopes, 'extra-grant'].join(' ') });
  } }));
  const transaction = await host.method.authorize();
  const url = new URL(transaction.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), clientID); assert.equal(url.searchParams.get('redirect_uri'), callback);
  assert.deepEqual(url.searchParams.get('scope').split(' '), scopes);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.match(url.searchParams.get('state'), /^[\w-]{22}$/);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(requests.length, 0);
  const credential = await transaction.callback(completion(transaction));
  assert.equal(credential.access, 'fixture-access'); assert.equal(JSON.stringify(credential).includes('discarded-opaque'), false);
  await host.method.refresh(credential);
  assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), clientID); assert.equal(form.has('client_secret'), false);
    assert.equal(new Headers(init.headers).has('authorization'), false);
  }
  const first = new URLSearchParams(requests[0].init.body);
  assert.equal(first.get('redirect_uri'), callback);
  assert.equal(createHash('sha256').update(first.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(new URLSearchParams(requests[1].init.body).get('grant_type'), 'refresh_token');
  await assert.rejects(transaction.callback(completion(transaction)));
  await host.cleanup();
});

test('public mode rejects overrides/accessors and incomplete configured mode never falls back', () => {
  const dependencies = { fetch: async () => { throw Error('forbidden'); } };
  assert.equal(typeof plugins.createAntigravityPlugin(options(), dependencies).setup, 'function');
  for (const invalid of [{}, { authorizationAcknowledged: true }, { mode: 'agy-public-oauth' },
    { ...options(), authorizationAcknowledged: false }, { ...options(), clientId: 'other' }, { ...options(), inference: {} },
    { ...options(), models: [] }, { ...options(), oauth: {} }, { ...options(), mode: 'other' },
    { ...options(), get name() { throw Error('accessor executed'); } },
    { authorizationAcknowledged: true, get mode() { throw Error('accessor executed'); } }]) {
    assert.throws(() => plugins.createAntigravityPlugin(invalid, dependencies), error => !error.message.includes('accessor executed'));
  }
  assert.throws(() => plugins.createSyntheticAntigravityPlugin(options(), dependencies));
});

test('public mode preserves duplicate winner and rejects late account changes and disposed transactions', { timeout: 2000 }, async () => {
  let release;
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async () => new Promise(resolve => { release = () => resolve(response()); }) }));
  const transaction = await host.method.authorize();
  const winner = transaction.callback('fixture-code');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(transaction.callback('fixture-code'));
  release(); const credential = await winner;
  release = undefined;
  const refresh = host.method.refresh(credential);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  host.select({ type: 'credential', id: 'account-b', method: 'oauth' }); release();
  await assert.rejects(refresh);
  release = undefined;
  const delayed = await host.method.authorize();
  const late = delayed.callback('fixture-late-code');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  host.select({ type: 'credential', id: 'account-c', method: 'oauth' }); release();
  await assert.rejects(late);
  const pending = await host.method.authorize(); await host.cleanup();
  await assert.rejects(pending.callback('fixture-disposed-code'));
});

test('public mode classifies bounded invalid_client safely without leaking remote bodies; other token failures remain sanitized', async () => {
  for (const status of [400, 401]) {
    let rejected = true;
    const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async () => rejected ? Response.json({ error: 'invalid_client', error_description: 'REMOTE-PRIVATE-DATA' }, { status }) : response() }));
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback(completion(transaction)), error => error.message.startsWith('Public OAuth client rejected (invalid_client); secretless compatibility is unverified; stage=token_response reason=http_error') && error.status === status);
    rejected = false;
    const second = await host.method.authorize();
    const credential = await second.callback(completion(second));
    rejected = true;
    await assert.rejects(host.method.refresh(credential), error => error.message.startsWith('Public OAuth client rejected (invalid_client); secretless compatibility is unverified; stage=token_response reason=http_error') && error.status === status);
    await host.cleanup();
  }
  for (const result of [Response.json({ error: 'invalid_grant', error_description: 'REMOTE-PRIVATE-DATA' }, { status: 400 }),
    Response.json({ error: 'invalid_client', error_description: 'x'.repeat(65536) }, { status: 400 }),
    response({ token_type: 'bearer' }), response({ scope: scopes.slice(1).join(' ') }),
    new Response(null, { status: 307, headers: { Location: 'https://untrusted.invalid' } })]) {
    const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async () => result }));
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback(completion(transaction)), error => !/REMOTE-PRIVATE|invalid_client|fixture-access|untrusted/u.test(error.message));
    await host.cleanup();
  }
});

test('existing complete configuration keeps its exact credential binding', () => {
  const config = validateConfiguration({ authorizationAcknowledged: true, providerId: 'antigravity', integrationId: 'antigravity-oauth', name: 'Existing',
    oauth: { issuer: 'https://accounts.google.com', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: 'operator-client', redirectUri: callback, scopes: ['openid'] },
    inference: { endpoint: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent', project: 'operator-project', textSemantics: 'delta', usageSemantics: 'single-report' },
    models: [{ id: 'operator-model', modelID: 'operator-model', providerID: 'antigravity', name: 'Model', capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 100, output: 10 } }],
  });
  const expected = createHash('sha256').update(JSON.stringify([config.providerId, config.integrationId, config.oauth, config.inference, config.models.map(model => model.id)])).digest('hex');
  assert.equal(binding(config), expected);
});

test('public diagnostic stages retain only fixed reasons, numeric status and allowlisted OAuth errors', async () => {
  const privateValue = 'DO-NOT-EXPOSE-private-code-token-description';
  const cases = [
    { input: 'bad input', fetch: async () => { throw Error('must not fetch'); }, stage: 'authorization_input', reason: 'invalid' },
    { fetch: async () => { throw Error(privateValue); }, stage: 'token_request', reason: 'network' },
    ...['invalid_client', 'invalid_grant', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'access_denied', 'temporarily_unavailable', 'server_error', privateValue].map(error => ({
      fetch: async () => Response.json({ error, error_description: privateValue, [privateValue]: privateValue }, { status: 403 }),
      stage: 'token_response', reason: 'http_error', status: 403, oauthError: error === privateValue ? 'unknown' : error,
    })),
    { fetch: async () => Response.json({ error: 'temporarily_unavailable' }, { status: 429 }), stage: 'token_response', reason: 'http_error', status: 429, oauthError: 'temporarily_unavailable' },
    { fetch: async () => new Response(null, { status: 307, headers: { Location: `https://invalid.example/${privateValue}` } }), stage: 'token_response', reason: 'redirect', status: 307 },
    { fetch: async () => new Response(privateValue, { status: 200 }), stage: 'response_read', reason: 'json', status: 200 },
    { fetch: async () => new Response('x'.repeat(65537)), stage: 'response_read', reason: 'body', status: 200 },
    { fetch: async () => new Response(new ReadableStream({ start(controller) { controller.error(Error(privateValue)); } })), stage: 'response_read', reason: 'body', status: 200 },
    { fetch: async () => response({ [privateValue]: privateValue }), stage: 'token_validation', reason: 'unsupported_response_fields', status: 200 },
    { fetch: async () => Response.json(null), stage: 'token_validation', reason: 'schema', status: 200 },
    ...[['token_type', 'bearer'], ['access_token', ''], ['expires_in', 0], ['refresh_token', 'has space'], ['scope', 'other']].map(([reason, value]) => ({
      fetch: async () => response({ [reason]: value }), stage: 'token_validation', reason, status: 200,
    })),
  ];
  for (const entry of cases) {
    const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: entry.fetch }));
    const transaction = await host.method.authorize();
    await assert.rejects(transaction.callback(entry.input ?? 'fixture-diagnostic-code'), error => {
      assert.equal(error.stage, entry.stage); assert.equal(error.reason, entry.reason);
      assert.equal(error.status, entry.status); assert.equal(error.oauthError, entry.oauthError);
      assert.equal(error.cause, undefined);
      assert.match(error.message, new RegExp(`stage=${entry.stage} reason=${entry.reason}`));
      assert.equal(`${error.message}${JSON.stringify(error)}`.includes(privateValue), false);
      assert.doesNotMatch(error.message, /https?:|fixture-diagnostic-code/u);
      return true;
    });
    await host.cleanup();
  }
});

test('diagnostic constructors sanitize runtime values and nonpublic HTTP errors retain their generic contract', async () => {
  const privateValue = 'PRIVATE-arbitrary-runtime-input';
  const diagnostic = new PublicOAuthDiagnostic(privateValue, privateValue, NaN, privateValue);
  assert.equal(diagnostic.message, 'Public OAuth diagnostic: stage=token_validation reason=schema oauth_error=unknown');
  assert.equal(JSON.stringify(diagnostic).includes(privateValue), false);
  for (const fetch of [async () => { throw Error(privateValue); }, async () => Response.json({ error: 'invalid_grant', error_description: privateValue }, { status: 400 })]) {
    await assert.rejects(createHTTP(fetch).json('https://auth.invalid/token', new URLSearchParams(), new AbortController().signal), error => {
      assert.equal(error.message, 'Configured OAuth integration: invalid or unsupported operation');
      assert.equal(error.stage, undefined); assert.equal(error.cause, undefined); return true;
    });
  }
});

test('public request cancellation and timeout have fixed diagnostics without injected abort reasons', { timeout: 2000 }, async () => {
  const host = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async () => new Promise(() => {}) }));
  const transaction = await host.method.authorize();
  const pending = transaction.callback('fixture-cancel-code');
  const cancelled = assert.rejects(pending, error => error.stage === 'token_request' && error.reason === 'aborted' && error.cause === undefined);
  await new Promise(resolve => setImmediate(resolve));
  await host.cleanup(); await cancelled;
  const original = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => original(milliseconds === 30000 ? 0 : milliseconds);
  try {
    const timed = await setup(plugins.createPublicAntigravityOAuthPlugin(options(), { fetch: async () => new Promise(() => {}) }));
    const attempt = await timed.method.authorize();
    const rejected = assert.rejects(attempt.callback('fixture-timeout-code'), error => error.stage === 'token_request' && error.reason === 'timeout' && error.cause === undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    await rejected; await timed.cleanup();
  } finally { AbortSignal.timeout = original; }
});
