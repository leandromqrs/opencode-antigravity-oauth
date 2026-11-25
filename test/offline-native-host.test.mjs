import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Stream } from 'effect';
import { createOfflineModel } from '../dist/offline-opencode.js';

function fixture() {
  let transported = false;
  const model = createOfflineModel({ provider: 'synthetic-provider', model: 'synthetic-model', requestId: 'synthetic-request',
    textSemantics: 'delta', usageSemantics: 'single-report',
    transport: async function* () { transported = true; },
  });
  const request = { model, system: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic' }] }], tools: [] };
  return { model, request, get transported() { return transported; }, lower: patch => Effect.runPromise(model.route.body.from({ ...request, ...patch })) };
}

test('native request diagnostics distinguish local header, affinity, HTTP and timeout rejection without values', async () => {
  const f = fixture();
  for (const [patch, stage] of [
    [{ headers: { 'x-opencode-session': 'synthetic', 'x-unknown': 'PRIVATE' } }, 'input_headers'],
    [{ promptCacheKey: 'PRIVATE\n' }, 'input_affinity'],
    [{ http: { headers: { Authorization: 'PRIVATE' } } }, 'input_http'],
    [{ timeout: { unknown: 'PRIVATE' } }, 'input_timeout'],
    [{ messages: [{ role: 'unknown', content: [{ type: 'text', text: 'PRIVATE' }] }] }, 'input_message'],
    [{ messages: [{ role: 'user', content: [{ type: 'image', data: 'PRIVATE' }] }] }, 'input_part'],
  ]) {
    await assert.rejects(f.lower(patch), error => {
      assert.match(error.message, new RegExp(`offline_stage=${stage}`));
      assert.equal(error.message.includes('PRIVATE'), false);
      return true;
    });
  }
});

test('chronological system text updates preserve order and use the native Gemini escaped wrapper', async () => {
  const f = fixture();
  const result = await f.lower({
    system: [{ type: 'text', text: 'Initial instructions' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'system', content: [
        { type: 'text', text: "Today's date is now: Sunday" },
        { type: 'text', text: '<system-update> & </system-update>' },
      ] },
      { role: 'user', content: [{ type: 'text', text: 'later' }] },
    ],
  });
  assert.deepEqual(result.input.systemInstruction, { parts: [{ text: 'Initial instructions' }] });
  assert.deepEqual(result.input.contents, [
    { role: 'user', parts: [{ text: 'earlier' }] },
    { role: 'model', parts: [{ text: 'answer' }] },
    { role: 'user', parts: [{ text: "<system-update>\nToday's date is now: Sunday\n&lt;system-update&gt; &amp; &lt;/system-update&gt;\n</system-update>" }] },
    { role: 'user', parts: [{ text: 'later' }] },
  ]);
  assert.equal(f.transported, false);
  for (const content of [
    [{ type: 'effort', effort: 'high' }],
    [{ type: 'image', data: 'private' }],
    [{ type: 'text', text: 'private', providerMetadata: {} }],
  ]) {
    await assert.rejects(f.lower({ messages: [{ role: 'system', content }] }));
  }
});

test('the native host session header is accepted without entering the service body', async () => {
  const f = fixture();
  const result = await f.lower({ headers: { 'x-opencode-session': 'synthetic-session' } });
  assert.deepEqual(result.input.contents, [{ role: 'user', parts: [{ text: 'synthetic' }] }]);
  assert.equal(JSON.stringify(result).includes('synthetic-session'), false);
  assert.equal(f.transported, false);
});

test('local Gemini thinking defaults match reference preparation without changing contextual instructions or signed history', async () => {
  const system = [{ type: 'text', text: 'You are OpenCode, a coding assistant.\nPreserve /public/path and opencode commands.' }];
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'public synthetic prompt' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'synthetic reasoning', providerMetadata: { offlineInference: { thoughtSignature: 'c2ln' } } },
      { type: 'text', text: 'synthetic answer' },
    ] },
    { role: 'user', content: [{ type: 'text', text: 'continue the public fixture' }] },
  ];
  for (const [id, localIdentity, budget] of [
    ['gemini-3.8-flash-low', true, 1000],
    ['gemini-3.8-flash-medium', true, 10001],
    ['gemini-3.8-flash-high', true, 10001],
    ['gemini-3.8-flash', true, 10001],
    ['gemini-3.8-flash-low', false, undefined],
    ['gemini-image', true, undefined],
    ['claude-sonnet-4-6', true, undefined],
  ]) {
    const model = createOfflineModel({ provider: 'synthetic-provider', model: id, requestId: 'synthetic-request',
      textSemantics: 'delta', usageSemantics: 'single-report', localIdentity,
      transport: async function* () { assert.fail('fixture must not use network'); },
    });
    const lowered = await Effect.runPromise(model.route.body.from({
      model, system, messages, tools: [], temperature: 0.25, maxTokens: 2048,
    }));
    assert.deepEqual(lowered.input.generationConfig, {
      temperature: 0.25, maxOutputTokens: 2048,
      ...(budget === undefined ? {} : { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } }),
    });
    assert.deepEqual(lowered.input.systemInstruction, { parts: system.map(({ text }) => ({ text })) });
    assert.deepEqual(lowered.input.contents, [
      { role: 'user', parts: [{ text: messages[0].content[0].text }] },
      { role: 'model', parts: [
        { text: 'synthetic reasoning', thought: true, thoughtSignature: 'c2ln' },
        { text: 'synthetic answer' },
      ] },
      { role: 'user', parts: [{ text: messages[2].content[0].text }] },
    ]);
  }
});

