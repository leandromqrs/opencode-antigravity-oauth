import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make, LanguageModel, LLMEvent } from '@opencode/ai';
import { Schema } from 'effect';
import { createOfflineModel } from 'opencode-google-antigravity-oauth/offline-opencode';

const ai = make();
const config = transport => ({ provider: 'synthetic-offline', model: 'synthetic-model', project: 'synthetic-project',
  requestId: 'synthetic-request', textSemantics: 'delta', usageSemantics: 'single-report', transport });
const frame = response => new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
const candidate = (text, finishReason) => ({ candidates: [{ ...(text === undefined ? {} : { content: { parts: [{ text }] } }), ...(finishReason ? { finishReason } : {}) }] });
const fixture = (...responses) => async function* () { for (const response of responses) yield frame(response); };
const collect = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result; };

test('actual native model generates and streams via offline body, never fetch', async () => {
  let body, calls = 0;
  const model = createOfflineModel(config(async function* (request) {
    body = JSON.parse(request); calls++;
    yield frame(candidate('Olá ')); yield frame(candidate('🌍', 'STOP'));
    yield frame({ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 2, totalTokenCount: 2 } });
  }));
  assert.ok(model instanceof LanguageModel);
  const old = globalThis.fetch; globalThis.fetch = () => { throw Error('unexpected network'); };
  try {
    const response = await ai.generate({ model, system: 'synthetic system', prompt: 'synthetic prompt', generation: { temperature: 0, maxTokens: 5 } });
    assert.equal(response.text, 'Olá 🌍');
    assert.equal(response.usage.inputTokens, 0); assert.equal(response.usage.totalTokens, 2);
    assert.equal(response.usage.outputTokens, undefined);
    assert.equal(response.usage.providerMetadata.offlineInference.candidatesTokenCount, 2);
    assert.deepEqual(body, { project: 'synthetic-project', model: 'synthetic-model', requestId: 'synthetic-request', request: {
      contents: [{ role: 'user', parts: [{ text: 'synthetic prompt' }] }],
      systemInstruction: { parts: [{ text: 'synthetic system' }] }, generationConfig: { temperature: 0, maxOutputTokens: 5 },
    } });
    const events = await collect(ai.stream({ model, prompt: 'synthetic prompt' }));
    for (const event of events) Schema.decodeUnknownSync(LLMEvent)(event);
    assert.deepEqual(events.map(e => e.type), ['step-start', 'text-start', 'text-delta', 'text-delta', 'text-end', 'step-finish', 'finish']);
    assert.equal(events.at(-1).reason.raw, 'STOP'); assert.equal(calls, 2);
  } finally { globalThis.fetch = old; }
});

test('requires explicit configuration and semantics; rejects unknown keys without activation', () => {
  const valid = config(fixture(candidate('x', 'STOP')));
  for (const patch of [{ textSemantics: undefined }, { textSemantics: 'auto' }, { usageSemantics: undefined },
    { project: '' }, { transport: undefined }, { endpoint: 'secret' }, { apiKey: 'secret' }]) {
    assert.throws(() => createOfflineModel({ ...valid, ...patch }), e => !e.message.includes('secret'));
  }
  assert.throws(() => createOfflineModel({ ...valid, get model() { throw Error('secret'); } }), e => !e.message.includes('secret'));
});

test('rejects an explicitly undefined project while allowing an absent project', () => {
  const { project, ...withoutProject } = config(fixture(candidate('x', 'STOP')));
  assert.doesNotThrow(() => createOfflineModel(withoutProject));
  assert.throws(() => createOfflineModel({ ...withoutProject, project: undefined }));
});

test('explicit cumulative snapshots become deltas and non-prefix revisions fail', async () => {
  const model = createOfflineModel({ ...config(fixture(candidate('a'), candidate('ab'), candidate('ab', 'STOP'))), textSemantics: 'cumulative' });
  assert.equal((await ai.generate({ model, prompt: 'x' })).text, 'ab');
  const invalid = createOfflineModel({ ...config(fixture(candidate('ab'), candidate('secret', 'STOP'))), textSemantics: 'cumulative' });
  await assert.rejects(ai.generate({ model: invalid, prompt: 'x' }), e => !e.message.includes('secret'));
});

test('missing usage stays missing; zero/partial usage preserved, multiple reports rejected', async () => {
  const absent = createOfflineModel(config(fixture(candidate('', 'STOP'))));
  assert.equal((await ai.generate({ model: absent, prompt: 'x' })).usage, undefined);
  const partial = createOfflineModel(config(fixture({ ...candidate('x', 'STOP'), usageMetadata: { candidatesTokenCount: 0 } })));
  const usage = (await ai.generate({ model: partial, prompt: 'x' })).usage;
  assert.equal(usage.totalTokens, undefined); assert.equal(usage.inputTokens, undefined);
  assert.equal(usage.providerMetadata.offlineInference.candidatesTokenCount, 0);
  const repeated = createOfflineModel(config(fixture({ ...candidate('x', 'STOP'), usageMetadata: { totalTokenCount: 1 } }, { usageMetadata: { totalTokenCount: 2 } })));
  await assert.rejects(ai.generate({ model: repeated, prompt: 'x' }));
});

