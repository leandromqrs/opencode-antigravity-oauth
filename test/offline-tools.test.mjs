import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make, LLMEvent, tool } from '@opencode/ai';
import { Schema } from 'effect';
import { createOfflineModel } from '../dist/offline-opencode.js';

const ai = make();
const frame = response => new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
const config = transport => ({ provider: 'synthetic', model: 'model', requestId: 'request', textSemantics: 'delta', usageSemantics: 'single-report', transport });

test('tool declarations and streamed calls retain the original tool name', async () => {
  let body;
  const model = createOfflineModel(config(async function* (request) {
    body = JSON.parse(request);
    yield frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'my_tool', args: { query: 'x' } } }] }, finishReason: 'STOP' }] });
  }));
  const events = [];
  for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'my-tool', description: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }] })) events.push(event);
  assert.equal(body.request.tools[0].functionDeclarations[0].name, 'my_tool');
  assert.deepEqual(events.find(e => e.type === 'tool-call'), { type: 'tool-call', id: 'call-1', name: 'my-tool', input: { query: 'x' } });
  assert.equal(events.at(-1).reason.normalized, 'tool-calls');
  for (const event of events) Schema.decodeUnknownSync(LLMEvent)(event);
});

test('a tool call without args has empty object input', async () => {
  const model = createOfflineModel(config(async function* () {
    yield frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call-1', name: 'ping' } }] }, finishReason: 'STOP' }] });
  }));
  const events = [];
  for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] })) events.push(event);
  assert.deepEqual(events.find(e => e.type === 'tool-call').input, {});
});

test('SDK tool output schema is preserved in the service declaration', async () => {
  let request;
  const outputSchema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] };
  const model = createOfflineModel(config(async function* (body) {
    request = JSON.parse(body);
    yield frame({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
  }));
  await ai.generate({ model, prompt: 'synthetic', tools: [{ name: 'probe', description: 'synthetic', inputSchema: { type: 'object' }, outputSchema }] });
  assert.deepEqual(request.request.tools[0].functionDeclarations[0].responseJsonSchema.anyOf[0], {
    type: 'object', properties: { result: outputSchema }, required: ['result'], additionalProperties: false,
  });
});

test('host-selected metadata namespace retains tool signatures through native history', async () => {
  const requests = [];
  const model = createOfflineModel(config(async function* (body) {
    requests.push(JSON.parse(body));
    yield frame({ candidates: [{ content: { parts: requests.length === 1
      ? [{ functionCall: { id: 'call-1', name: 'probe', args: {} }, thoughtSignature: 'c2ln' }]
      : [{ text: 'done' }] }, finishReason: 'STOP' }] });
  }));
  const tools = [{ name: 'probe', description: 'synthetic', inputSchema: { type: 'object' } }];
  const events = [];
  for await (const event of ai.stream({ model, prompt: 'synthetic', tools })) events.push(event);
  const call = events.find(event => event.type === 'tool-call');
  const key = model.route.providerMetadataKey ?? model.provider;
  const native = call.providerMetadata?.[key];
  await ai.generate({ model, tools, messages: [
    { role: 'user', content: 'synthetic' },
    { role: 'assistant', content: [{ type: 'tool-call', id: call.id, name: call.name, input: call.input,
      ...(native === undefined ? {} : { providerMetadata: { [key]: native } }) }] },
    { role: 'tool', content: [{ type: 'tool-result', id: call.id, name: call.name, result: { type: 'text', value: 'marker.txt' } }] },
  ] });
  assert.equal(requests[1].request.contents[1].parts[0].thoughtSignature, 'c2ln');
  assert.deepEqual(native, { thoughtSignature: 'c2ln' });
});

test('tool output schema round-trips the existing success and error envelopes', async () => {
  const outputSchema = { type: 'object', properties: { files: { type: 'array', items: { type: 'string', enum: ['marker.txt'] } } },
    required: ['files'], additionalProperties: false };
  for (const result of [{ type: 'json', value: { files: ['marker.txt'] } }, { type: 'error', value: 'synthetic failure' }]) {
    let request;
    const model = createOfflineModel(config(async function* (body) {
      request = JSON.parse(body);
      yield frame({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
    }));
    await ai.generate({ model, tools: [{ name: 'list-files', description: '', inputSchema: { type: 'object' }, outputSchema }], messages: [
      { role: 'user', content: 'list' },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call', name: 'list-files', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', id: 'call', name: 'list-files', result }] },
    ] });
    const schema = request.request.tools[0].functionDeclarations[0].responseJsonSchema;
    const response = request.request.contents[2].parts[0].functionResponse.response;
    const key = result.type === 'error' ? 'error' : 'result';
    assert.deepEqual(response, { [key]: result.value });
    assert.deepEqual(schema.anyOf.map(branch => branch.required), [['result'], ['error']]);
    assert.deepEqual(schema.anyOf[0].properties.result, outputSchema);
    assert.deepEqual(schema.anyOf[1].properties.error, {});
    assert.equal(schema.anyOf.every(branch => branch.additionalProperties === false), true);
    assert.equal(schema.anyOf.filter(branch => branch.required.every(field => Object.hasOwn(response, field))).length, 1);
  }
});