test('native session affinity is a validated local-only hint, not a Google cache request', async () => {
  const f = fixture();
  const result = await f.lower({ promptCacheKey: 'synthetic-affinity' });
  assert.equal(JSON.stringify(result).includes('synthetic-affinity'), false);
  for (const promptCacheKey of ['', null, 1, {}, 'synthetic\r\nsecret', 'x'.repeat(513)]) {
    await assert.rejects(f.lower({ promptCacheKey }));
  }
  await assert.rejects(f.lower({ promptCacheKey: 'synthetic', cache: { ttl: '5m' } }));
});

test('host message IDs are validated locally without altering service history or tool IDs', async () => {
  const f = fixture();
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'synthetic' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'probe', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'call-1', name: 'probe', result: { type: 'json', value: {} } }] },
  ];
  const withIDs = messages.map((message, i) => ({ ...message, id: `synthetic-local-message-${i}` }));
  const expected = await f.lower({ messages });
  const actual = await f.lower({ messages: withIDs });
  assert.deepEqual(actual.input, expected.input);
  assert.equal(JSON.stringify(actual).includes('synthetic-local-message'), false);
  assert.equal(actual.input.contents[1].parts[0].functionCall.id, 'call-1');
  assert.equal(actual.input.contents[2].parts[0].functionResponse.id, 'call-1');
  for (const id of ['', null, 1, {}, 'has space', 'x\r\nsecret', 'x'.repeat(513)]) {
    await assert.rejects(f.lower({ messages: [{ ...messages[0], id }] }));
  }
  for (const extra of [{ metadata: { secret: true } }, { native: {} }, { providerMetadata: {} }, { unknown: true }]) {
    await assert.rejects(f.lower({ messages: [{ ...withIDs[0], ...extra }] }));
  }
  let reads = 0;
  await assert.rejects(f.lower({ messages: [{ ...messages[0], get id() { reads++; return 'secret'; } }] }));
  const inherited = Object.assign(Object.create({ get id() { reads++; return 'synthetic-inherited-id'; } }), messages[0]);
  const inheritedResult = await f.lower({ messages: [inherited] });
  assert.deepEqual(inheritedResult.input, (await f.lower({ messages: [messages[0]] })).input);
  assert.equal(reads, 0);
});

