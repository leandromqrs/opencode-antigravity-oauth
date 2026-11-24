import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { quotaV1FromSummary, unavailableQuotaV1, fetchQuotaSummary, fetchAccountEmail, quotaV1ForAccounts, startQuotaBridge } from '../dist/configured-quota.js';
import { binding, validateLocalOAuthConfiguration, validatePublicOAuthConfiguration } from '../dist/configured-security.js';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { createProviderHost } from './helpers/provider-host.mjs';

const token = 'q'.repeat(48);
const observedAt = '2026-11-14T12:00:00.000Z';
const loadEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const modelsEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const quotaEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const userinfoEndpoint = 'https://www.googleapis.com/oauth2/v3/userinfo';
const apiKeyEnv = 'ANTIGRAVITY_QUOTA_TEST_KEY';
const bridgeUrl = port => `http://127.0.0.1:${port}/quota`;

async function freePort(reserve = false) {
  const server = net.createServer();
  await new Promise(resolve => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const { port } = server.address();
  if (!reserve) { await new Promise(resolve => server.close(resolve)); return port; }
  return { port, release: () => new Promise(resolve => server.close(resolve)) };
}

function catalogFetch(summary) {
  const calls = { count: 0, requests: [], unhandled: [] };
  const fetch = async (url, init) => {
    calls.requests.push({ url, body: init.body && JSON.parse(init.body), authorization: new Headers(init.headers).get('authorization') });
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === quotaEndpoint) { calls.count++; return summary(); }
    if (url === userinfoEndpoint) return Response.json({ email: 'synthetic@example.com' });
    calls.unhandled.push(url);
    return new Response('', { status: 599 });
  };
  return { calls, fetch };
}

