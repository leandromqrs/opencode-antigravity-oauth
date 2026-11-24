import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';

const options = { mode: 'google-agy-oauth', authorizationAcknowledged: true };
const config = validateLocalOAuthConfiguration(options);
const connection = id => id && ({ type: 'credential', method: 'oauth', id });

async function host(initial, fetch, now = Date.now) {
  let selected = connection(initial), callback, wake;
  let reloads = 0, requests = 0;
  let cached, failReload = false;
  const queue = [];
  const credential = { type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '',
    expires: now() + 3600000, metadata: { configuration: binding(config), issuer: config.oauth.issuer } };
  const cleanup = await createLocalAntigravityOAuthPlugin(options, {
    fetch: async (...args) => { requests++; return fetch(...args); }, now,
  }).setup({
    integration: {
      transform: async cb => { assert.equal(cb({ method: { update() {} }, update() {} }), undefined); return { dispose: async () => {} }; },
      connection: { active: async () => selected, resolve: async () => credential },
    },
    provider: {
      transform: async cb => { callback = cb; return { dispose: async () => {} }; },
      reload: async () => {
        reloads++;
        if (failReload) { failReload = false; throw Error('synthetic reload failure'); }
        cached = undefined;
      },
    },
    event: {
      async *subscribe({ signal }) {
        const abort = () => wake?.();
        signal.addEventListener('abort', abort, { once: true });
        try {
          while (!signal.aborted) {
            if (!queue.length) await new Promise(resolve => { wake = resolve; if (signal.aborted) resolve(); });
            const item = queue.shift();
            if (!item) continue;
            try { yield item.event; } finally { item.done(); }
          }
        } finally { signal.removeEventListener('abort', abort); }
      },
    },
  });
  return {
    cleanup,
    select(id) { selected = connection(id); },
    get requests() { return requests; },
    get reloads() { return reloads; },
    failNextReload() { failReload = true; },
    read() { return cached ??= this.render(); },
    async event(type = 'credential.updated', integrationID = config.integrationId) {
      await new Promise(resolve => {
        queue.push({ event: { type, data: type === 'credential.switched' ? { integrationID } : {} }, done: resolve });
        wake?.();
      });
    },
    render() {
      let open = true;
      const providers = [];
      const result = callback({ add(value) { assert.equal(open, true, 'editor used after its synchronous lifetime'); providers.push(value); } });
      open = false;
      result?.catch?.(() => {});
      assert.equal(result, undefined, 'provider transforms must not return a Promise');
      return providers;
    },
  };
}

function fallbackTransport() {
  return async url => url.endsWith(':loadCodeAssist') ? Response.json({}) : new Response('', { status: 403 });
}

test('already connected startup publishes the prepared fallback inside the synchronous editor lifetime', async () => {
  const h = await host('A', fallbackTransport());
  try {
    const providers = h.render();
    assert.equal(providers.length, 1);
    assert.equal(providers[0].sourceConnection.id, 'A');
    assert.equal(providers[0].models.length, 5);
    assert.match(providers[0].info.name, /static.*experimental/i);
    const requests = h.requests;
    assert.equal(h.render().length, 1);
    assert.equal(h.requests, requests, 'registry replay must never perform discovery');
  } finally { await h.cleanup(); }
});

test('login and disconnection refresh captured inventory without recreating the plugin', { timeout: 2000 }, async () => {
  const h = await host(undefined, fallbackTransport());
  try {
    assert.deepEqual(h.render(), []);
    assert.equal(h.requests, 0);
    h.select('A');
    await h.event();
    assert.equal(h.render()[0].sourceConnection.id, 'A');
    assert.ok(h.reloads > 0);
    const before = h.reloads;
    h.select(undefined);
    await h.event();
    assert.deepEqual(h.render(), []);
    assert.ok(h.reloads > before);
  } finally { await h.cleanup(); }
});

test('switching credentials publishes only the newly selected account inventory', { timeout: 2000 }, async () => {
  const h = await host('A', fallbackTransport());
  try {
    assert.equal(h.render()[0].sourceConnection.id, 'A');
    h.select('B');
    await h.event('credential.switched');
    assert.equal(h.render()[0].sourceConnection.id, 'B');
    assert.equal(h.requests, 4);
  } finally { await h.cleanup(); }
});

test('cleanup prevents a pending discovery from publishing or reloading after unload', { timeout: 2000 }, async () => {
  let release, started;
  const loading = new Promise(resolve => { started = resolve; });
  const h = await host(undefined, async () => new Promise(resolve => { release = resolve; started(); }));
  try {
    h.select('A');
    const pending = h.event();
    await loading;
    await h.cleanup();
    const reloads = h.reloads;
    release(Response.json({}));
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.reloads, reloads);
    assert.equal(h.requests, 1);
    assert.deepEqual(h.render(), []);
  } finally { release?.(Response.json({})); await h.cleanup(); }
});

test('switching an unrelated integration does not rediscover or invalidate this provider', { timeout: 2000 }, async () => {
  const h = await host('A', fallbackTransport());
  try {
    const before = { requests: h.requests, reloads: h.reloads };
    await h.event('credential.switched', 'unrelated-integration');
    assert.equal(h.requests, before.requests);
    assert.equal(h.reloads, before.reloads);
    assert.equal(h.render()[0].sourceConnection.id, 'A');
  } finally { await h.cleanup(); }
});

test('credential notifications reuse inventory until its TTL expires, then rediscover', { timeout: 2000 }, async () => {
  let time = Date.now();
  const h = await host('A', fallbackTransport(), () => time);
  try {
    assert.equal(h.render().length, 1);
    assert.equal(h.requests, 2);
    await h.event();
    assert.equal(h.requests, 2);
    time += 30001;
    await h.event();
    assert.equal(h.requests, 4);
    assert.equal(h.render().length, 1);
  } finally { await h.cleanup(); }
});

test('a failed invalidation is retried so a cached registry can observe the prepared inventory', { timeout: 2000 }, async () => {
  const h = await host('A', fallbackTransport());
  try {
    assert.equal(h.read()[0].sourceConnection.id, 'A');
    h.failNextReload();
    h.select('B');
    await h.event('credential.switched');
    assert.equal(h.read()[0].sourceConnection.id, 'A');
    const failedReloads = h.reloads;
    await h.event();
    assert.equal(h.reloads, failedReloads + 1);
    assert.equal(h.read()[0].sourceConnection.id, 'B');
  } finally { await h.cleanup(); }
});

test('publishing the shared registry driver bypasses a retained legacy provider module', async () => {
  const h = await host('A', fallbackTransport());
  try {
    const retained = new Map([[new URL('../dist/configured-driver.js', import.meta.url).href, {
      model() { throw Error('synthetic legacy module retained'); },
    }]]);
    const source = h.render()[0];
    const driver = retained.get(source.info.package) ?? await import(source.info.package);
    assert.doesNotThrow(() => driver.model(source.models[0].id, source.info.settings));
  } finally { await h.cleanup(); }
});
