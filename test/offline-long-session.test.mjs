import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make } from '@opencode/ai';
import { createOfflineModel } from '../dist/offline-opencode.js';
import { buildInferenceRequest } from '../dist/offline-inference.js';

const frame = value => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const stop = { response: { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } };
const config = transport => ({ provider: 'antigravity-local', model: 'gemini-3.8-flash', requestId: 'probe', textSemantics: 'delta', usageSemantics: 'cumulative-snapshot', transport, localIdentity: true });
const ai = make();
const okTransport = async function* () { yield frame(stop); };
const tool = i => ({ type: 'tool', name: `tool_${i}`, description: 'synthetic', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } });

test('long agent sessions bind: 300 messages, 120 tools and multi-megabyte tool results', async () => {
  const model = createOfflineModel(config(okTransport));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    ...Array.from({ length: 150 }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool-call', id: `c${i}`, name: 'read', input: { path: `file-${i}` } }] },
      { role: 'tool', content: [{ type: 'tool-result', id: `c${i}`, name: 'read', result: { type: 'text', value: 'x'.repeat(15_000) } }] },
    ]).flat(),
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  assert.equal((await ai.generate({ model, messages, tools: Array.from({ length: 120 }, (_, i) => tool(i)) })).text, 'ok');
  assert.throws(() => buildInferenceRequest({ model: 'm', requestId: 'r', contents: Array.from({ length: 1025 }, () => ({ role: 'user', parts: [{ text: 'x' }] })) }));
  assert.throws(() => buildInferenceRequest({ model: 'm', requestId: 'r', contents: [{ role: 'user', parts: [{ text: 'x' }] }], tools: Array.from({ length: 257 }, (_, i) => ({ name: `t${i}`, parametersJsonSchema: { type: 'object' } })) }));
});

test('history carried over from other providers keeps its metadata without breaking the request', async () => {
  const model = createOfflineModel(config(okTransport));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'thought', providerMetadata: { anthropic: { signature: 'foreign' } } },
      { type: 'text', text: 'answer', providerMetadata: { openai: { item_id: 'foreign' } } },
      { type: 'tool-call', id: 'c1', name: 'read', input: { path: 'f' }, providerMetadata: { anthropic: { signature: 'foreign' } } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read', result: { type: 'text', value: 'data' }, providerMetadata: { google: { thoughtSignature: 'foreign' } } }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  assert.equal((await ai.generate({ model, messages })).text, 'ok');
});

test('our own thought signature still round-trips through foreign metadata', async () => {
  let body;
  const model = createOfflineModel(config(async function* (request) { body = JSON.parse(request); yield frame(stop); }));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'thought', providerMetadata: { anthropic: { signature: 'foreign' }, offlineInference: { thoughtSignature: 'YWJj' } } }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  await ai.generate({ model, messages });
  const part = body.request.contents[1].parts[0];
  assert.equal(part.thoughtSignature, 'YWJj');
  assert.equal(part.thought, true);
  assert.equal(Object.hasOwn(part, 'anthropic'), false);
});

test('OpenCode 2.4 tool parts bind: content results and namespace fields', async () => {
  let body;
  const model = createOfflineModel(config(async function* (request) { body = JSON.parse(request); yield frame(stop); }));
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', namespace: 'srv', input: { path: 'f' } }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read', namespace: 'srv', result: { type: 'content', value: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ];
  assert.equal((await ai.generate({ model, messages })).text, 'ok');
  const parts = body.request.contents.flatMap(c => c.parts);
  const response = parts.find(p => p.functionResponse && p.functionResponse.id === 'c1').functionResponse.response;
  assert.deepEqual(response.result, [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]);
});

test('content tool results reject malformed entries', async () => {
  const model = createOfflineModel(config(okTransport));
  const base = [
    { role: 'user', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', input: {} }] },
  ];
  for (const value of ['secret', [{ type: 'text' }], [{ type: 'file', uri: 'x' }], [{ type: 'secret', text: 'x' }]]) {
    await assert.rejects(ai.generate({ model, messages: [...base, { role: 'tool', content: [{ type: 'tool-result', id: 'c1', name: 'read', result: { type: 'content', value } }] }, { role: 'user', content: [{ type: 'text', text: 'go' }] }] }));
  }
});