test('host system instruction annotations are local-only and must match the rendered text', async () => {
  const f = fixture();
  const instructions = [{ key: 'synthetic-one', text: 'First instruction.' }, { key: 'synthetic-two', text: 'Second instruction.' }];
  const text = instructions.map(entry => entry.text).join('\n\n');
  const plain = { type: 'text', text };
  const annotated = { ...plain, metadata: { experimental: { instructions } } };
  const expected = await f.lower({ system: [plain] });
  const actual = await f.lower({ system: [annotated] });
  assert.deepEqual(actual.input, expected.input);
  assert.equal(JSON.stringify(actual).includes('synthetic-one'), false);
  assert.deepEqual(actual.input.systemInstruction.parts, [{ text }]);
  for (const metadata of [{}, { unknown: true }, { experimental: {} },
    { experimental: { instructions, unknown: true } }, { experimental: { instructions: [{ key: 'x', text: 'different instruction' }] } },
    { experimental: { instructions: [{ key: 'x', text, unknown: true }] } },
    { experimental: { instructions: new Array(257).fill({ key: 'x', text: '' }) } },
    { experimental: { instructions: [{ key: 'x', text: 'x'.repeat(1_048_577) }] } }]) {
    await assert.rejects(f.lower({ system: [{ ...plain, metadata }] }));
  }
  await assert.rejects(f.lower({ messages: [{ role: 'user', content: [annotated] }] }));
  await assert.rejects(f.lower({ system: [{ ...annotated, cache: { ttl: '5m' } }] }));
  await assert.rejects(f.lower({ system: [{ ...annotated, providerMetadata: {} }] }));
  let reads = 0;
  for (const metadata of [{ get experimental() { reads++; return {}; } },
    { experimental: { get instructions() { reads++; return instructions; } } },
    { experimental: { instructions: [{ key: 'x', get text() { reads++; return text; } }] } },
    Object.create({ get experimental() { reads++; return { instructions }; } }),
    { experimental: { instructions: Object.defineProperty([], '0', { get() { reads++; return instructions[0]; } }) } }]) {
    await assert.rejects(f.lower({ system: [{ ...plain, metadata }] }));
  }
  assert.equal(reads, 0);
});

test('host local-tool execution flags preserve history and cannot enable provider execution', async () => {
  const f = fixture();
  const call = { type: 'tool-call', id: 'call-1', name: 'probe', input: {} };
  const result = { type: 'tool-result', id: 'call-1', name: 'probe', result: { type: 'text', value: 'marker.txt' } };
  const messages = (c, r) => [{ role: 'assistant', content: [c] }, { role: 'tool', content: [r] }];
  const expected = await f.lower({ messages: messages(call, result) });
  const actual = await f.lower({ messages: messages({ ...call, providerExecuted: false }, { ...result, providerExecuted: false }) });
  assert.deepEqual(actual.input, expected.input);
  assert.equal(JSON.stringify(actual).includes('providerExecuted'), false);
  for (const providerExecuted of [true, null, 0, 'false', {}]) {
    await assert.rejects(f.lower({ messages: messages({ ...call, providerExecuted }, result) }));
    await assert.rejects(f.lower({ messages: messages(call, { ...result, providerExecuted }) }));
  }
  let reads = 0;
  await assert.rejects(f.lower({ messages: messages({ ...call, get providerExecuted() { reads++; return false; } }, result) }));
  await assert.rejects(f.lower({ messages: messages(call, { ...result, get providerExecuted() { reads++; return false; } }) }));
  const inherited = Object.assign(Object.create({ get providerExecuted() { reads++; return true; } }), call);
  assert.deepEqual((await f.lower({ messages: messages(inherited, result) })).input, expected.input);
  assert.equal(reads, 0);
});

test('full-session context headers are validated and never forwarded to Google', async () => {
  const f = fixture();
  const headers = { 'x-opencode-session': 'synthetic-affinity', 'x-opencode-session-id': 'synthetic-session',
    'x-opencode-parent-session-id': 'synthetic-parent', 'x-session-affinity': 'synthetic-affinity',
    'X-Session-Id': 'synthetic-affinity', 'x-parent-session-id': 'synthetic-parent', 'User-Agent': 'Synthetic Host/1.0',
    'x-opencode-project': 'synthetic-project', 'x-opencode-client': 'synthetic-client' };
  const result = await f.lower({ headers, promptCacheKey: 'synthetic-affinity' });
  assert.equal(/synthetic-(?:affinity|session|parent|project|client)|Synthetic Host/.test(JSON.stringify(result)), false);
  for (const extra of [{ Authorization: 'secret' }, { Cookie: 'secret' }, { 'x-unknown': 'secret' },
    { 'x-opencode-client': 'x\r\nsecret' }, { 'User-Agent': '' }, { 'X-OpenCode-Session': 'duplicate' },
    { 'x-opencode-project': 'x'.repeat(513) }, { 'x-parent-session-id': 1 }]) {
    await assert.rejects(f.lower({ headers: { ...headers, ...extra } }));
  }
  let reads = 0;
  await assert.rejects(f.lower({ headers: { ...headers, get 'User-Agent'() { reads++; return 'secret'; } } }));
  await assert.rejects(Effect.runPromise(f.model.route.body.from({ ...f.request, get promptCacheKey() { reads++; return 'secret'; } })));
  assert.equal(reads, 0);
});

