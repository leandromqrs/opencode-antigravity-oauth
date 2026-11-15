import assert from 'node:assert/strict';
import { createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { Model, Provider, Credential } from '@opencode/plugin';
import { Schema } from 'effect';
import { make } from '@opencode/ai';
import { createSyntheticAntigravityPlugin as createAntigravityPlugin } from '../dist/configured-plugin.js';
import { model as loadModel } from '../dist/configured-driver.js';

const config = () => ({ authorizationAcknowledged: true, providerId: 'configured-antigravity', integrationId: 'configured-antigravity-oauth', name: 'Synthetic configured OAuth',
  oauth: { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', clientId: 'synthetic-public-client', redirectUri: 'https://callback.example/complete', scopes: ['synthetic.inference'] },
  inference: { endpoint: 'https://inference.example/stream', project: 'synthetic-project', textSemantics: 'delta', usageSemantics: 'single-report' },
  models: [{ id: 'synthetic-model', modelID: 'synthetic-model', providerID: 'configured-antigravity', name: 'Synthetic fixture model', capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 100, output: 10 } }],
});
const token = (access, refresh = 'synthetic-refresh') => new Response(JSON.stringify({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 }));
const frames = () => new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'synthetic-native-answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, totalTokenCount: 3 } } })}\n\n`);
const ai = make();

function host() {
  const state = { provider: undefined, method: undefined, stored: undefined, active: { type: 'credential', id: 'synthetic-credential', method: 'oauth', label: 'Synthetic' }, disposed: 0, resolve: undefined };
  const registration = { dispose: async () => { state.disposed++; } };
  const providerHost = createProviderHost(value => { state.provider = value; }, () => { state.provider = undefined; });
  state.render = providerHost.run;
  const context = {
    integration: {
      transform: async callback => { callback({ method: { update: value => { state.method = value; } }, update() {} }); return registration; },
      connection: { active: async () => state.active, resolve: async () => state.resolve ? state.resolve() : state.stored },
    },
    event: providerHost.event,
    provider: { ...providerHost.provider, transform: async callback => { await providerHost.provider.transform(callback); return registration; } },
  };
  return { state, context };
}

async function login(state) {
  const grant = await state.method.authorize({});
  assert.equal(grant.mode, 'code');
  assert.match(grant.instructions, /full.*URL/i);
  const stateValue = new URL(grant.url).searchParams.get('state');
  state.stored = await grant.callback(`https://callback.example/complete?state=${stateValue}&code=synthetic-code`);
  Schema.decodeUnknownSync(Credential.OAuth)(state.stored);
}

test('duplicate native callback cannot cancel the winning exchange', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const plugin = createAntigravityPlugin(config(), { fetch: async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  } });
  const { state, context } = host();
  const cleanup = await plugin.setup(context);
  try {
    const grant = await state.method.authorize({});
    const callback = `https://callback.example/complete?state=${new URL(grant.url).searchParams.get('state')}&code=synthetic-code`;
    const winner = grant.callback(callback);
    const outcome = winner.then(value => ({ value }), error => ({ error }));
    await waiting;
    await assert.rejects(grant.callback(callback));
    release(token('synthetic-winner'));
    const result = await outcome;
    assert.ifError(result.error);
    assert.equal(result.value.access, 'synthetic-winner');
  } finally { await cleanup(); }
});

function driver(state, loader = loadModel) {
  return loader('synthetic-model', { ...state.provider.info.settings, ...state.stored?.metadata,
    ...(state.stored ? { apiKey: state.stored.access } : {}), headers: {}, body: {} });
}

test('real V2 Plugin hooks -> code exchange -> native credential -> model loader -> authenticated SDK generation', async () => {
  const requests = [];
  const plugin = createAntigravityPlugin(config(), { fetch: async (url, init) => {
    requests.push({ url, init });
    return url === 'https://auth.example/token' ? token('synthetic-access') : frames();
  } });
  const { state, context } = host();
  const cleanup = await plugin.setup(context);
  assert.equal(requests.length, 0);
  Schema.decodeUnknownSync(Provider.Info)(state.provider.info);
  Schema.decodeUnknownSync(Model.Info)(state.provider.models[0]);
  assert.equal(state.provider.info.integrationID, config().integrationId);
  assert.equal(JSON.stringify(state.provider).includes('access_token'), false);
  await login(state);
  const registeredModule = await import(state.provider.info.package);
  const native = driver(state, registeredModule.model);
  const response = await ai.generate({ model: native, prompt: 'synthetic prompt' });
  assert.equal(response.text, 'synthetic-native-answer'); assert.equal(response.usage.totalTokens, 3);
  const inference = requests.at(-1);
  assert.equal(inference.url, config().inference.endpoint); assert.equal(inference.init.headers.Authorization, 'Bearer synthetic-access');
  assert.equal(inference.init.redirect, 'error'); assert.equal(inference.init.credentials, 'omit');
  assert.equal(JSON.parse(inference.init.body).model, 'synthetic-model');
  assert.equal(JSON.parse(inference.init.body).project, 'synthetic-project');
  const firstId = JSON.parse(inference.init.body).requestId;
  await ai.generate({ model: native, prompt: 'synthetic prompt' });
  assert.notEqual(JSON.parse(requests.at(-1).init.body).requestId, firstId);
  await ai.generate({ model: native, prompt: 'synthetic prompt', id: 'synthetic-host-request' });
  assert.equal(JSON.parse(requests.at(-1).init.body).requestId, 'synthetic-host-request');
  await cleanup(); assert.equal(state.disposed, 2);
  await assert.rejects(ai.generate({ model: native, prompt: 'x' }));
  assert.throws(() => driver(state));
});

