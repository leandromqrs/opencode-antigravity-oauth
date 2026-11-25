import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInferenceRequest, convertInferenceResponse, createInferenceDecoder, inferOffline } from '../dist/offline-inference.js';

const input = () => ({ project: 'synthetic-project', model: 'synthetic-model', requestId: 'synthetic-request', contents: [{ role: 'user', parts: [{ text: 'Olá' }] }] });
const wire = (parts, extra = {}) => ({ response: { candidates: [{ content: { role: 'model', parts }, ...extra }] } });
const frame = (value, newline = '\n') => new TextEncoder().encode(`data: ${JSON.stringify(value)}${newline}${newline}`);
const collect = async iterable => { const result = []; for await (const value of iterable) result.push(value); return result; };
const code = expected => error => error.code === expected && !error.message.includes('secret');

test('omits an absent project but validates every supplied project', () => {
  const { project, ...withoutProject } = input();
  assert.equal(Object.hasOwn(JSON.parse(buildInferenceRequest(withoutProject)), 'project'), false);
  assert.equal(JSON.parse(buildInferenceRequest(input())).project, project);
  for (const invalid of [undefined, '', ' ', null, 0, {}, 'bad\nproject']) {
    assert.throws(() => buildInferenceRequest({ ...withoutProject, project: invalid }));
  }
});

test('transport coalescing two valid 600 KiB frames does not impose a per-read frame limit', () => {
  const a = frame(wire([{ text: 'a'.repeat(600 * 1024) }]));
  const b = frame(wire([{ text: 'b'.repeat(600 * 1024) }], { finishReason: 'STOP' }));
  const joined = Buffer.concat([a, b]);
  const coalesced = createInferenceDecoder(), fragmented = createInferenceDecoder();
  const expected = [...fragmented.push(a), ...fragmented.push(b), ...fragmented.finish()];
  assert.deepEqual([...coalesced.push(joined), ...coalesced.finish()], expected);
});

test('serializes recovered wrapper, text, system, tools and optional zero values without defaults', () => {
  const value = { ...input(), systemInstruction: { parts: [{ text: 'synthetic instruction' }] },
    tools: [{ name: 'synthetic_tool', description: 'test only', parametersJsonSchema: { type: 'object', properties: { n: { type: 'number' } } } }],
    generationConfig: { temperature: 0, topP: 0, maxOutputTokens: 20, thinkingConfig: { includeThoughts: false, thinkingBudget: 0, thinkingLevel: 'LOW' } } };
  const body = JSON.parse(buildInferenceRequest(value));
  assert.deepEqual(body, { project: value.project, model: value.model, requestId: value.requestId, request: {
    contents: value.contents, systemInstruction: value.systemInstruction,
    tools: [{ functionDeclarations: value.tools }], generationConfig: value.generationConfig,
  } });
  assert.deepEqual(JSON.parse(buildInferenceRequest(input())).request, { contents: input().contents });
});

test('converts content, thought/signature, tool identity and zero/absent usage without fabricated totals', () => {
  const parts = [{ text: 'answer' }, { text: 'reason', thought: true, thoughtSignature: 'YWJj' },
    { functionCall: { id: 'call-1', name: 'synthetic_tool', args: { nested: { x: [1, true, null] } } } }];
  const result = convertInferenceResponse({ ...wire(parts, { finishReason: 1 }), response: {
    ...wire(parts, { finishReason: 1 }).response, usageMetadata: { promptTokenCount: 0, thoughtsTokenCount: 2 },
  } });
  assert.deepEqual(result.candidates, [{ index: 0, parts, finishReason: 'STOP' }]);
  assert.deepEqual(result.usage, { promptTokenCount: 0, thoughtsTokenCount: 2 });
  assert.equal(Object.hasOwn(result.usage, 'totalTokenCount'), false);
  assert.equal(Object.hasOwn(convertInferenceResponse(wire([{ text: '' }])), 'usage'), false);
  const toolResponse = { functionResponse: { id: 'call-1', name: 'synthetic_tool', response: { result: 0 } } };
  assert.deepEqual(JSON.parse(buildInferenceRequest({ ...input(), contents: [{ role: 'user', parts: [toolResponse] }] })).request.contents[0].parts, [toolResponse]);
});

test('rejects unsupported input, conflicting oneofs, malformed arguments and invalid numeric values', () => {
  for (const change of [{ model: '' }, { endpoint: 'secret' }, { contents: [] }, { generationConfig: { temperature: NaN } },
    { generationConfig: { maxOutputTokens: 2 ** 32 } }, { generationConfig: { thinkingConfig: { thinkingLevel: 'secret' } } },
    { contents: [{ role: 'system', parts: [{ text: 'secret' }] }] },
    { contents: [{ role: 'user', parts: [{ text: 'secret', functionCall: { name: 'x', args: {} } }] }] },
    { contents: [{ role: 'user', parts: [{ inlineData: { data: 'secret' } }] }] },
    { contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: [] } }] }] }]) {
    assert.throws(() => buildInferenceRequest({ ...input(), ...change }));
  }
  const cyclic = {}; cyclic.x = cyclic;
  assert.throws(() => buildInferenceRequest({ ...input(), tools: [{ name: 'x', parametersJsonSchema: cyclic }] }));
  assert.throws(() => buildInferenceRequest({ ...input(), contents: [{ role: 'user', parts: [{ text: 'x'.repeat(8_388_609) }] }] }), code('limit'));
});