async function quotaPlugin({ port, bridge = true, active = 'A' } = {}) {
  const quotaBridge = bridge === false ? undefined : { port, apiKeyEnv, ...(bridge === true ? {} : bridge) };
  const options = { mode: 'google-agy-oauth', authorizationAcknowledged: true, ...(quotaBridge ? { quotaBridge } : {}) };
  const config = validateLocalOAuthConfiguration(options);
  const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
  const { calls: quotaCalls, fetch: stubFetch } = catalogFetch(() => Response.json({ buckets: [{ displayName: 'Weekly limit', window: 'weekly', remainingFraction: 0.75 }] }));
  const added = [];
  const providerHost = createProviderHost(value => { added.push(value); });
  let current = active;
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch: stubFetch, now: Date.now })
    .setup({
      integration: { transform: async cb => { await cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
        connection: { active: async () => current && ({ type: 'credential', id: current, method: 'oauth' }), resolve: async () => credential } },
      event: providerHost.event, provider: providerHost.provider,
    });
  await providerHost.run();
  const call = async (withToken = process.env[apiKeyEnv], init = {}) => {
    const response = await fetch(bridgeUrl(port), { ...init, headers: { ...(withToken === undefined ? {} : { Authorization: `Bearer ${withToken}` }), ...init.headers } });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  return { added, cleanup, diagnostics: providerHost.diagnostics, quotaCalls, call, emit: providerHost.emit, run: () => providerHost.run(), select(id) { current = id; } };
}

test('quotaV1FromSummary converts fraction buckets to bounded percent rows with window, label and reset', () => {
  const summary = { groups: [{ displayName: 'Gemini 3.8 Flash', buckets: [
    { displayName: 'Weekly limit', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-21T00:00:00Z' },
    { displayName: '5-hour limit', window: '5h', remainingFraction: 0.5, resetTime: '2026-11-14T17:00:00Z' },
    { displayName: 'Disabled', window: 'weekly', remainingFraction: 1, disabled: true },
    { displayName: 'No fraction', window: 'weekly' },
  ] }] };
  const quota = quotaV1FromSummary(summary, observedAt);
  assert.equal(quota.version, 'quota-v1');
  assert.equal(quota.entries.length, 2);
  const [weekly, fiveHour] = quota.entries;
  assert.equal(weekly.kind, 'percent'); assert.equal(weekly.resultType, 'quota');
  assert.equal(weekly.percentRemaining, 75);
  assert.equal(weekly.name, 'Weekly limit (weekly)');
  assert.equal(weekly.label, 'Gemini 3.8 Flash');
  assert.equal(weekly.resetTimeIso, '2026-11-21T00:00:00.000Z');
  assert.equal(weekly.observedAtIso, observedAt);
  assert.equal(fiveHour.percentRemaining, 50);
  assert.equal('value' in weekly, false);
});

test('quotaV1FromSummary clamps fractions, dedupes names, bounds text and falls back to a status row', () => {
  const summary = { buckets: [
    { displayName: 'Same', window: 'weekly', remainingFraction: 1.5 },
    { displayName: 'Same', window: 'weekly', remainingFraction: -0.2 },
    { displayName: 'x'.repeat(200), remainingFraction: 0.1 },
  ] };
  const quota = quotaV1FromSummary(summary, observedAt);
  assert.equal(quota.entries.length, 3);
  assert.equal(quota.entries[0].percentRemaining, 100);
  assert.equal(quota.entries[1].percentRemaining, 0);
  assert.notEqual(quota.entries[0].name, quota.entries[1].name);
  assert.equal([...quota.entries[2].name].length <= 80, true);
  for (const empty of [{}, { buckets: [] }, { groups: [] }, { buckets: [{ remainingFraction: 'x' }] }, null]) {
    assert.deepEqual(quotaV1FromSummary(empty, observedAt), unavailableQuotaV1(observedAt));
  }
  assert.equal(unavailableQuotaV1(observedAt).entries[0].resultType, 'status');
});

test('fetchQuotaSummary posts only project to the fixed endpoint and sanitizes every failure', async () => {
  const requests = [];
  const summary = { buckets: [{ remainingFraction: 0.9 }] };
  const fetcher = async (url, init) => { requests.push({ url, init }); return Response.json(summary); };
  const result = await fetchQuotaSummary(fetcher, 'synthetic-access', 'synthetic-project', new AbortController().signal);
  assert.deepEqual(result, summary);
  assert.equal(requests[0].url, quotaEndpoint);
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { project: 'synthetic-project' });
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer synthetic-access');
  await assert.rejects(fetchQuotaSummary(async () => new Response('secret-body', { status: 403 }), 'synthetic-access', 'synthetic-project', new AbortController().signal),
    error => error.message === 'Quota unavailable.' && !/secret-body/.test(error.message));
  await assert.rejects(fetchQuotaSummary(async () => { throw Error('secret-network'); }, 'synthetic-access', 'synthetic-project', new AbortController().signal),
    error => error.message === 'Quota unavailable.');
  await assert.rejects(fetchQuotaSummary(fetcher, 'bad access', 'synthetic-project', new AbortController().signal), error => error.message === 'Quota unavailable.');
});

test('quota bridge serves quota-v1 only to loopback GET with the bearer and rejects everything else', async () => {
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => quotaV1FromSummary({ buckets: [{ displayName: 'Weekly', window: 'weekly', remainingFraction: 0.8 }] }, observedAt) });
  try {
    const ok = await fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.version, 'quota-v1');
    assert.equal(body.entries[0].percentRemaining, 80);
    assert.equal((await fetch(bridge.url)).status, 401);
    assert.equal((await fetch(bridge.url, { headers: { Authorization: `Bearer ${'x'.repeat(48)}` } })).status, 401);
    assert.equal((await fetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status, 405);
    assert.equal((await fetch(bridge.url.replace('/quota', '/other'), { headers: { Authorization: `Bearer ${token}` } })).status, 404);
    assert.equal((await fetch(bridge.url, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' } })).status, 403);
  } finally { await bridge.close(); }
});

test('quota bridge returns a sanitized 503 when the quota source fails and stops after close', async () => {
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => { throw Error('secret-upstream'); } });
  try {
    const response = await fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 503);
    assert.equal(/secret-upstream/.test(await response.text()), false);
  } finally { await bridge.close(); }
  await assert.rejects(fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } }));
});

test('quota bridge closes when its abort signal fires', async () => {
  const controller = new AbortController();
  const bridge = await startQuotaBridge({ port: 0, token, getQuota: async () => unavailableQuotaV1(observedAt), signal: controller.signal });
  controller.abort();
  await assert.rejects(fetch(bridge.url, { headers: { Authorization: `Bearer ${token}` } }));
});

