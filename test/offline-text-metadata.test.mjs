import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make, LLMEvent } from '@opencode/ai';
import { Schema } from 'effect';
import { createOfflineModel } from 'opencode-google-antigravity-oauth/offline-opencode';

const ai = make();
const frame = response => new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
const response = (parts, finishReason) => ({ candidates: [{ content: { parts }, ...(finishReason ? { finishReason } : {}) }] });
const fixture = (...responses) => async function* () { for (const value of responses) yield frame(value); };
const config = transport => ({ provider: 'synthetic-offline', model: 'synthetic-model', requestId: 'synthetic-request',
  textSemantics: 'delta', usageSemantics: 'single-report', transport });
const collect = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result; };
const metadata = thoughtSignature => ({ offlineInference: { thoughtSignature } });

test('SDK separates reasoning from visible text and closes blocks on transitions', async () => {
  const model = createOfflineModel(config(fixture(response([
    { text: 'synthetic thought', thought: true }, { text: 'synthetic answer', thought: false },
  ], 'STOP'))));
  const events = await collect(ai.stream({ model, prompt: 'x' }));
  for (const event of events) Schema.decodeUnknownSync(LLMEvent)(event);
  assert.deepEqual(events.map(event => event.type), ['step-start', 'reasoning-start', 'reasoning-delta', 'reasoning-end',
    'text-start', 'text-delta', 'text-end', 'step-finish', 'finish']);
  const result = await ai.generate({ model, prompt: 'x' });
  assert.equal(result.text, 'synthetic answer');
  assert.equal(result.usage, undefined);
  assert.notEqual(events[1].id, events[4].id);
});

test('reasoning-only STOP never becomes a visible answer', async () => {
  const model = createOfflineModel(config(fixture(response([{ text: 'synthetic thought', thought: true }], 'STOP'))));
  const result = await ai.generate({ model, prompt: 'x' });
  assert.equal(result.text, '');
  assert.deepEqual(result.message.content, [{ type: 'reasoning', text: 'synthetic thought' }]);
  assert.equal(result.events.some(event => event.type.startsWith('text-')), false);
});

test('SDK signed text and reasoning retain per-part metadata and round-trip assistant history', async () => {
  let body;
  const parts = [{ text: 'synthetic thought', thought: true, thoughtSignature: 'YWJj' },
    { text: 'synthetic answer', thought: false, thoughtSignature: 'ZGVm' }];
  const model = createOfflineModel(config(async function* (request) {
    body = JSON.parse(request);
    yield frame(response(parts, 'STOP'));
  }));
  const result = await ai.generate({ model, prompt: 'x' });
  assert.equal(result.text, 'synthetic answer');
  assert.deepEqual(result.message.content, [
    { type: 'reasoning', text: 'synthetic thought', providerMetadata: metadata('YWJj') },
    { type: 'text', text: 'synthetic answer', providerMetadata: metadata('ZGVm') },
  ]);
  await ai.generate({ model, messages: [result.message] });
  assert.deepEqual(body.request.contents, [{ role: 'model', parts: [parts[0], { text: 'synthetic answer', thoughtSignature: 'ZGVm' }] }]);
});

test('signed Parts remain distinct even with identical signatures or empty text', async () => {
  const parts = [
    { text: 'unsigned' }, { text: 'first', thoughtSignature: 'YWJj' },
    { text: 'second', thoughtSignature: 'YWJj' }, { text: '', thoughtSignature: 'ZGVm' },
    { text: 'tail' }, { text: '', thought: true, thoughtSignature: '' },
  ];
  const model = createOfflineModel(config(fixture(...parts.map((part, index) => response([part], index === parts.length - 1 ? 'STOP' : undefined)))));
  const result = await ai.generate({ model, prompt: 'x' });
  assert.deepEqual(result.message.content, parts.map(part => ({ type: part.thought ? 'reasoning' : 'text', text: part.text,
    ...(part.thoughtSignature === undefined ? {} : { providerMetadata: metadata(part.thoughtSignature) }) })));
  const starts = result.events.filter(event => event.type === 'text-start' || event.type === 'reasoning-start');
  assert.equal(new Set(starts.map(event => event.id)).size, parts.length);
  assert.equal(result.text, 'unsignedfirstsecondtail');
});