test('rejects malformed/unsupported responses and sanitizes remote errors', () => {
  for (const value of [null, {}, { response: { candidates: 'secret' } }, wire([{ text: 'secret', functionCall: { name: 'x' } }]),
    wire([{ inlineData: { data: 'secret' } }]), wire([{ functionCall: { name: 'x', partialArgs: [] } }]),
    wire([{ text: 'secret' }], { finishReason: 'NEW_REASON' }), wire([{ text: 'secret' }], { index: 1 }),
    { response: { usageMetadata: { totalTokenCount: -1 } } }]) assert.throws(() => convertInferenceResponse(value));
  assert.throws(() => convertInferenceResponse({ error: { message: 'secret' } }), code('remote'));
  assert.throws(() => convertInferenceResponse({ response: { promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'secret' } } }), code('remote'));
  const v = JSON.parse('{"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"x","args":{"__proto__":{"secret":true}}}}]}}]}}');
  assert.throws(() => convertInferenceResponse(v));
});

test('injected offline transport connects request to fragmented text/tool/usage frames', async () => {
  let body;
  const first = wire([{ text: 'Olá 🌍' }, { functionCall: { name: 'synthetic_tool', id: 'c1', args: { x: 1 } } }]);
  const last = { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } } };
  async function* transport(request, signal) {
    body = JSON.parse(request); assert.equal(signal.aborted, false);
    for (const bytes of [frame(first), frame(last)]) for (const byte of bytes) yield Uint8Array.of(byte);
  }
  const chunks = await collect(inferOffline(input(), transport));
  assert.deepEqual(body.request.contents, input().contents);
  assert.deepEqual(chunks[0].candidates[0].parts, first.response.candidates[0].content.parts);
  assert.equal(chunks[1].candidates[0].finishReason, 'STOP');
  assert.equal(chunks[1].usage.totalTokenCount, 7);
});

test('decoder accepts LF, CRLF and a final undelimited frame; never assumes DONE or EOF success', () => {
  for (const newline of ['\n', '\r\n']) {
    const decoder = createInferenceDecoder();
    const bytes = frame(wire([{ text: 'x' }], { finishReason: 'MAX_TOKENS' }), newline);
    assert.equal(decoder.push(bytes).length, 1); assert.deepEqual(decoder.finish(), []);
    assert.throws(() => decoder.finish());
  }
  const tail = createInferenceDecoder();
  tail.push(new TextEncoder().encode(`data: ${JSON.stringify(wire([{ text: 'x' }], { finishReason: 'STOP' }))}`));
  assert.equal(tail.finish()[0].candidates[0].finishReason, 'STOP');
  const empty = createInferenceDecoder(); assert.throws(() => empty.finish(), code('truncated'));
  const partial = createInferenceDecoder(); partial.push(frame(wire([{ text: 'x' }])));
  assert.throws(() => partial.finish(), code('truncated'));
  assert.throws(() => createInferenceDecoder().push(new TextEncoder().encode('data: [DONE]\n\n')));
});

test('decoder rejects malformed framing/errors/UTF8, caps buffers and poisons failed instances', () => {
  for (const text of ['data: secret\n\n', 'data: {}\ndata: {}\n\n', 'event: secret\ndata: {}\n\n',
    `data: ${JSON.stringify({ error: { message: 'secret' } })}\n\n`, '{"error":{"message":"secret"}}\n\n']) {
    const d = createInferenceDecoder(); assert.throws(() => d.push(new TextEncoder().encode(text)));
    assert.throws(() => d.push(frame(wire([{ text: 'x' }], { finishReason: 'STOP' }))), code('closed'));
  }
  assert.throws(() => createInferenceDecoder().push(Uint8Array.of(255)), code('invalid'));
  const d = createInferenceDecoder(); d.push(Uint8Array.of(0xe2)); assert.throws(() => d.finish(), code('invalid'));
  const oversizedFrame = createInferenceDecoder(); oversizedFrame.push(new Uint8Array(1_048_577));
  assert.throws(() => oversizedFrame.finish(), code('limit'));
  assert.throws(() => createInferenceDecoder().push(new Uint8Array(1_048_581)), code('limit'));
  assert.throws(() => createInferenceDecoder().push(new Uint8Array(16 * 1_048_576 + 1)), code('limit'));
});

test('finish is a local explicit policy and usage-only trailers remain separate chunks', () => {
  const d = createInferenceDecoder();
  d.push(frame(wire([{ text: 'x' }], { finishReason: 'STOP' })));
  assert.deepEqual(d.push(frame({ response: { usageMetadata: { totalTokenCount: 1 } } }))[0].usage, { totalTokenCount: 1 });
  assert.deepEqual(d.finish(), []);
  const late = createInferenceDecoder(); late.push(frame(wire([{ text: 'x' }], { finishReason: 'STOP' })));
  assert.throws(() => late.push(frame(wire([{ text: 'secret' }]))));
});