test('remote names that truncate identically are deduplicated without looping', () => {
  const long = 'a'.repeat(60), window = 'w'.repeat(16);
  const summary = { buckets: [{ displayName: long, window, remainingFraction: 0.9 }, { displayName: long, window, remainingFraction: 0.8 }, { displayName: long, window, remainingFraction: 0.7 }] };
  const quota = quotaV1FromSummary(summary, observedAt);
  const names = quota.entries.map(entry => entry.name);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.equal([...name].length <= 80, true);
  assert.equal(names[1], `${names[0]} 2`);
  assert.equal(names[2], `${names[0]} 3`);
  const many = { buckets: Array.from({ length: 64 }, () => ({ displayName: long, window, remainingFraction: 0.5 })) };
  assert.equal(new Set(quotaV1FromSummary(many, observedAt).entries.map(entry => entry.name)).size, 64);
});

test('quotaBridge option is validated by the local preset and rejected anywhere else', () => {
  const local = { mode: 'google-agy-oauth', authorizationAcknowledged: true };
  const bridge = { port: 62368, apiKeyEnv: 'ANTIGRAVITY_QUOTA_BRIDGE_KEY' };
  assert.deepEqual(validateLocalOAuthConfiguration({ ...local, quotaBridge: bridge }).quotaBridge, { ...bridge, autoKey: true, shared: false });
  assert.equal(Object.isFrozen(validateLocalOAuthConfiguration({ ...local, quotaBridge: bridge }).quotaBridge), true);
  assert.deepEqual(validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, autoKey: true, shared: true } }).quotaBridge, { ...bridge, autoKey: true, shared: true });
  assert.deepEqual(validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, autoKey: false } }).quotaBridge, { ...bridge, autoKey: false, shared: false });
  assert.equal(validateLocalOAuthConfiguration(local).quotaBridge, undefined);
  assert.equal(validateLocalOAuthConfiguration({ ...local, quotaBridge: false }).quotaBridge, undefined);
  for (const value of [{}, { port: 0 }, { port: 65536 }, { port: 1.5 }, { port: 80, apiKeyEnv: 'lower' }, { port: 80, apiKeyEnv: '1BAD' }, { port: 80 }, [], 'x', { port: 80, apiKeyEnv: 'A'.repeat(129) }]) {
    assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: value }));
  }
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, autoKey: 'yes' } }), /autoKey must be a boolean/);
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, shared: 'yes' } }), /shared must be a boolean/);
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, token: 'secret' } }), /does not accept the option "token"/);
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: { port: 62368, apiKeyEnv: 'NODE_OPTIONS' } }), /process-wide environment variable/);
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: { port: 62368, apiKeyEnv: 'HOME' } }), /process-wide environment variable/);
  let message = '';
  try { validateLocalOAuthConfiguration({ ...local, quotaBridge: { ...bridge, '\u001b[2Jevil': 1 } }); } catch (error) { message = error.message; }
  assert.match(message, /does not accept the option/);
  assert.equal(/[\u001b\u0000\n\r]/.test(message), false);
  assert.throws(() => validatePublicOAuthConfiguration({ mode: 'agy-public-oauth', authorizationAcknowledged: true, quotaBridge: bridge }), /only in google-agy-oauth mode/);
  assert.throws(() => validateLocalOAuthConfiguration({ ...local, quotaBridge: bridge, extra: 1 }));
});

test('the plugin publishes quota from the current inventory project and removes the bridge on cleanup', async () => {
  const port = await freePort();
  const previous = process.env[apiKeyEnv];
  const h = await quotaPlugin({ port });
  try {
    assert.ok(h.added.length >= 1);
    assert.match(String(process.env[apiKeyEnv]), /^[\da-f]{64}$/);
    const result = await h.call();
    assert.equal(result.status, 200);
    assert.equal(result.body.version, 'quota-v1');
    assert.equal(result.body.entries[0].percentRemaining, 75);
    assert.equal(result.body.entries[0].name, 'Weekly limit (weekly)');
    assert.equal(h.quotaCalls.count, 1);
    const quotaRequest = h.quotaCalls.requests.find(request => request.url === quotaEndpoint);
    assert.deepEqual(quotaRequest.body, { project: 'synthetic-project' });
    assert.equal(quotaRequest.authorization, 'Bearer synthetic-access');
    assert.deepEqual(h.quotaCalls.unhandled, []);
    const second = await h.call();
    assert.equal(second.status, 200);
    assert.equal(h.quotaCalls.count, 1, 'a fresh result must be cached briefly');
    assert.equal((await fetch(bridgeUrl(port), { headers: { Authorization: `Bearer ${'f'.repeat(64)}` } })).status, 401);
  } finally {
    await h.cleanup();
    assert.equal(process.env[apiKeyEnv], previous);
  }
  await assert.rejects(fetch(bridgeUrl(port), { headers: { Authorization: `Bearer ${token}` } }));
});

