import assert from 'node:assert/strict';
import { createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { make, LLMEvent } from '@opencode/ai';
import { Model } from '@opencode/plugin';
import { Schema } from 'effect';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';

for (const fallback of [false, true]) {
  test(`V2 local ${fallback ? 'fallback' : 'discovery'} publishes tools and dispatches tool requests to the driver`, async () => {
    const config = validateLocalOAuthConfiguration({ mode: 'agy-local-oauth', authorizationAcknowledged: true });
    const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000,
      metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
    let published, request;
    const providerHost = createProviderHost(value => { published = value; });
    const fetch = async (url, init) => {
      if (url.endsWith(':loadCodeAssist')) return Response.json({});
      if (url.endsWith(':fetchAvailableModels')) return fallback ? new Response('', { status: 403 })
        : Response.json({ defaultAgentModelId: 'live', models: { live: { maxTokens: 1000, maxOutputTokens: 100 } } });
      assert.equal(url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
      request = JSON.parse(init.body);
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { id: 'c1', name: 'lookup_tool', args: { query: 'x' } } }] }, finishReason: 'STOP' }] } })}\n\n`);
    };
    const cleanup = await createLocalAntigravityOAuthPlugin({ mode: 'agy-local-oauth', authorizationAcknowledged: true }, { fetch }).setup({
      integration: { transform: async cb => { await cb({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
        connection: { active: async () => ({ type: 'credential', id: 'A', method: 'oauth' }), resolve: async () => credential } },
      event: providerHost.event, provider: providerHost.provider,
    });
    try {
      await providerHost.run();
      assert.ok(published.models.length);
      for (const item of published.models) {
        Schema.decodeUnknownSync(Model.Info)(item);
        assert.equal(item.capabilities.tools, true);
      }
      const selected = published.models[0];
      const driver = await import(published.info.package);
      const native = driver.model(selected.modelID, published.info.settings);
      const events = [];
      for await (const event of make().stream({ model: native, prompt: 'find x', tools: [{ name: 'lookup-tool', description: 'lookup',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] })) events.push(event);
      assert.equal(request.request.tools[0].functionDeclarations[0].name, 'lookup_tool');
      assert.deepEqual(events.find(event => event.type === 'tool-call'), { type: 'tool-call', id: 'c1', name: 'lookup-tool', input: { query: 'x' } });
      assert.equal(events.at(-1).reason.normalized, 'tool-calls');
      for (const event of events) Schema.decodeUnknownSync(LLMEvent)(event);
    } finally { await cleanup(); }
  });
}