test('history maps tool calls, results, colliding names and thought signatures', async () => {
  let body;
  const model = createOfflineModel(config(async function* (request) {
    body = JSON.parse(request);
    yield frame({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
  }));
  const tools = ['a-b', 'a.b'].map(name => ({ name, description: 'tool', inputSchema: { type: 'object' } }));
  await ai.generate({ model, tools, messages: [
    { role: 'user', content: 'run' },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'id-1', name: 'a.b', input: {}, providerMetadata: { offlineInference: { thoughtSignature: 'YWJj' } } }] },
    { role: 'tool', content: [{ type: 'tool-result', id: 'id-1', name: 'a.b', result: { type: 'text', value: 'ok' } }] },
  ] });
  assert.deepEqual(body.request.tools[0].functionDeclarations.map(x => x.name), ['a_b', 'a_b_1']);
  assert.deepEqual(body.request.contents[1].parts[0], { functionCall: { id: 'id-1', name: 'a_b_1', args: {} }, thoughtSignature: 'YWJj' });
  assert.deepEqual(body.request.contents[2].parts[0], { functionResponse: { id: 'id-1', name: 'a_b_1', response: { result: 'ok' } } });
});

test('unregistered tool calls and duplicate identifiers fail without a finish event', async () => {
  for (const calls of [
    [{ functionCall: { id: 'x', name: 'unknown', args: {} } }],
    [{ functionCall: { id: 'x', name: 'known', args: {} } }, { functionCall: { id: 'x', name: 'known', args: {} } }],
  ]) {
    const model = createOfflineModel(config(async function* () { yield frame({ candidates: [{ content: { parts: calls }, finishReason: 'STOP' }] }); }));
    const events = [];
    await assert.rejects(async () => { for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'known', description: '', inputSchema: { type: 'object' } }] })) events.push(event); });
    assert.equal(events.some(e => e.type === 'finish'), false);
  }
});

test('tool calls are withheld until a safe terminal outcome and complete stream', async () => {
  for (const ending of ['SAFETY', 'MAX_TOKENS', undefined, 'transport-error']) {
    const model = createOfflineModel(config(async function* () {
      yield frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'known', args: {} } }] } }] });
      if (ending === 'transport-error') throw Error('failure');
      if (ending) yield frame({ candidates: [{ finishReason: ending }] });
    }));
    const events = [];
    await assert.rejects(async () => { for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'known', description: '', inputSchema: { type: 'object' } }] })) events.push(event); });
    assert.equal(events.some(event => event.type === 'tool-call'), false);
  }
});

test('identical idless calls are rejected as ambiguous, distinct calls are retained', async () => {
  for (const [args, ok] of [[[{}, {}], false], [[{ n: 1 }, { n: 2 }], true]]) {
    const model = createOfflineModel(config(async function* () { for (const value of args) yield frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'known', args: value } }] } }] }); yield frame({ candidates: [{ finishReason: 'STOP' }] }); }));
    const events = [];
    const run = async () => { for await (const event of ai.stream({ model, prompt: 'x', tools: [{ name: 'known', description: '', inputSchema: { type: 'object' } }] })) events.push(event); };
    if (ok) { await run(); assert.equal(events.filter(e => e.type === 'tool-call').length, 2); }
    else { await assert.rejects(run); assert.equal(events.some(e => e.type === 'tool-call'), false); }
  }
});

test('history alone cannot authorize a tool call', async () => {
  const model = createOfflineModel(config(async function* () { yield frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'old', args: {} } }] }, finishReason: 'STOP' }] }); }));
  const events = [];
  await assert.rejects(async () => { for await (const event of ai.stream({ model, messages: [ { role: 'assistant', content: [{ type: 'tool-call', id: 'x', name: 'old', input: {} }] }, { role: 'tool', content: [{ type: 'tool-result', id: 'x', name: 'old', result: { type: 'error', value: 'failed' } }] } ] })) events.push(event); });
  assert.equal(events.some(e => e.type === 'tool-call'), false);
});