test('unsigned reasoning history lowers explicitly without leaking reasoning into text', async () => {
  let body;
  const model = createOfflineModel(config(async function* (request) {
    body = JSON.parse(request); yield frame(response([{ text: 'visible' }], 'STOP'));
  }));
  await ai.generate({ model, messages: [{ role: 'assistant', content: [
    { type: 'reasoning', text: 'thought' }, { type: 'text', text: 'answer' },
  ] }] });
  assert.deepEqual(body.request.contents, [{ role: 'model', parts: [{ text: 'thought', thought: true }, { text: 'answer' }] }]);
});

test('cumulative snapshots track reasoning and visible text independently across transitions', async () => {
  const frames = [response([{ text: 'r', thought: true }]), response([{ text: 'rr', thought: true }]),
    response([{ text: 'a', thought: false }]), response([{ text: 'aa' }]),
    response([{ text: 'rrr', thought: true }]), response([{ text: 'aaa' }], 'STOP')];
  const model = createOfflineModel({ ...config(fixture(...frames)), textSemantics: 'cumulative' });
  const result = await ai.generate({ model, prompt: 'x' });
  assert.equal(result.text, 'aaa');
  assert.deepEqual(result.message.content, [
    { type: 'reasoning', text: 'rr' }, { type: 'text', text: 'aa' },
    { type: 'reasoning', text: 'r' }, { type: 'text', text: 'a' },
  ]);
  const invalid = createOfflineModel({ ...config(fixture(response([{ text: 'r', thought: true }]),
    response([{ text: 'answer' }]), response([{ text: 'changed', thought: true }], 'STOP'))), textSemantics: 'cumulative' });
  await assert.rejects(ai.generate({ model: invalid, prompt: 'x' }));
});

test('assistant metadata only accepts the opaque signature whitelist; user/system stay strict', async () => {
  let calls = 0;
  const model = createOfflineModel(config(async function* () { calls++; yield frame(response([{ text: 'ok' }], 'STOP')); }));
  const invalidMetadata = [null, {}, { other: { thoughtSignature: 'YWJj' } },
    { ...metadata('YWJj'), other: {} }, { offlineInference: {} },
    { offlineInference: { thoughtSignature: 'YWJj', unknown: true } },
    { offlineInference: { thoughtSignature: 1 } }, metadata('invalid!')];
  for (const type of ['text', 'reasoning']) {
    for (const providerMetadata of invalidMetadata) {
      await assert.rejects(ai.generate({ model, messages: [{ role: 'assistant', content: [{ type, text: 'secret', providerMetadata }] }] }), `${type}: metadata`);
    }
    for (const extra of [...(type === 'reasoning' ? [{ encrypted: 'secret' }] : []), { cache: { type: 'ephemeral' } }, { metadata: { secret: true } }]) {
      await assert.rejects(ai.generate({ model, messages: [{ role: 'assistant', content: [{ type, text: 'secret', ...extra }] }] }), `${type}: ${Object.keys(extra)}`);
    }
  }
  for (const part of [{ type: 'reasoning', text: 1 }, { type: 'reasoning', encrypted: 'secret' }]) {
    await assert.rejects(ai.generate({ model, messages: [{ role: 'assistant', content: [part] }] }));
  }
  for (const role of ['user', 'system']) {
    const part = { type: 'text', text: 'secret', ...(role === 'user' ? { providerMetadata: metadata('YWJj') } : { metadata: { secret: true } }) };
    const input = role === 'user' ? { messages: [{ role, content: [part] }] } : { system: [part], prompt: 'x' };
    await assert.rejects(ai.generate({ model, ...input }));
  }
  assert.equal(calls, 0);
});

