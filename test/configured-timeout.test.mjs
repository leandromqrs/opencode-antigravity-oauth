import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHTTP } from '../dist/configured-security.js';
import { inferOffline } from '../dist/offline-inference.js';
import { model, registerConfiguredRuntime } from '../dist/configured-driver.js';
import { Effect, Stream } from 'effect';

const url = 'https://inference.example/stream';
const input = { model: 'synthetic-model', requestId: 'synthetic-request', contents: [{ role: 'user', parts: [{ text: 'x' }] }] };
const bytes = text => new TextEncoder().encode(text);
const collect = async iterable => { const result = []; for await (const chunk of iterable) result.push(chunk); return result; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('headers timeout aborts even a fetcher that ignores its signal and cancels its late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, signal, cancelled = false;
  const http = createHTTP(async (_url, init) => { signal = init.signal; return new Promise(r => { resolve = r; }); });
  const operation = collect(http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { headers: 5 }));
  const failure = assert.rejects(operation, /Configured OAuth integration/);
  await flush();
  t.mock.timers.tick(5);
  assert.equal(signal.aborted, true);
  await failure;
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await flush();
  assert.equal(cancelled, true);
});

test('chunk deadline resets on raw bytes before a complete SSE frame exists', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body, cancelled = false;
  const http = createHTTP(async () => new Response(new ReadableStream({ start(c) { body = c; }, cancel() { cancelled = true; } })));
  const iterator = http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { headers: 1, chunk: 10 });
  let pending = iterator.next();
  await flush();
  t.mock.timers.tick(8);
  body.enqueue(bytes('da'));
  assert.equal(new TextDecoder().decode((await pending).value), 'da');
  pending = iterator.next();
  await flush();
  t.mock.timers.tick(8);
  body.enqueue(bytes('ta: '));
  assert.equal(new TextDecoder().decode((await pending).value), 'ta: ');
  pending = iterator.next();
  const failure = assert.rejects(pending, /Configured OAuth integration/);
  await flush();
  t.mock.timers.tick(10);
  await failure;
  assert.equal(cancelled, true);
});

test('total deadline includes all reads and is not reset by chunks', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let body;
  const http = createHTTP(async () => new Response(new ReadableStream({ start(c) { body = c; } })));
  const iterator = http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { total: 12, chunk: 10 });
  const first = iterator.next();
  await flush();
  t.mock.timers.tick(8); body.enqueue(bytes('x')); await first;
  const failure = assert.rejects(iterator.next());
  await flush(); t.mock.timers.tick(4); await failure;
});

test('false disables deadlines, but explicit cancellation still stops the stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const controller = new AbortController();
  const http = createHTTP(async (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const failure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', controller.signal, false,
    { total: false, headers: false, chunk: false })));
  await flush(); t.mock.timers.tick(1000000); await flush();
  assert.equal(signal.aborted, false);
  controller.abort(); await failure;
});

test('zero is a deadline, not a disabled timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const http = createHTTP(async () => new Promise(() => {}));
  const failure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { headers: 0 })));
  await flush(); t.mock.timers.tick(0); await failure;
});

test('request total timeout reaches a hanging injected transport and cleans up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let options, signal;
  const failure = assert.rejects(collect(inferOffline(input, (_body, s, o) => {
    options = o; signal = s;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  }, { timeout: { total: 5, headers: 30, chunk: false } })));
  await flush(); t.mock.timers.tick(5);
  assert.equal(signal.aborted, true);
  await failure;
  assert.deepEqual(options.timeout, { total: 5, headers: 30, chunk: false });
});

test('the configured native route preserves request timeout through the driver to HTTP', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const runtime = registerConfiguredRuntime({ config: {
    providerId: 'synthetic-provider', models: [{ id: 'synthetic-model', enabled: true }],
    inference: { endpoint: url, project: 'synthetic-project', textSemantics: 'delta', usageSemantics: 'single-report' },
  }, signal: new AbortController().signal,
  credential: async () => ({ access: 'synthetic-access' }),
  fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}); } });
  try {
    const native = model('synthetic-model', { configuredRuntime: runtime.id, configuredConnection: 'synthetic-account' });
    const lowered = await Effect.runPromise(native.route.body.from({ model: native, system: [], tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }], timeout: { headers: 5, chunk: 900000 } }));
    const operation = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const response = yield* native.route.transport.execute(lowered);
      return yield* Stream.runCollect(response.frames);
    })));
    const failure = assert.rejects(operation);
    await flush(); t.mock.timers.tick(5); await failure;
    assert.equal(signal.aborted, true);
  } finally { runtime.dispose(); }
});

test('native headers and chunk policy replaces the legacy 120-second total cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const controller = new AbortController();
  const http = createHTTP(async (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const failure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', controller.signal, false,
    { headers: 300000, chunk: 900000 })));
  await flush(); t.mock.timers.tick(120001); await flush();
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(179999); assert.equal(signal.aborted, true); await failure;
});

test('concurrent requests do not share timeout configuration or cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  const http = createHTTP(async (_url, init) => { signals.push(init.signal); return new Promise(() => {}); });
  const second = new AbortController();
  const firstFailure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { headers: 5 })));
  const secondFailure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', second.signal, false, { headers: false })));
  await flush(); t.mock.timers.tick(5); await firstFailure;
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  second.abort(); await secondFailure;
});

test('completion clears timeout timers rather than leaking a delayed abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abort = t.mock.method(AbortController.prototype, 'abort');
  const http = createHTTP(async () => new Response(bytes('synthetic')));
  await collect(http.stream(url, '{}', 'synthetic-access', new AbortController().signal, false, { headers: 5, chunk: 10, total: 20 }));
  const completedAborts = abort.mock.callCount();
  t.mock.timers.tick(2000000);
  assert.equal(abort.mock.callCount(), completedAborts);
});

test('large deadlines are not clamped to a one-millisecond timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const controller = new AbortController();
  const http = createHTTP(async (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const failure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', controller.signal, false, { headers: 2_147_483_650 })));
  await flush(); t.mock.timers.tick(100); await flush(); assert.equal(signal.aborted, false);
  controller.abort(); await failure;
});

test('an explicitly empty timeout policy does not reactivate the legacy total cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const controller = new AbortController();
  const http = createHTTP(async (_url, init) => { signal = init.signal; return new Promise(() => {}); });
  const failure = assert.rejects(collect(http.stream(url, '{}', 'synthetic-access', controller.signal, false, {})));
  await flush(); t.mock.timers.tick(120001); await flush();
  assert.equal(signal.aborted, false);
  controller.abort(); await failure;
});
