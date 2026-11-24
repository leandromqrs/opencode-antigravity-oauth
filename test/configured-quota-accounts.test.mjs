import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';
import { createProviderHost } from './helpers/provider-host.mjs';

const options = { mode: 'agy-local-oauth', authorizationAcknowledged: true, publishQuota: true };
const config = validateLocalOAuthConfiguration(options);
const loadEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const modelsEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const quotaEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const userinfoEndpoint = 'https://www.googleapis.com/oauth2/v3/userinfo';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const credentialFor = access => ({ type: 'oauth', methodID: 'configured-pkce', access, refresh: '', expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } });
const summary = fraction => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ displayName: 'Weekly limit', window: 'weekly', remainingFraction: fraction }] }] });

async function plugin({ fetch, connections, credentials, active = 'A' }) {
  const publications = [];
  let methodRegistration;
  const providerHost = createProviderHost(() => {});
  const rpc = () => ({ publishQuota: async input => {
    publications.push(input);
    return input.ticket === undefined ? { accepted: true, ticket: 'fixture-ticket' } : { accepted: true };
  } });
  const integration = {
    transform: async cb => { await cb({ method: { update: input => { methodRegistration = input; } }, update() {} }); return { dispose: async () => {} }; },
    connection: { active: async () => ({ type: 'credential', id: active, method: 'oauth' }), resolve: async connection => credentials[connection.id] },
  };
  if (connections) integration.get = async () => ({ data: { connections } });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch, now: Date.now, publicationDelays: { initialMs: 0, intervalMs: 5 } })
    .setup({ integration, event: providerHost.event, provider: providerHost.provider, rpc });
  await providerHost.run();
  return { publications, cleanup, label: credential => methodRegistration.label(credential) };
}

const connection = id => ({ type: 'credential', id, label: 'Google Antigravity', method: 'oauth' });

test('publishes the quota of every connected account, labelled by email', async () => {
  const credentials = { A: credentialFor('access-a'), B: credentialFor('access-b') };
  const emails = { 'access-a': 'first@example.com', 'access-b': 'second@example.com' };
  const fractions = { 'access-a': 0.5, 'access-b': 0.25 };
  const fetch = async (url, init) => {
    const access = new Headers(init.headers).get('authorization')?.replace('Bearer ', '');
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === userinfoEndpoint) return Response.json({ email: emails[access] });
    if (url === quotaEndpoint) return Response.json(summary(fractions[access]));
    return new Response('', { status: 599 });
  };
  const h = await plugin({ fetch, connections: [connection('B'), connection('A')], credentials });
  try {
    while (!h.publications.some(call => call.ticket && call.snapshot?.entries?.length >= 2)) await sleep(2);
    const published = h.publications.find(call => call.ticket && call.snapshot.entries.length >= 2);
    assert.equal(published.providerId, 'antigravity-local');
    const entries = published.snapshot.entries;
    assert.equal(entries.length, 2);
    assert.equal(new Set(entries.map(entry => entry.name)).size, 2);
    assert.ok(entries.every(entry => [...entry.name].length <= 80 && [...entry.label].length <= 80));
    assert.ok(entries.some(entry => entry.label.includes('first@example.com') && entry.percentRemaining === 50));
    assert.ok(entries.some(entry => entry.label.includes('second@example.com') && entry.percentRemaining === 25));
  } finally { await h.cleanup(); }
});

test('one failing account does not withdraw the other accounts', async () => {
  const credentials = { A: credentialFor('access-a'), B: credentialFor('access-b') };
  const fetch = async (url, init) => {
    const access = new Headers(init.headers).get('authorization')?.replace('Bearer ', '');
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === userinfoEndpoint) return Response.json({ email: access === 'access-a' ? 'first@example.com' : 'second@example.com' });
    if (url === quotaEndpoint) return access === 'access-a' ? Response.json(summary(0.5)) : new Response('', { status: 503 });
    return new Response('', { status: 599 });
  };
  const h = await plugin({ fetch, connections: [connection('A'), connection('B')], credentials });
  try {
    while (!h.publications.some(call => call.ticket && call.snapshot?.entries?.length >= 2)) await sleep(2);
    const entries = h.publications.find(call => call.ticket && call.snapshot.entries.length >= 2).snapshot.entries;
    assert.ok(entries.some(entry => entry.resultType === 'quota' && entry.label.includes('first@example.com') && entry.percentRemaining === 50));
    assert.ok(entries.some(entry => entry.resultType === 'status' && entry.label.includes('second@example.com')));
  } finally { await h.cleanup(); }
});

test('without integration.get the publication falls back to the active account only', async () => {
  const credentials = { A: credentialFor('access-a') };
  const fetch = async (url, init) => {
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === userinfoEndpoint) return Response.json({ email: 'first@example.com' });
    if (url === quotaEndpoint) return Response.json(summary(0.5));
    return new Response('', { status: 599 });
  };
  const h = await plugin({ fetch, credentials });
  try {
    while (!h.publications.some(call => call.ticket && call.snapshot?.entries?.length)) await sleep(2);
    const entries = h.publications.find(call => call.ticket && call.snapshot.entries.length).snapshot.entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].percentRemaining, 50);
    assert.ok(!entries[0].name.includes('[1]'));
  } finally { await h.cleanup(); }
});

test('the credential label follows the account email once the quota loop knows it', async () => {
  const credentials = { A: credentialFor('access-a') };
  const fetch = async (url, init) => {
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    if (url === userinfoEndpoint) return Response.json({ email: 'first@example.com' });
    if (url === quotaEndpoint) return Response.json(summary(0.5));
    return new Response('', { status: 599 });
  };
  const h = await plugin({ fetch, connections: [connection('A')], credentials });
  try {
    assert.equal(h.label(credentials.A), 'Google Antigravity');
    while (!h.publications.some(call => call.ticket && call.snapshot?.entries?.length)) await sleep(2);
    assert.equal(h.label(credentials.A), 'first@example.com');
    assert.equal(h.label(credentialFor('unknown-access')), 'Google Antigravity');
  } finally { await h.cleanup(); }
});
