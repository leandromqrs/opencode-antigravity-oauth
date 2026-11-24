import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';

const options = { mode: 'google-agy-oauth', authorizationAcknowledged: true };
const config = validateLocalOAuthConfiguration(options);
const loadEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
const modelsEndpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the catalog is renewed ahead of expiry so model binding never gaps', async () => {
  let now = 1_000_000;
  let modelCalls = 0;
  let hang = false;
  let releaseHang;
  const fetch = async url => {
    if (url === loadEndpoint) return Response.json({ cloudaicompanionProject: 'synthetic-project' });
    if (url === modelsEndpoint) {
      modelCalls++;
      if (hang) await new Promise(resolve => { releaseHang = resolve; });
      return Response.json({ defaultAgentModelId: 'synthetic-chat', models: { 'synthetic-chat': { displayName: 'Synthetic chat', maxTokens: 8192, maxOutputTokens: 2048 } } });
    }
    return new Response('', { status: 599 });
  };
  const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: now + 7_200_000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
  const selected = { type: 'credential', method: 'oauth', id: 'A' };
  let callback;
  const queue = [];
  let wake;
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch, now: () => now }).setup({
    integration: {
      transform: async cb => { cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => selected, resolve: async () => credential },
    },
    provider: { transform: async cb => { callback = cb; return { dispose: async () => {} }; }, reload: async () => {} },
    event: { async *subscribe({ signal }) {
      const abort = () => wake?.();
      signal.addEventListener('abort', abort, { once: true });
      try {
        while (!signal.aborted) {
          if (!queue.length) await new Promise(resolve => { wake = resolve; if (signal.aborted) resolve(); });
          const item = queue.shift();
          if (!item) continue;
          try { yield item.event; } finally { item.done(); }
        }
      } finally { signal.removeEventListener('abort', abort); }
    } },
  });
  const render = () => { const providers = []; callback({ add(value) { providers.push(value); } }); return providers; };
  const settingsOf = entry => ({ ...entry.info.settings, apiKey: credential.access, configuration: binding(config), issuer: config.oauth.issuer, headers: {}, body: {} });
  try {
    const entry = render()[0];
    assert.ok(entry, 'catalog published after sign-in');
    const driver = await import(entry.info.package);
    assert.ok(driver.model('synthetic-chat', settingsOf(entry)), 'binds while the inventory is fresh');

    now += 50_000;
    hang = true;
    const refreshed = new Promise(resolve => { queue.push({ event: { type: 'credential.updated', data: {} }, done: resolve }); wake?.(); });
    const deadline = Date.now() + 2000;
    while (modelCalls < 2 && Date.now() < deadline) await sleep(1);
    assert.equal(modelCalls, 2, 'renews proactively before the inventory expires');
    assert.ok(driver.model('synthetic-chat', settingsOf(render()[0])), 'keeps binding to the valid inventory during renewal');
    releaseHang();
    await refreshed;
    now += 20_000;
    assert.ok(driver.model('synthetic-chat', settingsOf(render()[0])), 'still binds after the original expiry because the catalog was renewed');
  } finally { await cleanup(); }
});