test('input diagnostics identify only fixed boundary stages, never values or unknown field names', async () => {
  const f = fixture();
  for (const [patch, stage] of [
    [{ 'synthetic-secret': 12345 }, 'input_root'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, 'synthetic-secret': true }] }, 'input_tools'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, get outputSchema() { throw Error('synthetic-secret'); } }] }, 'input_tools_schema'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, metadata: { secret: true } }] }, 'input_tools_metadata'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, native: { secret: true } }] }, 'input_tools_native'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, freeform: { type: 'text' } }] }, 'input_tools_freeform'],
    [{ tools: [{ name: 'probe', description: '', inputSchema: { type: 'object' }, cache: { ttl: '5m' } }] }, 'input_tools_cache'],
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic-secret', cache: 'unsupported' }] }] }, 'input_part_cache'],
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic-secret', metadata: {} }] }] }, 'input_part_metadata'],
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic-secret', providerMetadata: {} }] }] }, 'input_part_provider_metadata'],
    [{ messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic-secret', unknown: true }] }] }, 'input_part'],
    [{ generation: { 'synthetic-secret': true } }, 'input_generation'],
  ]) {
    await assert.rejects(f.lower(patch), error => error.message.includes(`offline_stage=${stage}`) && !/synthetic-secret|12345/.test(error.message));
  }
});

test('native tool output schemas map to bounded response JSON schemas without dropping constraints', async () => {
  const f = fixture();
  const schema = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'], additionalProperties: false };
  const declaration = { type: 'tool', name: 'probe', description: 'synthetic', inputSchema: { type: 'object' }, outputSchema: schema };
  const lowered = await f.lower({ tools: [declaration] });
  const envelope = { anyOf: [
    { type: 'object', properties: { result: schema }, required: ['result'], additionalProperties: false },
    { type: 'object', properties: { error: {} }, required: ['error'], additionalProperties: false },
  ] };
  assert.deepEqual(lowered.input.tools[0].responseJsonSchema, envelope);
  const { buildInferenceRequest } = await import('../dist/offline-inference.js');
  assert.deepEqual(JSON.parse(buildInferenceRequest(lowered.input)).request.tools[0].functionDeclarations[0].responseJsonSchema, envelope);
  let reads = 0;
  for (const outputSchema of [null, [], 'secret', true, { get type() { reads++; return 'secret'; } }, { type: 'object', description: 'x'.repeat(8_388_609) }]) {
    await assert.rejects(f.lower({ tools: [{ ...declaration, outputSchema }] }));
  }
  assert.equal(reads, 0);
});

test('tool output schema references fail rather than changing scope when enveloped', async () => {
  const f = fixture();
  for (const outputSchema of [{ $ref: '#/$defs/files', $defs: { files: { type: 'array' } } },
    { type: 'object', properties: { next: { $ref: '#' } } }, { $id: 'urn:synthetic', type: 'object' },
    { $anchor: 'synthetic', type: 'object' }, { $dynamicRef: '#synthetic' }, { $recursiveRef: '#' }]) {
    await assert.rejects(f.lower({ tools: [{ type: 'tool', name: 'probe', description: '', inputSchema: { type: 'object' }, outputSchema }] }));
  }
});

test('native host generation options map to the same service fields as SDK generation', async () => {
  const f = fixture();
  const options = { temperature: 0, topP: 0.5, maxTokens: 16, stop: ['END'] };
  const native = await f.lower({ ...options, headers: { 'x-opencode-session': 'synthetic-session' } });
  const sdk = await f.lower({ generation: options });
  assert.deepEqual(native.input, sdk.input);
  assert.deepEqual(native.input.generationConfig, { temperature: 0, topP: 0.5, maxOutputTokens: 16, stopSequences: ['END'] });
});

test('native compatibility does not permit credential headers, malformed metadata or ambiguous options', async () => {
  const f = fixture();
  for (const patch of [
    { headers: { Authorization: 'synthetic-secret' } },
    { headers: {} },
    { headers: { 'x-opencode-session': 'synthetic\nsession' } },
    { headers: { 'x-opencode-session': 4 } },
    { headers: { get 'x-opencode-session'() { throw Error('synthetic-secret'); } } },
    { temperature: 1, generation: { temperature: 0 } },
    { topK: 4 },
  ]) {
    await assert.rejects(f.lower(patch), error => !error.message.includes('synthetic-secret'));
  }
  assert.equal(f.transported, false);
});

