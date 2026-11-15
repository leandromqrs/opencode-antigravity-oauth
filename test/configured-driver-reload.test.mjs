import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make } from '@opencode/ai';
import * as retainedDriver from '../dist/configured-driver.js';

function runtime() {
  const controller = new AbortController();
  return { controller, value: {
    config: { providerId: 'synthetic-provider', models: [{ id: 'synthetic-model', enabled: true }],
      inference: { endpoint: 'https://inference.example/stream', project: 'synthetic-project', textSemantics: 'delta', usageSemantics: 'single-report' } },
    signal: controller.signal,
    credential: async () => ({ type: 'oauth', access: 'synthetic-access', expires: Date.now() + 3600000 }),
    fetch: async () => new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }] } })}\n\n`),
  } };
}

test('a retained provider factory resolves a runtime registered by a reloaded plugin module', async () => {
  const reloadedDriver = await import('../dist/configured-driver.js?reload-regression=first');
  const fixture = runtime();
  const registration = reloadedDriver.registerConfiguredRuntime(fixture.value);
  const settings = { configuredRuntime: registration.id, configuredConnection: 'synthetic-account' };
  try {
    const model = retainedDriver.model('synthetic-model', settings);
    assert.equal((await make().generate({ model, prompt: 'synthetic' })).text, 'OK');
  } finally { fixture.controller.abort(); registration.dispose(); }
  assert.throws(() => retainedDriver.model('synthetic-model', settings));
});

test('disposing an older namespace registration does not remove a newer runtime', async () => {
  const reloadedDriver = await import('../dist/configured-driver.js?reload-regression=second');
  const old = runtime(), current = runtime();
  const previous = retainedDriver.registerConfiguredRuntime(old.value);
  const next = reloadedDriver.registerConfiguredRuntime(current.value);
  try {
    old.controller.abort(); previous.dispose(); previous.dispose();
    assert.throws(() => reloadedDriver.model('synthetic-model', { configuredRuntime: previous.id, configuredConnection: 'old-account' }));
    const model = retainedDriver.model('synthetic-model', { configuredRuntime: next.id, configuredConnection: 'current-account' });
    assert.equal((await make().generate({ model, prompt: 'synthetic' })).text, 'OK');
  } finally { old.controller.abort(); current.controller.abort(); previous.dispose(); next.dispose(); }
});