test('offline iterator closes on consumer break, rejects sanitized transport failures and missing transport', async () => {
  let closed = false;
  async function* transport() { try { yield frame(wire([{ text: 'x' }])); } finally { closed = true; } }
  for await (const chunk of inferOffline(input(), transport)) { assert.equal(chunk.candidates[0].parts[0].text, 'x'); break; }
  assert.equal(closed, true);
  async function* broken() { throw new Error('secret'); }
  await assert.rejects(collect(inferOffline(input(), broken)), code('transport'));
  await assert.rejects(collect(inferOffline(input())), code('invalid'));
});

test('cancellation interrupts pending reads, strips abort reasons and requests iterator closure', async () => {
  const controller = new AbortController(); let returned = false; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const transport = () => ({ [Symbol.asyncIterator]() { return this; }, next() { entered(); return new Promise(() => {}); }, return() { returned = true; return Promise.resolve({ done: true }); } });
  const result = collect(inferOffline(input(), transport, { signal: controller.signal }));
  await started; controller.abort(new Error('secret'));
  await assert.rejects(result, code('cancelled')); assert.equal(returned, true);
  let called = false;
  await assert.rejects(collect(inferOffline(input(), () => { called = true; }, { signal: controller.signal })), code('cancelled'));
  assert.equal(called, false);
});

test('all recovered finish enums normalize without turning blocked/continuation reasons into STOP', () => {
  const reasons = ['FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'MODEL_ARMOR', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'IMAGE_OTHER', 'UNEXPECTED_TOOL_CALL', 'NO_IMAGE', 'MALFORMED_RESPONSE', 'CONTINUATION', 'TOO_MANY_TOOL_CALLS'];
  for (const [index, reason] of reasons.entries()) {
    for (const finishReason of [index, reason]) assert.equal(convertInferenceResponse(wire([{ text: 'x' }], { finishReason })).candidates[0].finishReason, reason);
  }
});

test('CRLF/UTF8 boundaries survive every byte split and chunks do not alias source objects', () => {
  const value = wire([{ text: '🌍' }], { finishReason: 'STOP' });
  const bytes = frame(value, '\r\n');
  for (let i = 0; i <= bytes.length; i++) {
    const d = createInferenceDecoder();
    const chunks = [...d.push(bytes.subarray(0, i)), ...d.push(bytes.subarray(i)), ...d.finish()];
    assert.equal(chunks.length, 1); assert.equal(chunks[0].candidates[0].parts[0].text, '🌍');
  }
  const converted = convertInferenceResponse(value); value.response.candidates[0].content.parts[0].text = 'changed';
  assert.equal(converted.candidates[0].parts[0].text, '🌍');
});

test('bounds aggregate object complexity and event counts, not only individual strings', () => {
  assert.throws(() => buildInferenceRequest({ ...input(), contents: [{ role: 'user', parts: Array.from({ length: 3 }, () => ({ text: 'x'.repeat(3_000_000) })) }] }), code('limit'));
  const d = createInferenceDecoder(); const bytes = frame(wire([{ text: 'x' }]));
  for (let i = 0; i < 1024; i++) d.push(bytes);
  assert.throws(() => d.push(bytes), code('limit'));
  const total = createInferenceDecoder(); const blank = new Uint8Array(1_048_576).fill(10);
  for (let i = 0; i < 16; i++) total.push(blank);
  assert.throws(() => total.push(Uint8Array.of(10)), code('limit'));
});

test('tool results can re-enter the next synthetic request and incomplete tools are explicit unsupported', async () => {
  const original = wire([{ functionCall: { name: 'synthetic_tool', id: 'c1', args: { n: 1 } } }], { finishReason: 'STOP' });
  const chunks = await collect(inferOffline(input(), async function* () { yield frame(original); }));
  const call = chunks[0].candidates[0].parts[0].functionCall;
  const next = JSON.parse(buildInferenceRequest({ ...input(), contents: [input().contents[0],
    { role: 'model', parts: chunks[0].candidates[0].parts },
    { role: 'user', parts: [{ functionResponse: { id: call.id, name: call.name, response: { n: 2 } } }] },
  ] }));
  assert.equal(next.request.contents[2].parts[0].functionResponse.response.n, 2);
  assert.throws(() => convertInferenceResponse(wire([{ functionCall: { name: 'x', willContinue: true } }])), code('unsupported'));
  assert.throws(() => convertInferenceResponse(wire([{ functionResponse: { name: 'x', scheduling: 'SILENT' } }])), code('unsupported'));
});

test('cancellation still applies while an EOF tail chunk is suspended at the consumer', async () => {
  const controller = new AbortController();
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(wire([{ text: 'tail' }], { finishReason: 'STOP' }))}`);
  const iterator = inferOffline(input(), async function* () { yield bytes; }, { signal: controller.signal });
  assert.equal((await iterator.next()).value.candidates[0].parts[0].text, 'tail');
  controller.abort('secret');
  await assert.rejects(iterator.next(), code('cancelled'));
});
