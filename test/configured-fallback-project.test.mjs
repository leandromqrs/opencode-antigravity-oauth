import assert from 'node:assert/strict';
import { createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { make } from '@opencode/ai';
import { createCatalogClient } from '../dist/configured-catalog.js';
import { model } from '../dist/configured-driver.js';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';

test('403 fallback retains the validated project for inference without exposing it in diagnostics', async () => {
  const project = 'synthetic-private-project';
  const options = { mode: 'agy-local-oauth', authorizationAcknowledged: true };
  const config = validateLocalOAuthConfiguration(options);
  const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
  let inferenceBody;
  const added = [];
  const providerHost = createProviderHost(value => { added.push(value); });
  const fetch = async (url, init) => {
    if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: project });
    if (url.endsWith(':fetchAvailableModels')) return Response.json({ error: { message: project } }, { status: 403 });
    if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
      inferenceBody = JSON.parse(init.body);
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } })}\n\n`);
    }
    throw new Error('Unexpected request');
  };
  const catalog = createCatalogClient(fetch, new AbortController().signal);
  await assert.rejects(catalog.discover('synthetic-access', async () => {}), error => {
    assert.equal(error.status, 403);
    assert.doesNotMatch(JSON.stringify(error) + error.message + String(error), new RegExp(project));
    return true;
  });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch }).setup({
    integration: {
      transform: async cb => { await cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => ({ type: 'credential', id: 'A', method: 'oauth' }), resolve: async () => credential },
    },
    event: providerHost.event, provider: providerHost.provider,
  });
  try {
    assert.equal(added.length, 1);
    assert.doesNotMatch(JSON.stringify(added), new RegExp(project));
    const native = model('gemini-3.8-flash', added[0].info.settings);
    assert.equal((await make().generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    assert.equal(inferenceBody.project, project);
    assert.equal(inferenceBody.model, 'gemini-3.8-flash-medium');
  } finally { await cleanup(); }
});
