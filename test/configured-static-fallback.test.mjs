import assert from 'node:assert/strict';
import { assertDiagnostic, createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { Schema } from 'effect';
import { Model } from '@opencode/plugin';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';
import { model } from '../dist/configured-driver.js';
import { make } from '@opencode/ai';

const options = { mode: 'google-agy-oauth', authorizationAcknowledged: true };
const config = validateLocalOAuthConfiguration(options);
const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
async function host(fetch, initial = 'A', now = Date.now) {
  let active, started = false;
  const added = [];
  const providerHost = createProviderHost(value => { added.push(value); });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch, now }).setup({
    integration: { transform: async cb => { await cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => active && ({ type: 'credential', id: active, method: 'oauth' }), resolve: async () => credential } },
    event: providerHost.event, provider: providerHost.provider,
  });
  return { added, cleanup, diagnostics: providerHost.diagnostics, select(id) { started = true; active = id; }, run: () => { if (!started) { started = true; active = initial; } return providerHost.run(); } };
}

test('403 at model discovery publishes explicitly experimental static base models with medium effort variants', async () => {
  let n = 0;
  const h = await host(async () => ++n === 1 ? Response.json({}) : new Response('', { status: 403 }));
  try {
    await h.run();
    const { info, models, sourceConnection } = h.added[0];
    assert.match(info.name, /static.*experimental/i);
    assert.equal(sourceConnection.id, 'A');
    assert.deepEqual(models.map(m => m.id), ['gemini-3.8-flash', 'gemini-4-argon', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b']);
    for (const m of models) {
      assert.equal(m.id, m.modelID); assert.match(m.name, /static/i); assert.doesNotThrow(() => Schema.decodeUnknownSync(Model.Info)(m));
      assert.deepEqual(m.variants.map(v => v.id), ['medium']);
      assert.equal(m.settings.antigravityModel, `${m.id}-medium`);
      assert.equal(m.variants[0].settings.antigravityModel, `${m.id}-medium`);
    }
    assert.deepEqual(models[0].limit, { context: 1048576, output: 65536 });
    assert.deepEqual(models[2].limit, { context: 1000000, output: 128000 });
    assert.deepEqual(models[4].limit, { context: 131072, output: 32768 });
  } finally { await h.cleanup(); }
});

test('expired fallback rejects new and already constructed models until rediscovery', async () => {
  let time = Date.now(), n = 0, inference = 0;
  const h = await host(async url => {
    if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
      inference++;
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } })}\n\n`);
    }
    return ++n % 2 ? Response.json({}) : new Response('', { status: 403 });
  }, 'A', () => time);
  try {
    await h.run();
    const settings = h.added[0].info.settings;
    const native = model('gemini-3.8-flash', settings);
    const ai = make();
    assert.equal((await ai.generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    time += 30000;
    assert.throws(() => model('gemini-3.8-flash', settings));
    await assert.rejects(ai.generate({ model: native, prompt: 'synthetic' }));
    assert.equal(inference, 1);
    await h.run();
    const renewed = model('gemini-3.8-flash', h.added[1].info.settings);
    assert.equal((await ai.generate({ model: renewed, prompt: 'synthetic' })).text, 'answer');
    assert.equal((await ai.generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    assert.equal(inference, 3);
  } finally { await h.cleanup(); }
});

test('403 during account loading never publishes fallback', async () => {
  const h = await host(async () => new Response('', { status: 403 }));
  try { await h.run(); assertDiagnostic(h); assert.equal(h.added.length, 0); } finally { await h.cleanup(); }
});

test('successful live discovery takes precedence over static models', async () => {
  let n = 0;
  const h = await host(async () => Response.json(++n === 1 ? {} : { defaultAgentModelId: 'live', models: { live: { maxTokens: 1000, maxOutputTokens: 100 } } }));
  try { await h.run(); assert.deepEqual(h.added[0].models.map(m => m.id), ['live']); assert.doesNotMatch(h.added[0].info.name, /static/i); }
  finally { await h.cleanup(); }
});

test('non-403 discovery errors do not publish fallback', async () => {
  let n = 0;
  const h = await host(async () => ++n === 1 ? Response.json({}) : new Response('', { status: 503 }));
  try { await h.run(); assertDiagnostic(h); assert.equal(h.added.length, 0); } finally { await h.cleanup(); }
});

test('fallback cannot publish after account changes during discovery', async () => {
  let n = 0, release;
  const h = await host(async () => ++n === 1 ? Response.json({}) : new Promise(resolve => { release = resolve; }));
  try {
    const pending = h.run();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    h.select('B'); release(new Response('', { status: 403 }));
    await pending; assertDiagnostic(h); assert.equal(h.added.length, 0);
  } finally { await h.cleanup(); }
});
