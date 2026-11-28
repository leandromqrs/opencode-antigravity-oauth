import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHTTP } from '../dist/configured-security.js';
import { createOfflineModel } from '../dist/offline-opencode.js';
import { make } from '@opencode/ai';

const endpoint = 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse';
const encoder = new TextEncoder();
async function inferenceFailure(response, signal = new AbortController().signal) {
  const http = createHTTP(async () => response);
  const model = createOfflineModel({
    provider: 'synthetic', model: 'synthetic', requestId: 'synthetic',
    textSemantics: 'delta', usageSemantics: 'single-report',
    transport: (body, requestSignal) => http.stream(endpoint, body, 'PRIVATE_ACCESS', AbortSignal.any([signal, requestSignal])),
  });
  try {
    await make().generate({ model, prompt: 'synthetic' });
    assert.fail('expected inference error');
  } catch (error) {
    assert.doesNotMatch(error.message, /PRIVATE/);
    return error;
  }
}
async function failure(response, signal) {
  return (await inferenceFailure(response, signal)).message;
}

test('only explicit quota exhaustion becomes a quota error', async () => {
  for (const [reason, expected] of [
    ['QUOTA_EXHAUSTED', 'QuotaExceeded'],
    ['MODEL_CAPACITY_EXHAUSTED', 'InvalidProviderOutput'],
    ['RATE_LIMIT_EXCEEDED', 'InvalidProviderOutput'],
    ['UNRECOGNIZED', 'InvalidProviderOutput'],
  ]) {
    const error = await inferenceFailure(Response.json({ error: { details: [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason,
    }] } }, { status: 429 }));
    assert.equal(error.reason?._tag, expected);
    if (reason === 'QUOTA_EXHAUSTED') assert.match(error.message, /quota exhausted/i);
  }
  const generic = await inferenceFailure(Response.json({ error: { message: 'PRIVATE' } }, { status: 429 }));
  assert.equal(generic.reason?._tag, 'InvalidProviderOutput');
});

test('inference 429 reports only recognized Google ErrorInfo reasons', async () => {
  for (const [reason, stage] of [
    ['MODEL_CAPACITY_EXHAUSTED', 'http_429_capacity'],
    ['QUOTA_EXHAUSTED', 'http_429_quota'],
    ['RATE_LIMIT_EXCEEDED', 'http_429_rate'],
    ['PRIVATE_UNKNOWN', 'http_429'],
  ]) {
    const message = await failure(Response.json({ error: {
      message: 'PRIVATE_MESSAGE', details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: { private: 'PRIVATE_METADATA' },
      }],
    } }, { status: 429, statusText: 'PRIVATE_STATUS' }));
    assert.match(message, new RegExp(`offline_stage=${stage}\\)`));
  }
  for (const details of [
    [{ '@type': 'PRIVATE_TYPE', reason: 'QUOTA_EXHAUSTED' }],
    [{ reason: 'QUOTA_EXHAUSTED' }],
    [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'QUOTA_EXHAUSTED' },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED' }],
  ]) {
    assert.match(await failure(Response.json({ error: { details } }, { status: 429 })), /offline_stage=http_429\)/);
  }
});

test('inference 429 recognizes JSON and single SSE error envelopes under the SSE content type', async () => {
  const body = JSON.stringify({ error: { message: 'PRIVATE', details: [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_CAPACITY_EXHAUSTED',
  }] } });
  for (const value of [body, `data: ${body}\n\n`, `: keepalive\r\nevent: error\r\ndata: ${body}\r\n\r\n`]) {
    assert.match(await failure(new Response(value, {
      status: 429, headers: { 'Content-Type': 'text/event-stream' },
    })), /offline_stage=http_429_capacity\)/);
  }
  for (const value of [`data: ${body}\n\ndata: ${body}\n\n`, `data:\n\ndata: ${body}\n\n`, `data\n\ndata: ${body}\n\n`]) {
    assert.match(await failure(new Response(value, {
      status: 429, headers: { 'Content-Type': 'text/event-stream' },
    })), /offline_stage=http_429\)/);
  }
});

test('inference 429 recognizes the single-element error array handled by the reference plugin', async () => {
  const error = { error: { message: 'PRIVATE_MESSAGE', details: [{
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED',
  }] } };
  for (const mime of ['application/json', 'text/event-stream']) {
    for (const payload of [JSON.stringify([error]), ...(mime === 'text/event-stream' ? [`data: ${JSON.stringify([error])}\n\n`] : [])]) {
      assert.match(await failure(new Response(payload, {
        status: 429, headers: { 'Content-Type': mime },
      })), /offline_stage=http_429_rate\)/);
    }
    assert.match(await failure(new Response(JSON.stringify([error, error]), {
      status: 429, headers: { 'Content-Type': mime },
    })), /offline_stage=http_429\)/);
  }
});

test('inference 429 diagnostic reads are bounded and always cancel the body', async () => {
  for (const value of ['PRIVATE_NOT_JSON', ' '.repeat(16385)]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(value)); },
      cancel() { cancelled = true; },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    assert.match(await failure(response), /offline_stage=http_429\)/);
    assert.equal(cancelled, true);
  }
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    status: 429, headers: { 'Content-Type': 'application/json' },
  });
  const start = Date.now();
  assert.match(await failure(response), /offline_stage=http_429\)/);
  assert.ok(Date.now() - start >= 500);
  assert.ok(Date.now() - start < 5000);
  assert.equal(cancelled, true);
});