test('concurrent bridge requests share one upstream quota call', async () => {
  const port = await freePort();
  const h = await quotaPlugin({ port });
  try {
    const results = await Promise.all([h.call(), h.call(), h.call()]);
    assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
    assert.equal(h.quotaCalls.count, 1);
  } finally { await h.cleanup(); }
});

test('the bridge reports Unavailable without a credential and recovers after sign-in', async () => {
  const port = await freePort();
  const h = await quotaPlugin({ port, active: null });
  try {
    const offline = await h.call();
    assert.equal(offline.status, 200);
    assert.equal(offline.body.entries.length, 1);
    assert.equal(offline.body.entries[0].resultType, 'status');
    assert.equal(offline.body.entries[0].value, 'Unavailable');
    assert.equal(h.quotaCalls.count, 0);
    h.select('A');
    await h.run();
    await new Promise(resolve => setTimeout(resolve, 2100));
    const online = await h.call();
    assert.equal(online.body.entries[0].percentRemaining, 75);
    assert.equal(h.quotaCalls.count, 1);
  } finally { await h.cleanup(); }
});

test('no bridge and no environment token without the quotaBridge option', async () => {
  const port = await freePort();
  const h = await quotaPlugin({ port, bridge: false });
  try {
    assert.equal(process.env[apiKeyEnv], undefined);
    assert.ok(h.added.length >= 1);
    await assert.rejects(fetch(bridgeUrl(port)));
  } finally { await h.cleanup(); }
});

test('a credential switch drops the cached quota result', async () => {
  const port = await freePort();
  const h = await quotaPlugin({ port });
  try {
    await h.call();
    await h.call();
    assert.equal(h.quotaCalls.count, 1);
    await h.emit('credential.switched', { integrationID: 'google-agy-oauth' });
    assert.equal((await h.call()).status, 200);
    assert.equal(h.quotaCalls.count, 2);
  } finally { await h.cleanup(); }
});

test('autoKey false reuses an external key without rewriting the environment', async () => {
  const port = await freePort();
  const external = 'k'.repeat(64);
  process.env[apiKeyEnv] = external;
  try {
    const h = await quotaPlugin({ port, bridge: { autoKey: false } });
    try {
      assert.equal(process.env[apiKeyEnv], external);
      assert.equal((await h.call(external)).status, 200);
      assert.equal((await fetch(bridgeUrl(port), { headers: { Authorization: `Bearer ${'x'.repeat(64)}` } })).status, 401);
    } finally { await h.cleanup(); }
    assert.equal(process.env[apiKeyEnv], external);
  } finally { delete process.env[apiKeyEnv]; }
  await assert.rejects(fetch(bridgeUrl(port), { headers: { Authorization: `Bearer ${external}` } }));
});

test('autoKey false without a usable key warns and keeps the provider available', async () => {
  const port = await freePort();
  const previous = process.env[apiKeyEnv];
  process.env[apiKeyEnv] = 'short';
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const h = await quotaPlugin({ port, bridge: { autoKey: false } });
    try {
      assert.match(warnings.join('\n'), /Antigravity quota bridge unavailable: invalid-key/);
      assert.equal(process.env[apiKeyEnv], 'short');
      assert.ok(h.added.length >= 1);
      await assert.rejects(fetch(bridgeUrl(port), { headers: { Authorization: 'Bearer short' } }));
    } finally { await h.cleanup(); }
  } finally {
    console.warn = originalWarn;
    if (previous === undefined) delete process.env[apiKeyEnv]; else process.env[apiKeyEnv] = previous;
  }
});