test('host refresh hook persists rotation and cached native model uses fresh active credential per dispatch', async () => {
  let now = 1000, grants = 0; const auth = [];
  const plugin = createAntigravityPlugin(config(), { now: () => now, fetch: async (url, init) => {
    if (url === 'https://auth.example/token') { grants++; return token(`synthetic-access-${grants}`, `synthetic-refresh-${grants}`); }
    auth.push(init.headers.Authorization); return frames();
  } });
  const { state, context } = host(); const cleanup = await plugin.setup(context);
  await login(state); const native = driver(state);
  await ai.generate({ model: native, prompt: 'x' });
  now += 3_600_001;
  state.resolve = async () => { state.stored = await state.method.refresh(state.stored); return state.stored; };
  await ai.generate({ model: native, prompt: 'x' });
  assert.deepEqual(auth, ['Bearer synthetic-access-1', 'Bearer synthetic-access-2']);
  assert.equal(state.stored.refresh, 'synthetic-refresh-2');
  await cleanup();
});

test('no active OAuth, foreign configuration, expiry and account switch fail closed before inference', async () => {
  let calls = 0;
  const plugin = createAntigravityPlugin(config(), { fetch: async url => {
    if (url.endsWith('/token')) return token('synthetic-access'); calls++; return frames();
  } });
  const { state, context } = host(); const cleanup = await plugin.setup(context); await login(state);
  const native = driver(state), active = state.active, stored = state.stored;
  for (const kind of ['absent', 'key', 'foreign', 'expired', 'switch']) {
    state.active = active; state.stored = stored; state.resolve = undefined;
    if (kind === 'absent') state.active = undefined;
    if (kind === 'key') state.active = { ...active, method: 'key' };
    if (kind === 'foreign') state.stored = { ...stored, metadata: { configuration: 'foreign' } };
    if (kind === 'expired') state.stored = { ...stored, expires: 0 };
    if (kind === 'switch') state.resolve = async () => { state.active = { ...active, id: 'changed' }; return stored; };
    await assert.rejects(ai.generate({ model: native, prompt: 'x' }), e => !JSON.stringify(e).includes('synthetic-access'));
  }
  assert.equal(calls, 0); await cleanup();
});

test('module loader rejects unconfigured models/settings and does not use arbitrary host apiKey as fallback', async () => {
  const { state, context } = host();
  const cleanup = await createAntigravityPlugin(config(), { fetch: async () => { throw Error('must not request'); } }).setup(context);
  for (const settings of [{}, { ...state.provider.info.settings, endpoint: 'https://other.example' }, { ...state.provider.info.settings, headers: { Authorization: 'secret' } }]) {
    assert.throws(() => loadModel('synthetic-model', settings), e => !e.message.includes('secret'));
  }
  assert.throws(() => loadModel('unknown', state.provider.info.settings));
  const native = loadModel('synthetic-model', { ...state.provider.info.settings, apiKey: 'synthetic-untrusted-key', headers: {}, body: {} });
  await assert.rejects(ai.generate({ model: native, prompt: 'x' }));
  await cleanup();
});

test('plugin disposal invalidates pending authorization and aborts pending inference', { timeout: 5000 }, async () => {
  let reading, cancelled = false;
  const started = new Promise(resolve => { reading = resolve; });
  const plugin = createAntigravityPlugin(config(), { fetch: async url => url.endsWith('/token') ? token('synthetic-access')
    : new Response(new ReadableStream({ pull() { reading(); return new Promise(() => {}); }, cancel() { cancelled = true; } })) });
  const { state, context } = host(); const cleanup = await plugin.setup(context); await login(state);
  const authorization = await state.method.authorize({});
  const pending = ai.generate({ model: driver(state), prompt: 'x' });
  await started; await cleanup(); await assert.rejects(pending); assert.equal(cancelled, true);
  const stateValue = new URL(authorization.url).searchParams.get('state');
  await assert.rejects(authorization.callback(`https://callback.example/complete?state=${stateValue}&code=x`));
});

