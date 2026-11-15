import { make } from '@opencode/ai';
import { createSyntheticAntigravityPlugin as createAntigravityPlugin } from '../dist/configured-plugin.js';
import { model } from '../dist/configured-driver.js';

const configuration = {
  authorizationAcknowledged: true,
  providerId: 'synthetic-antigravity', integrationId: 'synthetic-antigravity-oauth', name: 'Synthetic configured integration',
  oauth: { issuer: 'https://auth.example', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token',
    clientId: 'synthetic-public-client', redirectUri: 'https://callback.example/complete', scopes: ['synthetic.inference'] },
  inference: { endpoint: 'https://inference.example/stream', project: 'synthetic-project', textSemantics: 'delta', usageSemantics: 'single-report' },
  models: [{ id: 'synthetic-model', modelID: 'synthetic-model', providerID: 'synthetic-antigravity', name: 'Synthetic model',
    capabilities: { tools: false, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 100, output: 10 } }],
};

const calls = [];
const plugin = createAntigravityPlugin(configuration, { fetch: async (url, init) => {
  calls.push(url === configuration.oauth.tokenEndpoint ? new URLSearchParams(init.body).get('grant_type') : 'inference');
  if (url === configuration.oauth.tokenEndpoint) return new Response(JSON.stringify({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 }));
  return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'Configured synthetic generation works' }] }, finishReason: 'STOP' }] } })}\n\n`);
} });

let method, provider, credential;
const registration = { dispose: async () => {} };
const cleanup = await plugin.setup({
  integration: { transform: async callback => { callback({ method: { update: value => { method = value; } }, update() {} }); return registration; },
    connection: { active: async () => ({ type: 'credential', id: 'synthetic-credential', method: 'oauth', label: 'Synthetic' }), resolve: async () => credential } },
  provider: { transform: async callback => { await callback({ add: value => { provider = value; } }); return registration; } },
});
try {
  const transaction = await method.authorize({});
  const state = new URL(transaction.url).searchParams.get('state');
  credential = await transaction.callback(`${configuration.oauth.redirectUri}?state=${state}&code=synthetic-code`);
  credential = await method.refresh(credential);
  const native = model('synthetic-model', { ...provider.info.settings, ...credential.metadata, apiKey: credential.access, headers: {}, body: {} });
  console.log((await make().generate({ model: native, prompt: 'Synthetic prompt' })).text);
  console.log(`In-memory stages: ${calls.join(' -> ')}`);
} finally { await cleanup(); }