test('a busy quota port warns, leaves the environment untouched and keeps OAuth inference available', async () => {
  const { port, release } = await freePort(true);
  const previous = 'pre-existing-token';
  process.env[apiKeyEnv] = previous;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args[0]); };
  const h = await quotaPlugin({ port }).catch(error => { console.warn = originalWarn; throw error; });
  try {
    assert.equal(warnings.includes('Antigravity quota bridge unavailable:'), true);
    assert.equal(process.env[apiKeyEnv], previous);
    assert.ok(h.added.length >= 1);
    assert.equal(h.quotaCalls.count, 0);
  } finally {
    await h.cleanup();
    console.warn = originalWarn;
    assert.equal(process.env[apiKeyEnv], previous);
    await release();
  }
});

const idle = () => new AbortController().signal;

test('fetchAccountEmail reads the verified account email from Google userinfo', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, authorization: new Headers(init.headers).get('authorization') });
    return Response.json({ email: 'user@example.com', email_verified: true });
  };
  assert.equal(await fetchAccountEmail(fetch, token, idle()), 'user@example.com');
  assert.deepEqual(seen, [{ url: userinfoEndpoint, authorization: `Bearer ${token}` }]);
});

test('fetchAccountEmail degrades to undefined without leaking failures', async () => {
  assert.equal(await fetchAccountEmail(async () => Response.json({ email: 'user@example.com' }), '', idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => Response.json({ email: 'user@example.com' }), 'bad token', idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => new Response('', { status: 401 }), token, idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => Response.json({ email: 42 }), token, idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => Response.json({ sub: 'no-email' }), token, idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => Response.json({ email: 'x'.repeat(65536) + '@example.com' }), token, idle()), undefined);
  assert.equal(await fetchAccountEmail(async () => { throw Error('secret-network'); }, token, idle()), undefined);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await fetchAccountEmail(async () => Response.json({ email: 'user@example.com' }), token, controller.signal), undefined);
});

test('quotaV1ForAccounts keeps a single account snapshot unchanged', () => {
  const single = quotaV1FromSummary({ buckets: [{ displayName: 'Weekly limit', window: 'weekly', remainingFraction: 0.5 }] }, observedAt);
  assert.equal(quotaV1ForAccounts([], observedAt).entries[0].resultType, 'status');
  assert.equal(quotaV1ForAccounts([{ account: 'user@example.com', quota: single }], observedAt), single);
});

test('quotaV1ForAccounts scopes every row per account within the 80-code-point limits', () => {
  const summary = fraction => quotaV1FromSummary({ groups: [{ displayName: 'Gemini Models', buckets: [{ displayName: 'Weekly limit', window: 'weekly', remainingFraction: fraction }] }] }, observedAt);
  const merged = quotaV1ForAccounts([
    { account: 'first@example.com', quota: summary(0.5) },
    { account: 'second@example.com', quota: summary(0.25) },
  ], observedAt);
  assert.equal(merged.entries.length, 2);
  assert.equal(new Set(merged.entries.map(entry => entry.name)).size, 2);
  for (const entry of merged.entries) {
    assert.ok([...entry.name].length <= 80);
    assert.ok([...entry.label].length <= 80);
  }
  assert.ok(merged.entries.some(entry => entry.label.includes('first@example.com') && entry.percentRemaining === 50));
  assert.ok(merged.entries.some(entry => entry.label.includes('second@example.com') && entry.percentRemaining === 25));
  const anonymous = quotaV1ForAccounts([{ account: '', quota: summary(0.5) }, { account: '', quota: summary(0.25) }], observedAt);
  assert.ok(anonymous.entries[0].label.includes('conta 1'));
  assert.ok(anonymous.entries[1].label.includes('conta 2'));
  const long = quotaV1ForAccounts([
    { account: 'first@example.com', quota: { version: 'quota-v1', entries: [{ kind: 'percent', name: 'n'.repeat(76), resultType: 'quota', percentRemaining: 10, label: 'g'.repeat(80), observedAtIso: observedAt }] } },
    { account: 'second@example.com', quota: unavailableQuotaV1(observedAt) },
  ], observedAt);
  assert.ok([...long.entries[0].name].length <= 80);
  assert.ok([...long.entries[0].label].length <= 80);
  assert.ok(long.entries.some(entry => entry.resultType === 'status' && entry.label.includes('second@example.com')));
});
