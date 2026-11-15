import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHTTP } from '../dist/configured-security.js';

const endpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const collect = async iterable => {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
};
const transient = status => new Response('{}', { status,
  headers: { 'Content-Type': 'application/json', 'retry-after-ms': '0' },
});

test('local inference retries transient HTTP failures before streaming with identical request identity', async () => {
  for (const status of [429, 503]) {
    const requests = [];
    const http = createHTTP(async (url, init) => {
      requests.push({ url, body: init.body, headers: init.headers });
      return requests.length < 3 ? transient(status) : new Response('synthetic stream');
    });
    assert.equal(await collect(http.stream(endpoint, '{"requestId":"synthetic-stable-id"}',
      'SYNTHETIC_ACCESS', new AbortController().signal, true)), 'synthetic stream');
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1], requests[0]);
    assert.deepEqual(requests[2], requests[0]);
  }
});

test('local inference bounds retry attempts and never retries known terminal or nonlocal errors', async () => {
  for (const [status, reason, local, expected] of [
    [429, undefined, true, 3],
    [429, 'RATE_LIMIT_EXCEEDED', true, 3],
    [429, 'QUOTA_EXHAUSTED', true, 1],
    [429, 'MODEL_CAPACITY_EXHAUSTED', true, 1],
    [400, undefined, true, 1],
    [401, undefined, true, 1],
    [403, undefined, true, 1],
    [429, undefined, false, 1],
    [503, undefined, false, 1],
  ]) {
    let attempts = 0;
    const http = createHTTP(async () => {
      attempts++;
      return reason ? Response.json({ error: { details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason,
      }] } }, { status, headers: { 'retry-after-ms': '0' } }) : transient(status);
    });
    await assert.rejects(collect(http.stream(endpoint, '{}', 'SYNTHETIC_ACCESS', new AbortController().signal, local)));
    assert.equal(attempts, expected, `${status}/${reason}/${local}`);
  }
});

test('retry waits respect request cancellation and never reopen an accepted stream', async () => {
  let attempts = 0;
  const http = createHTTP(async () => {
    attempts++;
    return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'retry-after': '30' } });
  });
  await assert.rejects(collect(http.stream(endpoint, '{}', 'SYNTHETIC_ACCESS', new AbortController().signal, true, { total: 20 })));
  assert.equal(attempts, 1);

  let accepted = 0;
  const broken = createHTTP(async () => {
    accepted++;
    return new Response(new ReadableStream({ start(controller) { controller.error(Error('synthetic stream failure')); } }));
  });
  await assert.rejects(collect(broken.stream(endpoint, '{}', 'SYNTHETIC_ACCESS', new AbortController().signal, true)));
  assert.equal(accepted, 1);
});

test('retry delay headers preserve precedence, parse seconds and dates, and refuse waits over thirty seconds', async t => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const nativeSetTimeout = globalThis.setTimeout;
  for (const [label, headers, expected] of [
    ['milliseconds precede seconds', { 'retry-after-ms': '12', 'retry-after': '30' }, 12],
    ['fractional seconds', { 'retry-after': '0.125' }, 125],
    ['HTTP date', { 'retry-after': 'Sun, 15 Nov 2026 12:00:02 GMT' }, 2000],
    ['past HTTP date', { 'retry-after': 'Sun, 15 Nov 2026 11:59:58 GMT' }, 0],
    ['invalid milliseconds allow seconds', { 'retry-after-ms': 'invalid', 'retry-after': '2' }, 2000],
    ['malformed headers use backoff', { 'retry-after-ms': '-1', 'retry-after': 'invalid' }, 5000],
    ['thirty second boundary', { 'retry-after-ms': '30000' }, 30000],
    ['too long milliseconds', { 'retry-after-ms': '30001' }, undefined],
    ['too long seconds', { 'retry-after': '31' }, undefined],
  ]) {
    await t.test(label, async t => {
      const waits = [];
      t.mock.method(Date, 'now', () => now);
      t.mock.method(Math, 'random', () => 0.5);
      t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        waits.push(delay);
        return nativeSetTimeout(callback, 0, ...args);
      });
      let attempts = 0;
      const http = createHTTP(async () => ++attempts === 1
        ? new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', ...headers } })
        : new Response('accepted'));
      const result = collect(http.stream(endpoint, '{}', 'SYNTHETIC_ACCESS', new AbortController().signal,
        true, { total: false, headers: false, chunk: false }));
      if (expected === undefined) {
        await assert.rejects(result);
        assert.equal(attempts, 1);
        assert.deepEqual(waits, [1000]);
      } else {
        assert.equal(await result, 'accepted');
        assert.equal(attempts, 2);
        assert.deepEqual(waits, [1000, expected]);
      }
    });
  }
});

test('caller abort and headers deadline interrupt backoff without another fetch', async () => {
  for (const callerAborts of [true, false]) {
    const controller = new AbortController();
    let attempts = 0;
    const http = createHTTP(async () => {
      attempts++;
      return new Response('{}', { status: 503, headers: { 'retry-after': '30' } });
    });
    const timer = callerAborts ? setTimeout(() => controller.abort(), 20) : undefined;
    try {
      await assert.rejects(collect(http.stream(endpoint, '{}', 'SYNTHETIC_ACCESS', controller.signal,
        true, { total: false, headers: callerAborts ? false : 20 })));
      assert.equal(attempts, 1);
    } finally { clearTimeout(timer); }
  }
});