test('mixed native and SDK options do not evaluate generation accessors', async () => {
  const f = fixture();
  let reads = 0;
  await assert.rejects(f.lower({ maxTokens: 4, generation: { get temperature() { reads++; return 0; } } }));
  assert.equal(reads, 0);
});

test('native timeout is snapshotted as transport policy, never serialized for Google', async () => {
  const f = fixture();
  const timeout = { headers: 300000, chunk: 900000 };
  const lowered = await f.lower({ timeout });
  assert.deepEqual(lowered.timeout, timeout);
  timeout.chunk = 1;
  assert.equal(lowered.timeout.chunk, 900000);
  assert.equal(JSON.stringify(lowered.input).includes('timeout'), false);
  assert.deepEqual((await f.lower({ timeout: 0 })).timeout, { total: 0 });
  assert.deepEqual((await f.lower({ timeout: false })).timeout, { total: false });
  assert.deepEqual((await f.lower({ timeout: { total: false, headers: false, chunk: 0 } })).timeout,
    { total: false, headers: false, chunk: 0 });
});

test('invalid timeouts and timeout accessors fail without side effects', async () => {
  const f = fixture();
  let reads = 0;
  for (const timeout of [true, null, -1, NaN, Infinity, { total: -1 }, { chunk: '10' }, { request: 1 },
    { get headers() { reads++; return 1; } }]) {
    await assert.rejects(f.lower({ timeout }));
  }
  assert.equal(reads, 0);
  assert.equal(f.transported, false);
});

test('stream errors preserve a fixed diagnostic code without leaking remote response data', async () => {
  const model = createOfflineModel({ provider: 'synthetic-provider', model: 'synthetic-model', requestId: 'synthetic-request',
    textSemantics: 'delta', usageSemantics: 'single-report', transport: async function* () {
      yield new TextEncoder().encode('data: {"error":{"message":"synthetic-secret"}}\n\n');
    },
  });
  const lowered = await Effect.runPromise(model.route.body.from({ model, system: [], tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));
  await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const response = yield* model.route.transport.execute(lowered);
    return yield* Stream.runCollect(response.frames);
  }))), error => error.message.includes('offline_code=remote') && error.message.includes('offline_stage=response') && !error.message.includes('synthetic-secret'));
});

test('stream diagnostics distinguish framing from validated but unsupported native parts', async () => {
  for (const [frame, stage] of [
    ['event: synthetic-secret\n\n', 'framing'],
    [`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionResponse: { name: 'synthetic-secret', response: {} } }] }, finishReason: 'STOP' }] } })}\n\n`, 'native_output'],
  ]) {
    const model = createOfflineModel({ provider: 'synthetic-provider', model: 'synthetic-model', requestId: 'synthetic-request',
      textSemantics: 'delta', usageSemantics: 'single-report', transport: async function* () { yield new TextEncoder().encode(frame); },
    });
    const lowered = await Effect.runPromise(model.route.body.from({ model, system: [], tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));
    await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const response = yield* model.route.transport.execute(lowered);
      return yield* Stream.runCollect(response.frames);
    }))), error => error.message.includes(`offline_stage=${stage}`) && !error.message.includes('synthetic-secret'));
  }
});

test('a repeated usage report is identified without exposing usage values or stream content', async () => {
  const model = createOfflineModel({ provider: 'synthetic-provider', model: 'synthetic-model', requestId: 'synthetic-request',
    textSemantics: 'delta', usageSemantics: 'single-report', transport: async function* () {
      for (const response of [
        { candidates: [{ content: { parts: [{ text: 'synthetic-secret' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 12345 } },
        { usageMetadata: { totalTokenCount: 12345 } },
      ]) yield new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
    },
  });
  const lowered = await Effect.runPromise(model.route.body.from({ model, system: [], tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] }));
  await assert.rejects(Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const response = yield* model.route.transport.execute(lowered);
    return yield* Stream.runCollect(response.frames);
  }))), error => error.message.includes('offline_stage=native_usage') && !/synthetic-secret|12345/.test(error.message));
});
