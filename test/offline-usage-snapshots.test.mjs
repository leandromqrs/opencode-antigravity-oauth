import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make, LLMEvent } from '@opencode/ai';
import { Schema } from 'effect';
import { createOfflineModel } from '../dist/offline-opencode.js';

const ai = make();
const frame = response => new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
const terminal = { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] };
const configuration = transport => ({ provider: 'synthetic', model: 'synthetic-model', requestId: 'synthetic-request',
  textSemantics: 'delta', usageSemantics: 'cumulative-snapshot', transport });
const fixture = (...responses) => async function* () { for (const response of responses) yield frame(response); };
const generate = (...responses) => ai.generate({ model: createOfflineModel(configuration(fixture(...responses))), prompt: 'synthetic' });

test('identical usage snapshots are not added and finish carries the last exact report', async () => {
  const snapshot = { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 7, thoughtsTokenCount: 2 };
  const result = await generate({ ...terminal, usageMetadata: snapshot }, { usageMetadata: snapshot });
  assert.equal(result.text, 'OK');
  assert.equal(result.usage.inputTokens, 3);
  assert.equal(result.usage.totalTokens, 7);
  assert.equal(result.usage.outputTokens, undefined);
  assert.deepEqual(result.usage.providerMetadata.offlineInference, snapshot);
});

test('monotonic partial snapshots add fields without synthesizing missing counts', async () => {
  const last = { candidatesTokenCount: 4, thoughtsTokenCount: 0 };
  const result = await generate({ usageMetadata: { candidatesTokenCount: 0 } },
    { ...terminal, usageMetadata: { candidatesTokenCount: 2 } }, { usageMetadata: last });
  assert.equal(result.usage.inputTokens, undefined);
  assert.equal(result.usage.totalTokens, undefined);
  assert.equal(result.usage.outputTokens, undefined);
  assert.deepEqual(result.usage.providerMetadata.offlineInference, last);
  assert.equal((await generate(terminal)).usage, undefined);
  assert.deepEqual((await generate({ ...terminal, usageMetadata: {} }, { usageMetadata: {} })).usage.providerMetadata.offlineInference, {});
});

test('every previously reported count must remain present and nondecreasing', async () => {
  for (const field of ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'toolUsePromptTokenCount', 'thoughtsTokenCount', 'cachedContentTokenCount']) {
    for (const next of [{ [field]: 12344 }, {}]) {
      const events = [];
      const model = createOfflineModel(configuration(fixture({ ...terminal, usageMetadata: { [field]: 12345 } }, { usageMetadata: next })));
      await assert.rejects((async () => { for await (const event of ai.stream({ model, prompt: 'synthetic' })) events.push(event); })(),
        error => error.message.includes('offline_stage=native_usage') && !error.message.includes('12345'));
      assert.equal(events.some(event => event.type === 'finish' || event.type === 'step-finish'), false);
    }
  }
});

test('usage does not bypass terminal, truncation, malformed counts or tool retention', async () => {
  const call = { candidates: [{ content: { parts: [{ functionCall: { name: 'probe', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } };
  for (const transport of [
    fixture({ usageMetadata: { totalTokenCount: 2 } }, { usageMetadata: { totalTokenCount: 3 } }),
    async function* () { yield frame(call); yield new TextEncoder().encode('data: {'); },
    fixture(call, { usageMetadata: { totalTokenCount: 1 } }),
    fixture(call, { usageMetadata: { totalTokenCount: -1 } }),
  ]) {
    const events = [];
    const model = createOfflineModel(configuration(transport));
    await assert.rejects((async () => {
      for await (const event of ai.stream({ model, prompt: 'synthetic', tools: [{ name: 'probe', description: 'synthetic probe', inputSchema: { type: 'object' } }] })) events.push(event);
    })());
    assert.equal(events.some(event => event.type === 'step-start'), true);
    assert.equal(events.some(event => ['finish', 'step-finish', 'tool-call'].includes(event.type)), false);
  }
});

test('valid usage trailers release buffered tools only at EOF with final snapshot', async () => {
  const responses = [
    { candidates: [{ content: { parts: [{ functionCall: { name: 'probe', args: {} } }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } },
    { usageMetadata: { totalTokenCount: 4 } },
  ];
  let eof = false;
  const model = createOfflineModel(configuration(async function* () { for (const response of responses) yield frame(response); eof = true; }));
  const events = [];
  for await (const event of ai.stream({ model, prompt: 'synthetic', tools: [{ name: 'probe', description: 'synthetic probe', inputSchema: { type: 'object' } }] })) {
    Schema.decodeUnknownSync(LLMEvent)(event);
    if (event.type === 'tool-call') assert.equal(eof, true);
    events.push(event);
  }
  assert.equal(events.filter(event => event.type === 'tool-call').length, 1);
  assert.equal(events.at(-1).usage.totalTokens, 4);
});

test('snapshot state is per request and single-report remains strict', async () => {
  const model = createOfflineModel(configuration(async function* (body) {
    const count = JSON.parse(body).request.contents[0].parts[0].text === 'a' ? 1 : 10;
    yield frame({ ...terminal, usageMetadata: { totalTokenCount: count } });
    await Promise.resolve();
    yield frame({ usageMetadata: { totalTokenCount: count + 1 } });
  }));
  const results = await Promise.all(['a', 'b'].map(prompt => ai.generate({ model, prompt })));
  assert.deepEqual(results.map(result => result.usage.totalTokens), [2, 11]);
  const strict = createOfflineModel({ ...configuration(fixture({ ...terminal, usageMetadata: {} }, { usageMetadata: {} })), usageSemantics: 'single-report' });
  await assert.rejects(ai.generate({ model: strict, prompt: 'synthetic' }));
});
