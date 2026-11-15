import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatalogClient } from '../dist/configured-catalog.js';

const models = { models: { fixture: { maxTokens: 100, maxOutputTokens: 10 } }, defaultAgentModelId: 'fixture' };
const discover = (fetcher, guard = async () => {}) => createCatalogClient(fetcher, new AbortController().signal).discover('synthetic-access', guard);

test('onboards only the service-selected free tier and uses its returned project', async () => {
  const calls = [];
  const result = await discover(async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : calls.length === 2 ? { done: true, response: { cloudaicompanionProject: { id: 'actual-project' } } } : models);
  });
  assert.equal(result.project, 'actual-project');
  assert.match(calls[1].url, /:onboardUser$/u);
  assert.deepEqual(JSON.parse(calls[1].init.body), { tierId: 'free-tier', metadata: { ideType: 9 } });
  assert.deepEqual(JSON.parse(calls[2].init.body), { project: 'actual-project' });
  assert.equal(calls[1].init.redirect, 'error');
});

test('never onboards an existing tier or synthesizes an absent tier', async () => {
  for (const loaded of [{ currentTier: { id: 'free-tier' }, allowedTiers: [{ id: 'free-tier', isDefault: true }] }, { allowedTiers: [] }]) {
    const urls = [];
    await discover(async url => { urls.push(url); return Response.json(urls.length === 1 ? loaded : models); });
    assert.equal(urls.some(url => url.includes('onboardUser')), false);
  }
});

test('never onboards a non-free tier without a project', async () => {
  let calls = 0;
  await discover(async () => Response.json(++calls === 1 ? { allowedTiers: [{ id: 'other-tier', isDefault: true }] } : models));
  assert.equal(calls, 2);
});

test('rejects validation-required accounts before side effects', async () => {
  for (const loaded of [{ allowedTiers: [{ id: 'free-tier', isDefault: true }], ineligibleTiers: [{ reasonCode: 'VALIDATION_REQUIRED' }] }]) {
    let calls = 0;
    await assert.rejects(discover(async () => { calls++; return Response.json(loaded); }));
    assert.equal(calls, 1);
  }
});

test('checks selected account immediately before onboarding', async () => {
  let guards = 0, calls = 0;
  await assert.rejects(discover(async () => { calls++; return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }); }, async () => { if (++guards === 3) throw Error('changed'); }));
  assert.equal(calls, 1);
});

test('rejects unsafe operation names without issuing a poll', async () => {
  let calls = 0;
  await assert.rejects(discover(async () => { calls++; return Response.json(calls === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : { done: false, name: 'https://evil.invalid/steal' }); }));
  assert.equal(calls, 2);
});

test('polls a bounded relative operation and discovers its returned project', async () => {
  const calls = [];
  const result = await discover(async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : calls.length === 2 ? { done: false, name: 'operations/fixture' } : calls.length === 3 ? { done: true, response: { cloudaicompanionProject: { id: 'actual-project' } } } : models);
  });
  assert.equal(calls[2].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal/operations/fixture');
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(result.project, 'actual-project');
});

test('rejects onboarding redirects, oversized responses and missing project without leaking body', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }), new Response('x'.repeat(2 * 1048576 + 1)), Response.json({ done: true, response: { private: 'synthetic-access' } })]) {
    let calls = 0;
    await assert.rejects(discover(async () => ++calls === 1 ? Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] }) : response), error => !error.message.includes('synthetic-access'));
    assert.equal(calls, 2);
  }
});

test('stops after onboarding if the selected account changed during the request', async () => {
  let guards = 0, calls = 0;
  await assert.rejects(discover(async () => { calls++; return Response.json(calls === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : { done: true, response: { cloudaicompanionProject: { id: 'project' } } }); }, async () => { if (++guards === 4) throw Error('changed'); }));
  assert.equal(calls, 2);
});

test('zero or multiple default tiers never start onboarding', async () => {
  for (const allowedTiers of [[{ id: 'free-tier' }], [{ id: 'free-tier', isDefault: true }, { id: 'other-tier', isDefault: true }], [{ id: 'free-tier', isDefault: true }, { id: 'free-tier', isDefault: true }]]) {
    const urls = [];
    await discover(async url => { urls.push(url); return Response.json(urls.length === 1 ? { allowedTiers } : models); });
    assert.equal(urls.length, 2);
    assert.equal(urls[1].endsWith(':fetchAvailableModels'), true);
  }
});

test('global deadline interrupts a stuck guard, request, and operation wait', async () => {
  for (const phase of ['guard', 'request', 'wait']) {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (phase === 'request') return new Promise(() => {});
      return Response.json(calls === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : { done: false, name: 'operations/fixture' });
    };
    const client = createCatalogClient(fetcher, new AbortController().signal, 40);
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(client.discover('synthetic-access', phase === 'guard' ? () => new Promise(() => {}) : async () => {}), error => error.reason === 'timeout');
      assert.equal(calls, phase === 'guard' ? 0 : phase === 'request' ? 1 : 2);
    } finally { clearTimeout(keepAlive); }
  }
});

test('catalog and onboarding requests carry the local CLI identity', async () => {
  const headers = [];
  await discover(async (_url, init) => {
    headers.push(new Headers(init.headers));
    return Response.json(headers.length === 1 ? { allowedTiers: [{ id: 'free-tier', isDefault: true }] } : headers.length === 2 ? { done: true, response: { cloudaicompanionProject: { id: 'actual-project' } } } : models);
  });
  for (const header of headers) assert.match(header.get('user-agent'), /^antigravity\/cli\//u);
});

test('a discovered project survives only as private fallback context for catalog 403', async () => {
  const { getCatalogFallbackProject } = await import('../dist/configured-catalog.js');
  for (const source of ['load', 'onboard']) {
    let calls = 0, caught;
    try {
      await discover(async () => {
        calls++;
        if (calls === 1) return Response.json(source === 'load' ? { cloudaicompanionProject: 'private-project' } : { allowedTiers: [{ id: 'free-tier', isDefault: true }] });
        if (source === 'onboard' && calls === 2) return Response.json({ done: true, response: { cloudaicompanionProject: { id: 'private-project' } } });
        return Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 });
      });
    } catch (error) { caught = error; }
    assert.equal(getCatalogFallbackProject(caught), 'private-project');
    assert.equal(JSON.stringify(caught).includes('private-project'), false);
    assert.equal(caught.message.includes('private-project'), false);
    assert.equal(Object.values(caught).includes('private-project'), false);
  }
  assert.equal(getCatalogFallbackProject(new Error('private-project')), undefined);
});

test('empty 403 model response keeps its HTTP diagnostic and private project context', async () => {
  const { getCatalogFallbackProject } = await import('../dist/configured-catalog.js');
  let calls = 0;
  await assert.rejects(discover(async () => ++calls === 1 ? Response.json({ cloudaicompanionProject: 'private-project' }) : new Response(null, { status: 403 })), error => {
    assert.equal(error.stage, 'fetchAvailableModels');
    assert.equal(error.reason, 'http_error');
    assert.equal(error.status, 403);
    assert.equal(getCatalogFallbackProject(error), 'private-project');
    assert.equal(JSON.stringify(error).includes('private-project'), false);
    return true;
  });
});
