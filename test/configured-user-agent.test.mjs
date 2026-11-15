import assert from 'node:assert/strict';
import os from 'node:os';
import { test } from 'node:test';
import { make } from '@opencode/ai';
import { model, registerConfiguredRuntime } from '../dist/configured-driver.js';
import { createCatalogClient } from '../dist/configured-catalog.js';
import { fetchQuotaSummary } from '../dist/configured-quota.js';
import { localCliUserAgent } from '../dist/configured-user-agent.js';

const configuration = { providerId: 'fixture', inference: { endpoint: 'https://inference.example/stream', project: 'project', textSemantics: 'delta', usageSemantics: 'single-report' }, models: [{ id: 'fixture-model', enabled: true }] };

async function infer(mode, onFetch = () => {}) {
  const calls = [];
  const runtime = registerConfiguredRuntime({
    config: mode === 'manual' ? configuration : { mode, oauth: {} },
    ...(mode === 'manual' ? {} : { configuration: () => configuration }),
    credential: async () => ({ access: 'fixture-access' }),
    fetch: async (url, init) => {
      onFetch();
      calls.push({ url, init });
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } })}\n\n`);
    },
    signal: new AbortController().signal,
  });
  try {
    await make().generate({ model: model('fixture-model', { configuredRuntime: runtime.id, configuredConnection: 'fixture' }), prompt: 'fixture' });
    return calls[0].init;
  } finally { runtime.dispose(); }
}

test('local OAuth inference uses CLI 1.5.8 without changing quota, catalog or other headers', async () => {
  const previous = process.env.OPENCODE_AGY_CLI_VERSION;
  delete process.env.OPENCODE_AGY_CLI_VERSION;
  try {
    const init = await infer('agy-local-oauth');
    const platform = os.platform() === 'win32' ? 'windows' : os.platform();
    const arch = os.arch() === 'x64' ? 'amd64' : os.arch();
    assert.deepEqual(init.headers, { Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': `antigravity/cli/1.5.8 ${platform}/${arch}` });
    const calls = [];
    const fetcher = async (url, request) => {
      calls.push({ url, request });
      return Response.json(url.endsWith(':loadCodeAssist')
        ? { cloudaicompanionProject: 'fixture-project' }
        : url.endsWith(':fetchAvailableModels')
          ? { models: { 'fixture-model': { displayName: 'Fixture', maxTokens: 8192, maxOutputTokens: 2048 } } }
          : { buckets: [] });
    };
    const signal = new AbortController().signal;
    await createCatalogClient(fetcher, signal).discover('fixture-access', async () => {});
    await fetchQuotaSummary(fetcher, 'fixture-access', 'fixture-project', signal);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), [
      '/v1internal:loadCodeAssist', '/v1internal:fetchAvailableModels', '/v1internal:retrieveUserQuotaSummary',
    ]);
    for (const { request } of calls) {
      assert.deepEqual(request.headers, { Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `antigravity/cli/1.4.11 ${platform}/${arch}` });
    }
  } finally { if (previous === undefined) delete process.env.OPENCODE_AGY_CLI_VERSION; else process.env.OPENCODE_AGY_CLI_VERSION = previous; }
});

test('local OAuth inference honors the reference CLI version override', async () => {
  const previous = process.env.OPENCODE_AGY_CLI_VERSION;
  process.env.OPENCODE_AGY_CLI_VERSION = ' 2.3.4 ';
  try { assert.match((await infer('agy-local-oauth')).headers['User-Agent'], /^antigravity\/cli\/2\.3\.4 /); }
  finally { if (previous === undefined) delete process.env.OPENCODE_AGY_CLI_VERSION; else process.env.OPENCODE_AGY_CLI_VERSION = previous; }
});

test('blank CLI version overrides retain distinct inference and shared defaults', async () => {
  const previous = process.env.OPENCODE_AGY_CLI_VERSION;
  try {
    for (const version of ['', '   ']) {
      process.env.OPENCODE_AGY_CLI_VERSION = version;
      assert.match((await infer('agy-local-oauth')).headers['User-Agent'], /^antigravity\/cli\/1\.5\.8 /);
      assert.match(localCliUserAgent(), /^antigravity\/cli\/1\.4\.11 /);
    }
  } finally { if (previous === undefined) delete process.env.OPENCODE_AGY_CLI_VERSION; else process.env.OPENCODE_AGY_CLI_VERSION = previous; }
});

test('manual and public configurations do not receive the local CLI user agent', async () => {
  for (const mode of ['manual', 'agy-public-oauth']) {
    const init = await infer(mode);
    assert.deepEqual(init.headers, { Authorization: 'Bearer fixture-access', 'Content-Type': 'application/json', Accept: 'text/event-stream' });
  }
});

test('only local OAuth inference includes the agent request identity in its JSON wrapper', async () => {
  const local = JSON.parse((await infer('agy-local-oauth')).body);
  assert.equal(local.userAgent, 'antigravity');
  assert.equal(local.requestType, 'agent');
  for (const mode of ['manual', 'agy-public-oauth']) {
    const body = JSON.parse((await infer(mode)).body);
    assert.equal(Object.hasOwn(body, 'userAgent'), false);
    assert.equal(Object.hasOwn(body, 'requestType'), false);
  }
});

test('unsafe or oversized CLI version overrides are rejected before HTTP dispatch', async () => {
  const previous = process.env.OPENCODE_AGY_CLI_VERSION;
  try {
    for (const version of ['1.2\r\nInjected: value', '1.2\n', '1.2\u0001', 'x'.repeat(257)]) {
      process.env.OPENCODE_AGY_CLI_VERSION = version;
      let calls = 0;
      await assert.rejects(infer('agy-local-oauth', () => { calls++; }));
      assert.equal(calls, 0);
    }
  } finally { if (previous === undefined) delete process.env.OPENCODE_AGY_CLI_VERSION; else process.env.OPENCODE_AGY_CLI_VERSION = previous; }
});