test('partial setup failure disposes registrations and runtime', async () => {
  const { state, context } = host();
  context.provider.transform = async () => { throw Error('secret'); };
  const plugin = createAntigravityPlugin(config(), { fetch: async () => { throw Error('unused'); } });
  await assert.rejects(plugin.setup(context), e => !e.message.includes('secret'));
  assert.equal(state.disposed, 1);
});

test('SDK cancellation while credential resolution is pending never dispatches a later token', { timeout: 5000 }, async () => {
  let resolveCredential, entered, calls = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const { state, context } = host();
  const cleanup = await createAntigravityPlugin(config(), { fetch: async url => { if (url.endsWith('/token')) return token('synthetic-access'); calls++; return frames(); } }).setup(context);
  await login(state);
  const stored = state.stored;
  state.resolve = async () => { entered(); return new Promise(resolve => { resolveCredential = resolve; }); };
  const controller = new AbortController();
  const pending = ai.generate({ model: driver(state), prompt: 'x' }, { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending);
  resolveCredential(stored); await Promise.resolve(); await cleanup(); assert.equal(calls, 0);
});

test('operator-supplied fixed inference query is pinned without embedding credentials in its URL', async () => {
  const configuration = config(); configuration.inference.endpoint += '?format=synthetic';
  let destination;
  const { state, context } = host();
  const cleanup = await createAntigravityPlugin(configuration, { fetch: async url => {
    if (url.endsWith('/token')) return token('synthetic-access'); destination = url; return frames();
  } }).setup(context);
  await login(state); await ai.generate({ model: driver(state), prompt: 'x' });
  assert.equal(destination, configuration.inference.endpoint); assert.equal(destination.includes('synthetic-access'), false); await cleanup();
});

test('inventory is bound to the selected OAuth credential and cached models cannot follow account switches', async () => {
  let calls = 0;
  const { state, context } = host();
  state.active = undefined;
  const cleanup = await createAntigravityPlugin(config(), { fetch: async url => { if (url.endsWith('/token')) return token('synthetic-access'); calls++; return frames(); } }).setup(context);
  assert.equal(state.provider, undefined);
  state.active = { type: 'credential', id: 'account-a', method: 'oauth', label: 'A' };
  await login(state); await state.render();
  assert.deepEqual(state.provider.sourceConnection, state.active);
  const accountA = driver(state);
  await ai.generate({ model: accountA, prompt: 'x' });
  state.active = { ...state.active, id: 'account-b', label: 'B' };
  await assert.rejects(ai.generate({ model: accountA, prompt: 'x' }));
  assert.equal(calls, 1);
  await state.render(); assert.equal(state.provider.sourceConnection.id, 'account-b');
  await ai.generate({ model: driver(state), prompt: 'x' }); assert.equal(calls, 2);
  state.active = { ...state.active, method: 'key' };
  await state.render(); assert.equal(state.provider, undefined);
  await cleanup();
});

test('host credential persistence failure after refresh prevents inference and does not fall back to old tokens', async () => {
  let grants = 0, inference = 0;
  const { state, context } = host();
  const cleanup = await createAntigravityPlugin(config(), { fetch: async url => {
    if (url.endsWith('/token')) return token(`synthetic-access-${++grants}`, `synthetic-refresh-${grants}`);
    inference++; return frames();
  } }).setup(context);
  await login(state); const old = state.stored;
  state.resolve = async () => {
    const replacement = await state.method.refresh(old);
    assert.equal(replacement.refresh, 'synthetic-refresh-2');
    throw Error('secret host storage failure');
  };
  await assert.rejects(ai.generate({ model: driver(state), prompt: 'synthetic-prompt' }), e => !e.message.includes('secret'));
  assert.equal(state.stored, old); assert.equal(grants, 2); assert.equal(inference, 0); await cleanup();
});

test('delayed authorization or refresh after an account switch cannot return credentials to the host', async () => {
  for (const operation of ['authorization', 'refresh']) {
    let pending = false, entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const { state, context } = host();
    const cleanup = await createAntigravityPlugin(config(), { fetch: async () => {
      if (!pending) return token('synthetic-access');
      entered(); return new Promise(resolve => { release = resolve; });
    } }).setup(context);
    await login(state); const saved = state.stored;
    pending = true;
    let result;
    if (operation === 'authorization') {
      const grant = await state.method.authorize({});
      result = grant.callback(`https://callback.example/complete?state=${new URL(grant.url).searchParams.get('state')}&code=synthetic-code`);
    } else result = state.method.refresh(saved);
    const outcome = result.then(value => ({ value }), error => ({ error }));
    await started; state.active = { ...state.active, id: 'account-b' };
    release(token('synthetic-rotated-access', 'synthetic-rotated-refresh'));
    const settled = await outcome;
    assert.equal(settled.value, undefined); assert.ok(settled.error);
    assert.equal(state.stored, saved); assert.equal(state.active.id, 'account-b'); await cleanup();
  }
});
