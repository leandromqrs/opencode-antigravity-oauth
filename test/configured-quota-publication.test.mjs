import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publishQuotaOnce, startQuotaPublication } from '../dist/configured-quota-publication.js';
import { quotaV1FromSummary, unavailableQuotaV1 } from '../dist/configured-quota.js';
import { binding, validateLocalOAuthConfiguration, validatePublicOAuthConfiguration } from '../dist/configured-security.js';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { createProviderHost } from './helpers/provider-host.mjs';

const observedAt = '2026-11-21T12:00:00.000Z';
const summary = { buckets: [{ displayName: 'Weekly limit', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-11-28T00:00:00Z' }] };
const loadEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const modelsEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const quotaEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const idleSignal = () => new AbortController().signal;

test('does not submit a snapshot without an accepted ticket', async () => {
  const calls = [];
  await publishQuotaOnce(async input => { calls.push(input); return { accepted: true }; }, async () => quotaV1FromSummary(summary, observedAt), idleSignal());
  assert.deepEqual(calls, [{ providerId: 'antigravity-local' }]);
});

test('publishes the account quota with the receiver ticket', async () => {
  const calls = [];
  const send = async input => { calls.push(input); return { accepted: true, ticket: 'fixture-ticket' }; };
  await publishQuotaOnce(send, async () => quotaV1FromSummary(summary, observedAt), idleSignal());
  assert.deepEqual(calls[1], { providerId: 'antigravity-local', ticket: 'fixture-ticket', snapshot: quotaV1FromSummary(summary, observedAt) });
});

test('withdraws the row when the account quota is unavailable', async () => {
  const calls = [];
  const send = async input => { calls.push(input); return { accepted: true, ticket: 'fixture-ticket' }; };
  await publishQuotaOnce(send, async () => unavailableQuotaV1(observedAt), idleSignal());
  assert.deepEqual(calls[1].snapshot, { version: 'quota-v1', entries: [] });
});

test('publication loop survives receiver failures and stops on demand', async () => {
  const calls = [];
  let offline = true;
  const send = async input => {
    calls.push(input);
    if (offline) { offline = false; throw new Error('receiver offline'); }
    return { accepted: true, ticket: 'fixture-ticket' };
  };
  const stop = startQuotaPublication(send, async () => quotaV1FromSummary(summary, observedAt), idleSignal(), { initialMs: 0, intervalMs: 5 });
  try {
    while (calls.length < 3) await sleep(2);
    assert.ok(calls.some(call => call.ticket === 'fixture-ticket' && call.snapshot.entries.length === 1));
  } finally { stop(); }
  const count = calls.length;
  await sleep(25);
  assert.equal(calls.length, count);
});

test('an aborted signal never publishes', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const stop = startQuotaPublication(async input => { calls.push(input); return { accepted: true, ticket: 't' }; }, async () => quotaV1FromSummary(summary, observedAt), controller.signal, { initialMs: 0, intervalMs: 5 });
  await sleep(15);
  stop();
  assert.deepEqual(calls, []);
});

test('publishQuota is opt-in, local-mode only, and keeps the credential binding', () => {
  const base = { mode: 'agy-local-oauth', authorizationAcknowledged: true };
  assert.equal(validateLocalOAuthConfiguration(base).publishQuota, undefined);
  assert.equal(validateLocalOAuthConfiguration({ ...base, publishQuota: false }).publishQuota, undefined);
  const enabled = validateLocalOAuthConfiguration({ ...base, publishQuota: true });
  assert.equal(enabled.publishQuota, true);
  assert.equal(binding(enabled), binding(validateLocalOAuthConfiguration(base)));
  assert.throws(() => validatePublicOAuthConfiguration({ mode: 'agy-public-oauth', authorizationAcknowledged: true, publishQuota: true }), /agy-local-oauth/u);
  assert.throws(() => validateLocalOAuthConfiguration({ ...base, publishQuota: 'yes' }), /publishQuota/u);
});

test('local plugin publishes account quota through the receiver without a bridge', async () => {
  const options = { mode: 'agy-local-oauth', authorizationAcknowledged: true, publishQuota: true };
  const config = validateLocalOAuthConfiguration(options);
  const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
  const publications = [];
  let quotaRequests = 0;
  const fetch = async url => {
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === quotaEndpoint) { quotaRequests++; return Response.json(summary); }
    return new Response('', { status: 599 });
  };
  const providerHost = createProviderHost(() => {});
  const rpc = definition => {
    assert.equal(definition.id, 'slkiser.opencode-quota');
    return { publishQuota: async input => {
      publications.push(input);
      return input.ticket === undefined ? { accepted: true, ticket: 'fixture-ticket' } : { accepted: true };
    } };
  };
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch, now: Date.now, publicationDelays: { initialMs: 0, intervalMs: 5 } })
    .setup({
      integration: { transform: async cb => { await cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
        connection: { active: async () => ({ type: 'credential', id: 'A', method: 'oauth' }), resolve: async () => credential } },
      event: providerHost.event, provider: providerHost.provider, rpc,
    });
  await providerHost.run();
  try {
    while (!publications.some(call => call.ticket && call.snapshot?.entries?.length)) await sleep(2);
    const published = publications.find(call => call.ticket);
    assert.equal(published.providerId, 'antigravity-local');
    assert.equal(published.snapshot.entries[0].percentRemaining, 75);
    assert.ok(quotaRequests >= 1);
    assert.equal(process.env.ANTIGRAVITY_QUOTA_BRIDGE_KEY, undefined);
  } finally { await cleanup(); }
  const count = publications.length;
  await sleep(25);
  assert.equal(publications.length, count, 'cleanup stops publication');
});
