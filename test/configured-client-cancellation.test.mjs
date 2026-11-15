import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOAuthClient } from '../dist/configured-oauth.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';

const config = validateLocalOAuthConfiguration({ mode: 'agy-local-oauth', authorizationAcknowledged: true });

test('closing OAuth rejects a pending client configuration read before it resolves', { timeout: 1000 }, async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  let release, started;
  const loading = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const client = createOAuthClient(config, {
    loadLocalClientSecret: () => new Promise(resolve => { release = resolve; started(); }),
    fetch: async () => { requests++; throw Error('unexpected token request'); },
  });
  try {
    const pending = client.begin().complete('synthetic-code');
    await loading;
    client.close();
    await assert.rejects(pending, error => error.stage === 'local_client' && error.reason === 'aborted');
    release('s'.repeat(35));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
  } finally { clearTimeout(keepAlive); release?.('s'.repeat(35)); client.close(); }
});

test('refresh bounds a pending client configuration read without sending a request', { timeout: 1000 }, async t => {
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => timeout.call(AbortSignal, ms === 5000 ? 10 : ms));
  const keepAlive = setTimeout(() => {}, 1000);
  let release, requests = 0;
  const client = createOAuthClient(config, {
    loadLocalClientSecret: () => new Promise(resolve => { release = resolve; }),
    fetch: async () => { requests++; throw Error('unexpected token request'); },
  });
  try {
    await assert.rejects(client.refresh({ type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: 'synthetic-refresh',
      expires: Date.now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer },
    }), error => error.stage === 'local_client' && error.reason === 'timeout');
    release('s'.repeat(35));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
  } finally { clearTimeout(keepAlive); release?.('s'.repeat(35)); client.close(); }
});