test('a signed cumulative snapshot seals its exact text; later signed revisions fail closed', async () => {
  const model = createOfflineModel({ ...config(fixture(response([{ text: 'a' }]),
    response([{ text: 'ab', thoughtSignature: 'YWJj' }], 'STOP'))), textSemantics: 'cumulative' });
  const result = await ai.generate({ model, prompt: 'x' });
  assert.deepEqual(result.message.content, [{ type: 'text', text: 'ab', providerMetadata: metadata('YWJj') }]);
  for (const parts of [
    [{ text: 'a', thoughtSignature: 'YWJj' }, { text: 'ab', thoughtSignature: 'ZGVm' }],
    [{ text: 'a', thoughtSignature: 'YWJj' }, { text: 'ab' }],
  ]) {
    const invalid = createOfflineModel({ ...config(fixture(response([parts[0]]), response([parts[1]], 'STOP'))), textSemantics: 'cumulative' });
    await assert.rejects(ai.generate({ model: invalid, prompt: 'x' }));
  }
});

test('reasoning shares the 1 MiB UTF-8 output budget with visible text', async () => {
  for (const thought of [true, false]) {
    const atLimit = createOfflineModel(config(fixture(response([{ text: 'é'.repeat(262_144), thought }]),
      response([{ text: 'a'.repeat(524_288), thought: !thought }], 'STOP'))));
    assert.equal((await ai.generate({ model: atLimit, prompt: 'x' })).finishReason.normalized, 'stop');
    const model = createOfflineModel(config(fixture(response([{ text: 'é'.repeat(262_144), thought }]),
      response([{ text: 'a'.repeat(524_288), thought: !thought }]), response([{ text: 'x', thought }], 'STOP'))));
    const events = [];
    await assert.rejects(async () => { for await (const event of ai.stream({ model, prompt: 'x' })) events.push(event); },
      error => error.reason?._tag === 'InvalidResponseBody' || error.message.includes('native_output'));
    assert.equal(events.some(event => event.type === 'finish'), false);
  }
});

test('reasoning and signatures do not bypass missing terminal, trailing errors or repeated usage', async () => {
  const signed = { text: 'synthetic', thought: true, thoughtSignature: 'YWJj' };
  const usage = { usageMetadata: { totalTokenCount: 1 } };
  for (const transport of [fixture(response([signed])),
    async function* () { yield frame(response([signed], 'STOP')); throw Error('secret'); },
    fixture(response([signed], 'STOP'), usage, usage)]) {
    const model = createOfflineModel(config(transport));
    const events = [];
    await assert.rejects(async () => { for await (const event of ai.stream({ model, prompt: 'x' })) events.push(event); },
      error => !JSON.stringify(error).includes('secret'));
    assert.equal(events.some(event => event.type === 'finish'), false);
  }
});

test('reasoning/text transitions never release buffered tools before STOP and valid EOF', async () => {
  const call = { functionCall: { id: 'synthetic-call', name: 'run', args: {} }, thoughtSignature: 'YWJj' };
  for (const failure of ['missing-stop', 'blocked', 'bad-tail', 'none']) {
    let enteredEOF = false;
    const model = createOfflineModel(config(async function* () {
      yield frame(response([{ text: 'thought', thought: true }, call, { text: 'answer' }],
        failure === 'missing-stop' ? undefined : failure === 'blocked' ? 'SAFETY' : 'STOP'));
      if (failure === 'bad-tail') throw Error('secret');
      enteredEOF = true;
    }));
    const events = [];
    const run = async () => {
      for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'run', description: '', inputSchema: { type: 'object' } }] })) {
        if (event.type === 'tool-call') assert.equal(enteredEOF, true);
        events.push(event);
      }
    };
    if (failure === 'none') {
      await run();
      const tool = events.find(event => event.type === 'tool-call');
      assert.deepEqual(tool.providerMetadata, metadata('YWJj'));
      assert.equal(events.at(-1).reason.normalized, 'tool-calls');
    } else {
      await assert.rejects(run);
      assert.equal(events.some(event => ['tool-call', 'finish'].includes(event.type)), false);
    }
  }
});