test('SDK tool loop executes once and replays result with call signature', async () => {
  const bodies = []; let executions = 0;
  const model = createOfflineModel(config(async function* (request) {
    bodies.push(JSON.parse(request));
    if (bodies.length === 1) yield frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'call', name: 'a_b', args: { n: 1 } }, thoughtSignature: 'YWJj' }] }, finishReason: 'STOP' }] });
    else yield frame({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
  }));
  const events = [];
  for await (const event of ai.loop({ model, prompt: 'x', tools: { 'a-b': tool({ description: 'test', jsonSchema: { type: 'object' }, execute: () => { executions++; return 'ok'; } }) } })) events.push(event);
  assert.equal(executions, 1); assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].request.contents[1].parts[0], { functionCall: { id: 'call', name: 'a_b', args: { n: 1 } }, thoughtSignature: 'YWJj' });
  assert.deepEqual(bodies[1].request.contents[2].parts[0], { functionResponse: { id: 'call', name: 'a_b', response: { result: 'ok' } } });
  assert.ok(events.some(event => event.type === 'tool-result'));
});

test('local CLI identity is explicit and does not change the default envelope', async () => {
  for (const [localIdentity, expected] of [[true, true], [false, false], [undefined, false]]) {
    let body;
    const opts = config(async function* (request) { body = JSON.parse(request); yield frame({ candidates: [{ finishReason: 'STOP' }] }); });
    if (localIdentity !== undefined) opts.localIdentity = localIdentity;
    await ai.generate({ model: createOfflineModel(opts), prompt: 'x' });
    assert.equal(body.userAgent, expected ? 'antigravity' : undefined);
    assert.equal(body.requestType, expected ? 'agent' : undefined);
  }
  assert.throws(() => createOfflineModel({ ...config(async function* () {}), localIdentity: 'yes' }));
});

test('SDK tool failures are replayed as errors without losing colliding names', async () => {
  const bodies = []; let executions = 0;
  const model = createOfflineModel(config(async function* (request) {
    bodies.push(JSON.parse(request));
    if (bodies.length === 1) yield frame({ candidates: [{ content: { parts: [{ functionCall: { id: 'id', name: 'a_b_1', args: {} } }] }, finishReason: 'STOP' }] });
    else yield frame({ candidates: [{ finishReason: 'STOP' }] });
  }));
  const build = execute => tool({ description: '', jsonSchema: { type: 'object' }, execute });
  const events = [];
  for await (const event of ai.loop({ model, prompt: 'x', tools: { 'a-b': build(() => 'wrong'), 'a.b': build(() => { executions++; throw Error('failed'); }) } })) events.push(event);
  assert.equal(executions, 1);
  assert.deepEqual(bodies[1].request.contents[2].parts[0], { functionResponse: { id: 'id', name: 'a_b_1', response: { error: 'failed' } } });
  assert.ok(events.some(event => event.type === 'tool-error'));
});

test('SDK does not execute tools if a later frame blocks the response', async () => {
  let executions = 0;
  const model = createOfflineModel(config(async function* () {
    yield frame({ candidates: [{ content: { parts: [{ functionCall: { name: 'run', args: {} } }] } }] });
    yield frame({ candidates: [{ finishReason: 'SAFETY' }] });
  }));
  await assert.rejects(async () => { for await (const _event of ai.loop({ model, prompt: 'x', tools: { run: tool({ description: '', jsonSchema: { type: 'object' }, execute: () => { executions++; } }) } })) {} });
  assert.equal(executions, 0);
});

test('mixed identified and idless duplicate calls are rejected', async () => {
  for (const reverse of [false, true]) {
    const calls = [{ functionCall: { id: 'id', name: 'known', args: { x: 1 } } }, { functionCall: { name: 'known', args: { x: 1 } } }];
    if (reverse) calls.reverse();
    const model = createOfflineModel(config(async function* () { yield frame({ candidates: [{ content: { parts: calls }, finishReason: 'STOP' }] }); }));
    const events = [];
    await assert.rejects(async () => { for await (const e of ai.stream({ model, prompt: 'x', tools: [{ name: 'known', description: '', inputSchema: { type: 'object' } }] })) events.push(e); });
    assert.equal(events.some(e => e.type === 'tool-call'), false);
  }
});