test('unsupported reasoning fields and provider options fail before transport', async () => {
  let called = false;
  const model = createOfflineModel(config(async function* () { called = true; yield frame(candidate('x', 'STOP')); }));
  for (const patch of [ { providerOptions: { secret: true } }, { generation: { topK: 4 } },
    { messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'secret', encrypted: 'secret' }] }] },
    { http: { headers: { Authorization: 'secret' } } }, { includeRaw: true }, { cache: 'auto' } ]) {
    await assert.rejects(ai.generate({ model, prompt: 'x', ...patch }), e => e.reason?._tag === 'InvalidRequest' && !e.message.includes('secret'));
    assert.equal(called, false);
  }
});

test('unsupported output cannot be silently discarded or emitted as raw events', async () => {
  for (const part of [{ text: 'secret', thought: 'true' }, { text: 'secret', thoughtSignature: 'invalid!' },
    { inlineData: { mimeType: 'image/png', data: 'YWJj' } }, { functionCall: { name: 'secret', args: {} } }]) {
    const model = createOfflineModel(config(fixture({ candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] })));
    await assert.rejects(ai.generate({ model, prompt: 'x' }), e => !e.message.includes('secret') && !JSON.stringify(e).includes('secret'));
  }
});

test('terminal mapping preserves raw reasons without claiming blocked/continuation success', async () => {
  for (const [raw, normalized] of [['MAX_TOKENS', 'length'], ['SAFETY', 'content-filter'], ['CONTINUATION', 'unknown'], ['OTHER', 'unknown']]) {
    const model = createOfflineModel(config(fixture(candidate('x', raw))));
    const events = await collect(ai.stream({ model, prompt: 'x' }));
    assert.deepEqual(events.at(-1).reason, { raw, normalized });
  }
});

test('transport failure and premature EOF reject without terminal success or secret diagnostics', async () => {
  for (const transport of [async function* () { throw Error('secret'); }, fixture(candidate('partial'))]) {
    const model = createOfflineModel(config(transport));
    const events = [];
    await assert.rejects((async () => { for await (const event of ai.stream({ model, prompt: 'x' })) events.push(event); })(), e => !JSON.stringify(e).includes('secret'));
    assert.equal(events.some(e => e.type === 'finish'), false);
  }
});

test('SDK abort interrupts pending offline read and requests iterator cleanup', { timeout: 5000 }, async () => {
  let enter, returned = false, signal;
  const started = new Promise(resolve => { enter = resolve; });
  const transport = (_body, s) => { signal = s; return { [Symbol.asyncIterator]() { return this; }, next() { enter(); return new Promise(() => {}); }, return() { returned = true; return Promise.resolve({ done: true }); } }; };
  const model = createOfflineModel(config(transport));
  const controller = new AbortController();
  const pending = ai.generate({ model, prompt: 'x' }, { signal: controller.signal });
  await started; controller.abort(); await assert.rejects(pending);
  assert.equal(signal.aborted, true); assert.equal(returned, true);
});

test('SDK stream consumer break cancels and closes caller-owned transport', async () => {
  let closed = false, signal;
  const model = createOfflineModel(config(async function* (_body, s) { signal = s; try { yield frame(candidate('x')); } finally { closed = true; } }));
  for await (const event of ai.stream({ model, prompt: 'x' })) { if (event.type === 'text-delta') break; }
  assert.equal(signal.aborted, true); assert.equal(closed, true);
});

test('offline factory stays a named helper alongside the inert root plugin and snapshots configuration', async () => {
  const exported = await import('opencode-google-antigravity-oauth/offline-opencode');
  assert.deepEqual(Object.keys(exported), ['createOfflineModel']);
  assert.equal(typeof (await import('opencode-google-antigravity-oauth')).default.setup, 'function');
  const settings = config(fixture(candidate('x', 'STOP')));
  const model = createOfflineModel(settings);
  settings.transport = () => { throw Error('secret'); }; settings.textSemantics = 'auto';
  assert.equal((await ai.generate({ model, prompt: 'x' })).text, 'x');
  assert.throws(() => createOfflineModel({ ...config(fixture()), unexpected: undefined }));
});

test('canonical SDK input rejects message metadata, raw/native hints and conflicting request identity', async () => {
  let called = false;
  const model = createOfflineModel(config(async function* () { called = true; yield frame(candidate('x', 'STOP')); }));
  for (const patch of [{ id: 'different' }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'x', metadata: { secret: true } }] }] },
    { messages: [{ role: 'assistant', content: 'x', native: { secret: true } }] }, { promptCacheKey: { secret: true } }]) {
    await assert.rejects(ai.generate({ model, prompt: 'x', ...patch }), e => e.reason?._tag === 'InvalidRequest' && !e.message.includes('secret'));
  }
  assert.equal(called, false);
});

test('concurrent requests have separate stream state and byte-fragmented decoding', async () => {
  const model = createOfflineModel(config(async function* (body) {
    const prompt = JSON.parse(body).request.contents[0].parts[0].text;
    for (const response of [candidate(prompt), candidate('!', 'STOP')]) {
      for (const byte of frame(response)) yield Uint8Array.of(byte);
    }
  }));
  const [a, b] = await Promise.all(['a', 'b'].map(prompt => ai.generate({ model, prompt })));
  assert.equal(a.text, 'a!'); assert.equal(b.text, 'b!');
});
