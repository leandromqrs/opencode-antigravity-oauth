import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireQuotaBridge } from '../dist/configured-quota-bridge-plugin.js';
import { unavailableQuotaV1, startQuotaBridge, quotaBridgeProof, validQuotaBridgeProof } from '../dist/configured-quota.js';
import { startSharedQuotaBridge } from '../dist/configured-quota-bridge-shared.js';
import { prepareQuotaBridgeState } from '../dist/configured-quota-bridge-storage.js';

const observedAt = '2026-11-15T12:00:00.000Z';
const realQuota = { version: 'quota-v1', entries: [{ kind: 'percent', name: 'Gemini (weekly)', resultType: 'quota', percentRemaining: 89, observedAtIso: observedAt }] };
const quotaWith = percentRemaining => ({ version: 'quota-v1', entries: [{ kind: 'percent', name: 'Gemini (weekly)', resultType: 'quota', percentRemaining, observedAtIso: observedAt }] });
const fetchQuota = async (url, key) => {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  return { status: response.status, body: await response.json() };
};
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('leases share one bridge and getQuota falls through to a live lease', async () => {
  const apiKeyEnv = 'AGY_TEST_BRIDGE_SHARED';
  const config = { port: 0, apiKeyEnv, autoKey: true, shared: false };
  const first = await acquireQuotaBridge(config, { getQuota: async () => unavailableQuotaV1(observedAt) });
  try {
    assert.equal(first.status.running, true);
    assert.ok(first.status.url);
    const second = await acquireQuotaBridge(config, { getQuota: async () => realQuota });
    try {
      assert.equal(second.status.url, first.status.url, 'second lease reuses the same bridge');
      const key = process.env[apiKeyEnv];
      assert.ok(key, 'autoKey publishes the bridge key');
      const result = await fetchQuota(first.status.url, key);
      assert.equal(result.status, 200);
      assert.equal(result.body.entries[0].percentRemaining, 89, 'aggregated getQuota skips the unavailable lease');
      await first.release();
      const stillUp = await fetchQuota(second.status.url, key);
      assert.equal(stillUp.status, 200, 'bridge survives while a lease remains');
    } finally { await second.release(); }
  } finally { await first.release(); }
  assert.equal(process.env[apiKeyEnv], undefined, 'last release clears the autoKey');
});

test('releasing the only lease closes the bridge', async () => {
  const apiKeyEnv = 'AGY_TEST_BRIDGE_SINGLE';
  const config = { port: 0, apiKeyEnv, autoKey: true, shared: false };
  const acquired = await acquireQuotaBridge(config, { getQuota: async () => realQuota });
  const url = acquired.status.url;
  const key = process.env[apiKeyEnv];
  assert.equal((await fetchQuota(url, key)).status, 200);
  await acquired.release();
  assert.equal(process.env[apiKeyEnv], undefined);
  await assert.rejects(fetch(url, { headers: { Authorization: `Bearer ${key}` } }));
});

test('incompatible config and missing key are reported without starting', async () => {
  const apiKeyEnv = 'AGY_TEST_BRIDGE_COMPAT';
  const config = { port: 0, apiKeyEnv, autoKey: true, shared: false };
  const acquired = await acquireQuotaBridge(config, { getQuota: async () => realQuota });
  try {
    const mismatch = await acquireQuotaBridge({ ...config, apiKeyEnv: 'AGY_TEST_BRIDGE_OTHER' }, { getQuota: async () => realQuota });
    assert.equal(mismatch.status.diagnostic, 'incompatible-config');
    assert.equal(mismatch.status.running, false);
    await mismatch.release();
  } finally { await acquired.release(); }
  delete process.env[apiKeyEnv];
  const missing = await acquireQuotaBridge({ port: 0, apiKeyEnv: 'AGY_TEST_BRIDGE_MISSING', autoKey: false, shared: false }, { getQuota: async () => realQuota });
  assert.equal(missing.status.diagnostic, 'missing-key');
  assert.equal(missing.status.running, false);
  await missing.release();
});

test('disabled config is a no-op', async () => {
  const acquired = await acquireQuotaBridge(undefined, { getQuota: async () => realQuota });
  assert.equal(acquired.status.enabled, false);
  assert.equal(acquired.status.running, false);
  await acquired.release();
});

test('shared health endpoint proves the token without revealing it', async () => {
  const token = 'h'.repeat(48);
  const bridge = await startQuotaBridge({ port: 0, token, sharedHealth: true, getQuota: async () => realQuota });
  try {
    const port = new URL(bridge.url).port;
    const health = headers => fetch(`http://127.0.0.1:${port}/quota-bridge-health`, { headers });
    const nonce = randomBytes(32).toString('hex');
    const challenge = `${port}:${nonce}`;
    const ok = await health({ 'X-Agy-Nonce': nonce, 'X-Agy-Proof': quotaBridgeProof(token, 'request', challenge) });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('x-agy-protocol'), '1');
    assert.ok(validQuotaBridgeProof(token, 'response', challenge, ok.headers.get('x-agy-proof')), 'response proof verifies');
    assert.equal((await health({ 'X-Agy-Nonce': nonce, 'X-Agy-Proof': 'f'.repeat(64) })).status, 401, 'wrong proof rejected');
    assert.equal((await health({ 'X-Agy-Nonce': nonce, 'X-Agy-Proof': quotaBridgeProof(token, 'request', challenge), Authorization: `Bearer ${token}` })).status, 401, 'bearer not accepted on health');
    assert.equal((await health({})).status, 401, 'missing challenge rejected');
  } finally { await bridge.close(); }
  const plain = await startQuotaBridge({ port: 0, token, getQuota: async () => realQuota });
  try {
    const port = new URL(plain.url).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/quota-bridge-health`)).status, 404, 'health absent without sharedHealth');
  } finally { await plain.close(); }
});

test('shared state file is private and first writer wins the token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-bridge-state-'));
  const first = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] });
  const second = await prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [] });
  assert.equal(second.token, first.token, 'second process reads the same key');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, 'bridge.key'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(directory, 'bridge.key'), 'utf8'), first.token);
  await assert.rejects(prepareQuotaBridgeState({ stateDirectory: directory, workspaceRoots: [], token: 'x'.repeat(48) }), /state unavailable/u, 'a different explicit token cannot overwrite');
});

test('shared bridge reuses a live owner and takes over when it dies', async () => {
  const port = await freePort();
  const token = 's'.repeat(48);
  const url = `http://127.0.0.1:${port}/quota`;
  const owner = await startSharedQuotaBridge({ port, token, getQuota: async () => quotaWith(11) });
  let follower;
  try {
    follower = await startSharedQuotaBridge({ port, token, getQuota: async () => quotaWith(22) });
    assert.equal(follower.url, url);
    assert.equal((await fetchQuota(url, token)).body.entries[0].percentRemaining, 11, 'live owner serves');
    await follower.close();
    follower = undefined;
    assert.equal((await fetchQuota(url, token)).body.entries[0].percentRemaining, 11, 'follower close leaves the owner up');
    await owner.close();
    follower = await startSharedQuotaBridge({ port, token, getQuota: async () => quotaWith(22) });
    let taken = false;
    for (let i = 0; i < 40 && !taken; i++) {
      await sleep(250);
      taken = await fetchQuota(url, token).then(result => result.body.entries[0].percentRemaining === 22).catch(() => false);
    }
    assert.ok(taken, 'monitor retakes the port after the owner dies');
  } finally {
    await follower?.close();
    await owner.close().catch(() => {});
  }
});

test('shared acquire spans processes: leases, external owner reuse and key fencing', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'agy-bridge-acquire-'));
  const port = await freePort();
  const apiKeyEnv = 'AGY_TEST_BRIDGE_XPROC';
  const config = { port, apiKeyEnv, autoKey: true, shared: true };
  const url = `http://127.0.0.1:${port}/quota`;
  const first = await acquireQuotaBridge(config, { getQuota: async () => realQuota }, { stateDirectory });
  try {
    assert.equal(first.status.running, true);
    assert.equal(first.status.url, url);
    const key = process.env[apiKeyEnv];
    assert.equal(key, await readFile(join(stateDirectory, 'bridge.key'), 'utf8'), 'env key is the shared file key');
    const mismatch = await acquireQuotaBridge({ ...config, shared: false }, { getQuota: async () => realQuota }, { stateDirectory });
    assert.equal(mismatch.status.diagnostic, 'incompatible-config');
    await mismatch.release();
    const second = await acquireQuotaBridge(config, { getQuota: async () => unavailableQuotaV1(observedAt) }, { stateDirectory });
    try {
      assert.equal(second.status.url, url);
      assert.equal((await fetchQuota(url, key)).body.entries[0].percentRemaining, 89);
    } finally { await second.release(); }
  } finally { await first.release(); }
  assert.equal(process.env[apiKeyEnv], undefined);
  await assert.rejects(fetch(url, { headers: { Authorization: `Bearer ${'s'.repeat(48)}` } }));
  const externalToken = await readFile(join(stateDirectory, 'bridge.key'), 'utf8');
  const external = await startQuotaBridge({ port, token: externalToken, sharedHealth: true, getQuota: async () => quotaWith(33) });
  try {
    const third = await acquireQuotaBridge(config, { getQuota: async () => realQuota }, { stateDirectory });
    try {
      assert.equal(third.status.running, true, 'a live external owner that proves the key is reused');
      assert.equal(third.status.url, url);
      assert.equal(process.env[apiKeyEnv], externalToken);
      assert.equal((await fetchQuota(url, externalToken)).body.entries[0].percentRemaining, 33, 'external owner serves its own quota');
    } finally { await third.release(); }
    assert.equal(process.env[apiKeyEnv], undefined);
    assert.equal((await fetchQuota(url, externalToken)).body.entries[0].percentRemaining, 33, 'release does not close an external bridge');
  } finally { await external.close(); }
});
