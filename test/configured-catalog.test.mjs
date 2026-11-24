import assert from 'node:assert/strict';
import { assertDiagnostic, createProviderHost } from './helpers/provider-host.mjs';
import { test } from 'node:test';
import { createCatalogClient, CatalogDiagnostic } from '../dist/configured-catalog.js';
import { createLocalAntigravityOAuthPlugin } from '../dist/configured-plugin.js';
import { binding, validateLocalOAuthConfiguration } from '../dist/configured-security.js';
import { model } from '../dist/configured-driver.js';
import { make } from '@opencode/ai';
import { Model, Provider } from '@opencode/plugin';
import { Schema } from 'effect';

const options = { mode: 'google-agy-oauth', authorizationAcknowledged: true };
const config = validateLocalOAuthConfiguration(options);
const selected = id => ({ type: 'credential', id, method: 'oauth' });
const credential = () => ({ type: 'oauth', methodID: 'configured-pkce', access: 'synthetic-access', refresh: '', expires: Date.now() + 3600000,
  metadata: { configuration: binding(config), issuer: config.oauth.issuer } });
const details = () => ({ displayName: 'Synthetic text model', maxTokens: 8192, maxOutputTokens: 2048 });
const catalog = () => ({ models: { 'fixture-model': details() }, defaultAgentModelId: 'fixture-model', extra: true });
async function host(fetcher, initial = selected('A'), value = credential(), now = Date.now) {
  let active, started = false;
  const added = [];
  const providerHost = createProviderHost(input => { added.push(input); });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, { fetch: fetcher, now, loadLocalClientSecret() { throw Error('unexpected secret load'); } }).setup({
    integration: { transform: async callback => { await callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => active, resolve: async () => typeof value === 'function' ? value() : value } },
    event: providerHost.event, provider: providerHost.provider,
  });
  return { added, cleanup, diagnostics: providerHost.diagnostics, select(id) { started = true; active = id === undefined ? undefined : selected(id); }, run: () => { if (!started) { started = true; active = initial; } return providerHost.run(); } };
}

test('inference HTTP failures expose only fixed status classes and cancel remote bodies', async () => {
  for (const [status, stage] of [[400, 'http_400'], [401, 'http_401'], [403, 'http_403'], [429, 'http_429'], [503, 'http_5xx'], [418, 'http_error']]) {
    let n = 0, cancelled = false;
    const h = await host(async url => {
      if (new URL(url).pathname.endsWith(':streamGenerateContent')) return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('SYNTHETIC_SERVER_BODY_SECRET')); },
        cancel() { cancelled = true; },
      }), { status, statusText: 'SYNTHETIC_SERVER_STATUS_SECRET' });
      return Response.json(++n === 1 ? { cloudaicompanionProject: 'fixture-project' } : catalog());
    });
    try {
      await h.run();
      const native = model('fixture-model', { ...h.added[0].info.settings, ...credential().metadata, apiKey: 'synthetic-secret' });
      await assert.rejects(make().generate({ model: native, prompt: 'synthetic-secret' }), error =>
        error.message.includes(`offline_stage=${stage}`) && error.message.includes('offline_code=remote')
          && !/synthetic-secret|SYNTHETIC_SERVER_(?:BODY|STATUS)_SECRET/.test(error.message));
      assert.equal(cancelled, true);
    } finally { await h.cleanup(); }
  }
});

test('catalog discovers actual IDs and limits using only two reviewed JSON POSTs', async () => {
  const requests = [];
  const client = createCatalogClient(async (url, init) => { requests.push({ url, init }); return Response.json(requests.length === 1 ? { cloudaicompanionProject: 'fixture-project', ignored: true } : catalog()); }, new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.equal(result.project, 'fixture-project');
  assert.deepEqual(requests.map(r => r.url), ['https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels']);
  assert.deepEqual(requests.map(r => JSON.parse(r.init.body)), [{ metadata: { ideType: 9 } }, { project: 'fixture-project' }]);
  for (const { init } of requests) {
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-access');
  }
  assert.equal(result.models[0].id, 'fixture-model'); assert.equal(result.models[0].modelID, 'fixture-model');
  assert.deepEqual(result.models[0].limit, { context: 8192, output: 2048 });
  assert.deepEqual(result.models[0].cost, []); assert.deepEqual(result.models[0].capabilities, { tools: true, input: ['text'], output: ['text'] });
});

test('projectless catalog remains discoverable without inventing a project', async () => {
  const bodies = [];
  const client = createCatalogClient(async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(bodies.length === 1 ? {} : catalog()); }, new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.equal(result.project, undefined); assert.deepEqual(bodies[1], {}); assert.equal(result.models.length, 1);
});

test('catalog accepts a managed project object and forwards only its validated id', async () => {
  const bodies = [];
  const client = createCatalogClient(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return Response.json(bodies.length === 1 ? { cloudaicompanionProject: { id: 'fixture-project', extra: 'ignored' } } : catalog());
  }, new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.equal(result.project, 'fixture-project');
  assert.deepEqual(bodies[1], { project: 'fixture-project' });
});

test('catalog filters unknown limits, disabled and non-agent models without defaults', async () => {
  let n = 0;
  const client = createCatalogClient(async () => Response.json(++n === 1 ? {} : { models: {
    good: details(), missing: { displayName: 'Missing' }, zero: { ...details(), maxTokens: 0 }, disabled: { ...details(), disabled: true }, image: details(),
  }, agentModelSorts: [{ groups: [{ modelIds: ['good', 'missing', 'zero', 'disabled'] }] }] }), new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.deepEqual(result.models.map(m => m.id), ['good']); assert.equal(result.excluded, 4);
});

test('project validation failure stops before catalog and never onboards', async () => {
  let n = 0;
  const client = createCatalogClient(async () => { n++; return Response.json({ projectValidationError: { code: 7, message: 'private' } }); }, new AbortController().signal);
  await assert.rejects(client.discover('synthetic-access', async () => {}), e => e instanceof CatalogDiagnostic && !e.message.includes('private'));
  assert.equal(n, 1);
});

test('HTTP diagnostics reveal only stable status and allowlisted error code', async () => {
  const client = createCatalogClient(async () => Response.json({ error: { status: 'PERMISSION_DENIED', message: 'synthetic-access private-project' } }, { status: 403 }), new AbortController().signal);
  await assert.rejects(client.discover('synthetic-access', async () => {}), e => e.status === 403 && e.serviceError === 'PERMISSION_DENIED' && !/synthetic-access|private-project/u.test(e.message));
});

test('non-403 ErrorInfo reasons remain sanitized through discovery failure cooldown', async () => {
  for (const reason of ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'SERVICE_DISABLED', 'CONSUMER_INVALID', 'ACCESS_DENIED', 'IAM_PERMISSION_DENIED', 'SECURITY_POLICY_VIOLATED', 'private-project synthetic-access']) {
    let n = 0;
    const h = await host(async () => ++n === 1 ? Response.json({}) : Response.json({ error: {
      status: 'PERMISSION_DENIED', message: 'private-message synthetic-access', details: [{
        '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'private-domain', metadata: { project: 'private-project', scopes: 'private-scopes', service: 'private-service' },
      }],
    } }, { status: 429 }));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await h.run();
        assertDiagnostic(h, error => {
        assert.equal(error.stage, 'fetchAvailableModels'); assert.equal(error.reason, 'http_error'); assert.equal(error.status, 429);
        assert.equal(error.serviceError, 'PERMISSION_DENIED');
        assert.equal(error.serviceReason, reason.startsWith('private-') ? 'unknown' : reason);
        assert.equal(error.message.includes(`service_reason=${error.serviceReason}`), true);
        assert.equal(/private-|synthetic-access/u.test(JSON.stringify(error) + error.message), false); return true;
        });
      }
      assert.equal(h.diagnostics.length, 1);
      assert.equal(n, 2); assert.equal(h.added.length, 0);
    } finally { await h.cleanup(); }
  }
});

test('ErrorInfo requires its exact standard type', async () => {
  for (const detail of [
    { '@type': 'google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
    { '@type': 'type.googleapis.com/google.rpc.ErrorInfo/private', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' },
    { reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }, null,
  ]) {
    const client = createCatalogClient(async () => Response.json({ error: {
      status: 'PERMISSION_DENIED', message: 'private-message', details: [detail],
    } }, { status: 403 }), new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => {
      assert.equal(error.serviceReason, undefined); assert.equal(error.message.includes('service_reason='), false); return true;
    });
  }
});

test('only the exact fixed Google scope message classifies a non-success response without ErrorInfo', async () => {
  for (const [message, status, expected] of [
    ['Request had insufficient authentication scopes.', 403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    ['Request had insufficient authentication scopes', 403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'],
    ['private-project Request had insufficient authentication scopes.', 403, undefined],
    ['Request had insufficient authentication scopes. synthetic-access', 403, undefined],
    ['Request had insufficient authentication scopes.\n', 403, undefined],
    ['Request had insufficient authentication scopes.', 200, undefined],
    ['UNSUPPORTED_CLIENT private-project', 403, undefined],
  ]) {
    let n = 0;
    const client = createCatalogClient(async () => {
      n++;
      return Response.json({ error: { status: 'PERMISSION_DENIED', message } }, { status });
    }, new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => {
      assert.equal(error.serviceReason, expected); assert.equal(error.status, status);
      assert.equal(error.reason, status === 200 ? 'schema' : 'http_error');
      assert.equal(/private-project|synthetic-access|Request had/u.test(JSON.stringify(error) + error.message), false); return true;
    });
    assert.equal(n, 1);
  }
});

test('standard ErrorInfo takes precedence over the fixed scope message even for unknown reasons', async () => {
  for (const [reason, expected] of [['SERVICE_DISABLED', 'SERVICE_DISABLED'], ['private-project', 'unknown'], [undefined, 'unknown']]) {
    const client = createCatalogClient(async () => Response.json({ error: {
      status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }],
    } }, { status: 403 }), new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => {
      assert.equal(error.serviceReason, expected); assert.equal(error.message.includes('private-project'), false); return true;
    });
  }
});

test('service reason constructor accepts only fixed runtime reason values', () => {
  for (const value of ['private-project synthetic-access', null, {}, [], 7, true]) {
    const error = new CatalogDiagnostic('loadCodeAssist', 'http_error', 403, 'PERMISSION_DENIED', undefined, undefined, value);
    assert.equal(error.serviceReason, 'unknown'); assert.equal(error.message.includes('service_reason=unknown'), true);
    assert.equal(/private-|synthetic-access/u.test(JSON.stringify(error) + error.message), false);
  }
});

test('ErrorInfo diagnostics also preserve rejection of successful HTTP error envelopes', async () => {
  for (const reason of ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', undefined, null, { value: 'private-project' }]) {
    let n = 0;
    const client = createCatalogClient(async () => {
      n++;
      return Response.json({ error: { status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } });
    }, new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => {
      assert.equal(error.stage, 'loadCodeAssist'); assert.equal(error.reason, 'schema'); assert.equal(error.status, 200);
      assert.equal(error.serviceReason, typeof reason === 'string' ? reason : 'unknown');
      assert.equal(error.message.includes('private-project'), false); return true;
    });
    assert.equal(n, 1);
  }
});

test('catalog diagnostic constructors sanitize runtime values', () => {
  const error = new CatalogDiagnostic('synthetic-private', 'synthetic-private', 'synthetic-private', 'synthetic-private', 'synthetic-private');
  assert.equal(error.message.includes('synthetic-private'), false);
  assert.equal(error.stage, 'fetchAvailableModels'); assert.equal(error.reason, 'schema');
  assert.equal(error.status, undefined); assert.equal(error.excluded, undefined); assert.equal(error.cause, undefined);
});

test('catalog bounds response bytes and rejects redirects and malformed JSON', async () => {
  for (const response of [new Response('x'.repeat(2 * 1048576 + 1)), new Response('{'), new Response('', { status: 302, headers: { Location: 'https://elsewhere.invalid' } })]) {
    const client = createCatalogClient(async () => response, new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), CatalogDiagnostic);
  }
});

test('native local provider uses existing credential binding and singleflight cache', async () => {
  assert.equal(binding(config), 'bb7d372c5b743ae4977b2deb4b2a7d7b6bb8d37cddb755f6daca3cff631cba84');
  let n = 0;
  const h = await host(async () => Response.json(++n % 2 ? { cloudaicompanionProject: 'fixture-project' } : catalog()));
  await Promise.all([h.run(), h.run()]); await h.run();
  assert.equal(n, 2); assert.equal(h.added.length, 3);
  const provider = h.added[0]; assert.equal(provider.sourceConnection.id, 'A'); assert.equal(provider.info.id, 'antigravity-local');
  Schema.decodeUnknownSync(Provider.Info)(provider.info); Schema.decodeUnknownSync(Model.Info)(provider.models[0]);
  assert.equal(provider.models[0].id, 'fixture-model');
  assert.doesNotThrow(() => model('fixture-model', provider.info.settings));
  await h.cleanup(); assert.throws(() => model('fixture-model', provider.info.settings));
});

test('catalog rejects explicitly invalid project values before fetching models', async () => {
  for (const project of ['', ' ', null, 0, {}, { id: null }, { id: 'bad\nproject' }, { id: '__proto__' }, [], 'bad\nproject']) {
    let calls = 0;
    const client = createCatalogClient(async () => { calls++; return Response.json({ cloudaicompanionProject: project }); }, new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => error.stage === 'loadCodeAssist' && error.reason === 'schema');
    assert.equal(calls, 1);
  }
});

test('discovered provider without a project can create a generation model', async () => {
  let n = 0;
  const h = await host(async () => Response.json(++n % 2 ? {} : catalog()));
  try {
    await h.run();
    assert.equal(h.added.length, 1);
    assert.doesNotThrow(() => model('fixture-model', h.added[0].info.settings));
  } finally { await h.cleanup(); }
});

test('no active credential means no discovery or published provider', async () => {
  const h = await host(async () => { throw Error('network must remain idle'); }, undefined);
  h.select(undefined);
  await h.run(); assert.equal(h.added.length, 0); await h.cleanup();
});

test('late catalog from A cannot publish after switching to B', async () => {
  let release, n = 0;
  const h = await host(async () => { n++; if (n === 1) return Response.json({ cloudaicompanionProject: 'fixture-project' }); return new Promise(resolve => { release = () => resolve(Response.json(catalog())); }); });
  const pending = h.run(); while (!release) await new Promise(resolve => setImmediate(resolve));
  h.select('B'); release(); await pending; assertDiagnostic(h); assert.equal(h.added.length, 0); await h.cleanup();
});

test('binding mismatch and expiry fail before HTTP', async () => {
  for (const change of [{ metadata: {} }, { expires: 0 }]) {
    let n = 0; const h = await host(async () => { n++; return Response.json({}); }, selected('A'), { ...credential(), ...change });
    await h.run(); assertDiagnostic(h); assert.equal(h.added.length, 0); assert.equal(n, 0); await h.cleanup();
  }
});

test('old local scope binding requires reauthorization before catalog without altering the host credential', async () => {
  let n = 0;
  const old = { ...credential(), metadata: { ...credential().metadata, configuration: '7eca6879fc90dd2666d8a537421ef1e17afee1d529cc76b845156cfd9a3df635' } };
  const before = structuredClone(old);
  const h = await host(async () => { n++; return Response.json({}); }, selected('A'), old);
  try {
    await h.run();
    assertDiagnostic(h, error => error.stage === 'credential_binding' && error.reason === 'reauthorization_required'
      && error.message.includes('Authorize again using "Google Antigravity"'));
    assert.equal(n, 0); assert.equal(h.added.length, 0); assert.deepEqual(old, before);
  } finally { await h.cleanup(); }
});

test('projectless native provider publishes metadata and permits model construction', async () => {
  let n = 0; const h = await host(async () => Response.json(++n === 1 ? {} : catalog()));
  await h.run(); assert.equal(h.added[0].models.length, 1);
  assert.doesNotThrow(() => model('fixture-model', h.added[0].info.settings)); await h.cleanup();
});

test('transient catalog failure is not permanently cached', async () => {
  let n = 0, time = Date.now(); const h = await host(async () => ++n === 1 ? new Response('', { status: 503 }) : Response.json(n === 2 ? { cloudaicompanionProject: 'fixture-project' } : catalog()), selected('A'), credential(), () => time);
  await h.run(); assertDiagnostic(h); await h.run(); assertDiagnostic(h); assert.equal(n, 1);
  time += 29999; await h.run(); assertDiagnostic(h); assert.equal(n, 1); assert.equal(h.diagnostics.length, 1);
  time += 1; await h.run(); assert.equal(n, 3); assert.equal(h.added.length, 1); await h.cleanup();
});

test('eligibility diagnostics distinguish project validation from alternative tiers without raw fields', async () => {
  for (const [body, source, status, reasons] of [
    [{ projectValidationError: { code: 7, message: 'private-project synthetic-access' } }, 'projectValidationError', 7, []],
    [{ projectValidationError: { code: 7 }, ineligibleTiers: [{ reasonCode: 12, reasonMessage: 'private-project', tierId: 'private-tier' }, { reasonCode: 'VALIDATION_REQUIRED', reasonMessage: 'synthetic-access' }] }, 'projectValidationError', 7, ['UNSUPPORTED_CLIENT', 'VALIDATION_REQUIRED']],
  ]) {
    let n = 0;
    const client = createCatalogClient(async () => { n++; return Response.json(body); }, new AbortController().signal);
    await assert.rejects(client.discover('synthetic-access', async () => {}), error => {
      assert.equal(error.reason, 'eligibility'); assert.equal(error.eligibilitySource, source);
      assert.equal(error.projectStatusCode, status); assert.deepEqual(error.ineligibleReasonCodes, reasons);
      assert.equal(/private-project|private-tier|synthetic-access/u.test(JSON.stringify(error) + error.message), false); return true;
    });
    assert.equal(n, 1);
  }
});

test('eligibility diagnostics sanitize enum/status runtime values and bound reason lists', () => {
  for (const value of [-1, 17, NaN, Infinity, '7', 'private-project', {}, null]) {
    const error = new CatalogDiagnostic('loadCodeAssist', 'eligibility', undefined, undefined, undefined,
      { source: 'private-project', projectStatusCode: value, ineligibleReasonCodes: [value, 'private-project', 12, 'UNSUPPORTED_CLIENT'] });
    assert.equal(error.projectStatusCode, undefined); assert.equal(error.eligibilitySource, undefined);
    assert.deepEqual(error.ineligibleReasonCodes, ['UNSUPPORTED_CLIENT']); assert.equal(error.message.includes('private-project'), false);
  }
  for (const code of [0, 16]) assert.equal(new CatalogDiagnostic('loadCodeAssist', 'eligibility', undefined, undefined, undefined, { projectStatusCode: code }).projectStatusCode, code);
  const error = new CatalogDiagnostic('loadCodeAssist', 'eligibility', undefined, undefined, undefined, { ineligibleReasonCodes: Array(1000).fill('UNSUPPORTED_CLIENT') });
  assert.deepEqual(error.ineligibleReasonCodes, ['UNSUPPORTED_CLIENT']);
});

test('an alternative ineligible tier does not reject an actual current tier', async () => {
  let n = 0;
  const client = createCatalogClient(async () => Response.json(++n === 1 ? { currentTier: { id: 'fixture-tier' }, ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] } : catalog()), new AbortController().signal);
  assert.equal((await client.discover('synthetic-access', async () => {})).models.length, 1); assert.equal(n, 2);
});

test('per-tier unsupported client metadata without current or paid tier still requests the actual catalog', async () => {
  for (const extra of [{}, { allowedTiers: [{ id: 'fixture-allowed' }] }, { g1Tier: { id: 'fixture-g1' } }, { cloudaicompanionProject: 'fixture-project' }]) {
    const requests = [];
    const client = createCatalogClient(async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json(requests.length === 1 ? { ...extra, ineligibleTiers: [{ tierId: 'fixture-alternative', reasonCode: 'UNSUPPORTED_CLIENT' }] } : catalog());
    }, new AbortController().signal);
    const result = await client.discover('synthetic-access', async () => {});
    assert.equal(requests.length, 2); assert.equal(requests[1].url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
    assert.deepEqual(requests[1].body, extra.cloudaicompanionProject ? { project: extra.cloudaicompanionProject } : {});
    assert.equal(result.project, extra.cloudaicompanionProject); assert.deepEqual(result.models.map(value => value.id), ['fixture-model']);
    assert.deepEqual(result.models[0].limit, { context: 8192, output: 2048 });
  }
});

test('catalog HTTP 403 publishes only account-bound experimental fallback without leaking response data', async () => {
  let n = 0;
  const h = await host(async () => ++n === 1
    ? Response.json({ ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] })
    : Response.json({ error: { status: 'PERMISSION_DENIED', message: 'UNSUPPORTED_CLIENT private-project synthetic-access' } }, { status: 403 }));
  try {
    await h.run();
    assert.equal(n, 2); assert.equal(h.added.length, 1);
    assert.equal(h.added[0].sourceConnection.id, 'A');
    assert.match(h.added[0].info.name, /static experimental.*entitlement unverified/i);
    assert.equal(h.added[0].models.length, 5);
    assert.equal(/private-project|synthetic-access|UNSUPPORTED_CLIENT/u.test(JSON.stringify(h.added[0])), false);
  } finally { await h.cleanup(); }
});

test('successful HTTP top-level errors at either metadata stage reject without publishing or leaking raw fields', async () => {
  for (const stage of ['loadCodeAssist', 'fetchAvailableModels']) {
    for (const error of [{ status: 'PERMISSION_DENIED', message: 'private-project synthetic-access' }, { status: 'UNSUPPORTED_CLIENT' }, null]) {
      let n = 0;
      const h = await host(async () => {
        n++;
        return Response.json(stage === 'loadCodeAssist' || n === 2 ? { ...catalog(), error } : {});
      });
      try {
        await h.run();
        assertDiagnostic(h, value => value.stage === stage && value.reason === 'schema' && value.status === 200
          && value.serviceError === (error?.status === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'unknown')
          && !/private-project|synthetic-access/u.test(JSON.stringify(value) + value.message));
        assert.equal(n, stage === 'loadCodeAssist' ? 1 : 2); assert.equal(h.added.length, 0);
      } finally { await h.cleanup(); }
    }
  }
});

test('failed discovery cooldown is isolated by native connection and cleared on plugin reload', async () => {
  let n = 0;
  const fetcher = async () => { n++; return Response.json({ projectValidationError: { code: 7, message: 'private-project' } }); };
  const h = await host(fetcher);
  await h.run(); assertDiagnostic(h); await h.run(); assertDiagnostic(h); assert.equal(n, 1);
  h.select('B'); await h.run(); assertDiagnostic(h); assert.equal(n, 2);
  h.select('A'); await h.run(); assertDiagnostic(h); assert.equal(n, 2); assert.equal(h.added.length, 0); await h.cleanup();
  const reloaded = await host(fetcher); await reloaded.run(); assertDiagnostic(reloaded); assert.equal(n, 3); await reloaded.cleanup();
});

test('absent agent grouping and default produce no guessed text candidates', async () => {
  let n = 0;
  const client = createCatalogClient(async () => Response.json(++n === 1 ? {} : { models: { ambiguous: details(), image: details(), tab: details() }, imageGenerationModelIds: ['image'], tabModelIds: ['tab'] }), new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.deepEqual(result.models, []); assert.equal(result.excluded, 3);
});

test('explicit media-only catalog entries remain excluded even in agent groups', async () => {
  let n = 0;
  const client = createCatalogClient(async () => Response.json(++n === 1 ? {} : { models: { image: details(), audio: details() }, agentModelSorts: [{ groups: [{ modelIds: ['image', 'audio'] }] }], imageGenerationModelIds: ['image'], audioTranscriptionModelIds: ['audio'] }), new AbortController().signal);
  assert.equal((await client.discover('synthetic-access', async () => {})).models.length, 0);
});

test('switch during project resolution prevents the second service request', async () => {
  let release, n = 0;
  const h = await host(async () => { n++; return new Promise(resolve => { release = () => resolve(Response.json({ cloudaicompanionProject: 'fixture-project' })); }); });
  const pending = h.run(); while (!release) await new Promise(resolve => setImmediate(resolve));
  h.select('B'); release(); await pending; assertDiagnostic(h); assert.equal(n, 1); assert.equal(h.added.length, 0); await h.cleanup();
});

test('switch while native resolve is pending prevents all metadata requests', async () => {
  let release, n = 0;
  const h = await host(async () => { n++; return Response.json({}); }, selected('A'), () => new Promise(resolve => { release = () => resolve(credential()); }));
  const pending = h.run(); while (!release) await new Promise(resolve => setImmediate(resolve));
  h.select('B'); release(); await pending; assertDiagnostic(h); assert.equal(n, 0); assert.equal(h.added.length, 0); await h.cleanup();
});

test('disposal interrupts a pending catalog body even if the reader ignores AbortSignal', { timeout: 2000 }, async () => {
  let readStarted, cancelled = false;
  const started = new Promise(resolve => { readStarted = resolve; });
  const h = await host(async () => new Response(new ReadableStream({ pull() { readStarted(); return new Promise(() => {}); }, cancel() { cancelled = true; } })));
  const pending = h.run();
  await started; await h.cleanup(); await pending; assert.equal(cancelled, true); assert.equal(h.added.length, 0); assert.equal(h.diagnostics.length, 0);
});

test('cache expires and the next lifecycle refresh revalidates catalog before synchronous publication', async () => {
  let n = 0, time = Date.now();
  const h = await host(async () => Response.json(++n % 2 ? { cloudaicompanionProject: 'fixture-project' } : catalog()), selected('A'), credential(), () => time);
  await h.run(); await h.run(); assert.equal(n, 2);
  time += 60001; await h.run(); assert.equal(n, 4); await h.cleanup();
});

test('local native dispatch uses daily inference path and rejects cached models after account switch', async () => {
  let n = 0, inference = 0;
  const h = await host(async (url, init) => {
    if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
      inference++; assert.equal(url, 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
      assert.equal(init.headers.Accept, 'text/event-stream');
      const request = JSON.parse(init.body); assert.equal(request.project, 'fixture-project'); assert.equal(request.model, 'fixture-model');
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'synthetic-answer' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 2 } } })}\n\ndata: ${JSON.stringify({ response: { usageMetadata: { totalTokenCount: 3 } } })}\n\n`);
    }
    return Response.json(++n === 1 ? { cloudaicompanionProject: 'fixture-project' } : catalog());
  });
  await h.run();
  const native = model('fixture-model', { ...h.added[0].info.settings, ...credential().metadata, apiKey: 'ignored-host-key' });
  const ai = make(); const result = await ai.generate({ model: native, prompt: 'synthetic' });
  assert.equal(result.text, 'synthetic-answer'); assert.equal(result.usage.totalTokens, 3);
  h.select('B'); await assert.rejects(ai.generate({ model: native, prompt: 'synthetic' })); assert.equal(inference, 1); await h.cleanup();
});

test('startup discovery failures log sanitized diagnostics without disabling OAuth or blocking recovery', async () => {
  for (const failure of ['catalog', 'resolve']) {
    let method, time = Date.now(), failing = true, requests = 0, disposals = 0;
    const added = [];
    const providerHost = createProviderHost(value => { added.push(value); });
    const cleanup = await providerHost.capture(() => createLocalAntigravityOAuthPlugin(options, {
      now: () => time,
      fetch: async url => {
        requests++;
        if (failing) return Response.json({ error: { message: 'synthetic-access private-project' } }, { status: 503 });
        return Response.json(url.endsWith(':loadCodeAssist') ? {} : catalog());
      },
    }).setup({
      integration: {
        transform: async callback => { callback({ method: { update(value) { method = value; } }, update() {} }); return { dispose: async () => { disposals++; } }; },
        connection: { active: async () => selected('A'), resolve: async () => {
          if (failure === 'resolve' && failing) throw Error('synthetic-access private-project');
          return credential();
        } },
      },
      event: providerHost.event, provider: providerHost.provider,
    }));
    try {
      assert.equal(typeof method.authorize, 'function');
      assert.doesNotThrow(providerHost.publish);
      assertDiagnostic(providerHost, error => {
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(JSON.stringify(error) + error.message, /synthetic-access|private-project/u);
        if (failure === 'catalog') assert.equal(error.status, 503);
        else assert.match(error.message, /invalid or unsupported operation/u);
        return true;
      });
      assert.deepEqual(added, []);
      await providerHost.emit();
      assert.doesNotThrow(providerHost.publish);
      assert.equal(providerHost.diagnostics.length, 1);
      assert.equal(requests, failure === 'catalog' ? 1 : 0);
      assert.equal(typeof (await method.authorize()).url, 'string');
      assert.equal(disposals, 0);
      failing = false;
      time += 30000;
      await providerHost.emit();
      assert.doesNotThrow(providerHost.publish);
      assert.equal(added.length, 1);
      assert.equal(added[0].models[0].id, 'fixture-model');
      assert.equal(providerHost.diagnostics.length, 1);
      assert.equal(disposals, 0);
    } finally { await cleanup(); }
    assert.equal(disposals, 1);
  }
});

test('bounded unreferenced timer respects inventory TTL and stops on disposal', async t => {
  let scheduled, cleared, unreferenced = 0;
  const timer = { unref() { unreferenced++; } };
  t.mock.method(globalThis, 'setInterval', (callback, interval) => { assert.equal(interval, 5000); scheduled = callback; return timer; });
  t.mock.method(globalThis, 'clearInterval', value => { cleared = value; });
  let time = Date.now(), calls = 0, active = selected('A'), reloads = 0, published;
  const providerHost = createProviderHost(value => { published = value; }, () => { published = undefined; });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, {
    now: () => time,
    fetch: async () => Response.json(++calls % 2 ? {} : catalog()),
  }).setup({
    integration: {
      transform: async callback => { callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => active, resolve: async () => credential() },
    },
    event: providerHost.event, provider: { ...providerHost.provider, reload: async () => { reloads++; } },
  });
  try {
    assert.equal(calls, 2); assert.equal(unreferenced, 1);
    scheduled(); await providerHost.emit();
    assert.equal(calls, 2); assert.equal(reloads, 0);
    time += 60001;
    scheduled(); await providerHost.emit();
    assert.equal(calls, 4); assert.equal(reloads, 0);
    active = undefined;
    scheduled(); await providerHost.emit();
    providerHost.publish();
    assert.equal(published, undefined); assert.equal(reloads, 1);
    await cleanup();
    assert.equal(cleared, timer);
    scheduled(); await providerHost.emit();
    assert.equal(calls, 4); assert.equal(reloads, 1);
  } finally { await cleanup(); }
});

test('a queued credential event during discovery refreshes the new account without publishing the late account', async () => {
  let release, calls = 0;
  const h = await host(async () => {
    calls++;
    if (calls % 2) return Response.json({});
    if (calls === 2) return new Promise(resolve => { release = () => resolve(Response.json(catalog())); });
    return Response.json(catalog());
  });
  try {
    const first = h.run();
    const firstResult = assert.doesNotReject(first);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    h.select('B');
    const trailing = h.run();
    release();
    await firstResult; await trailing;
    assert.equal(calls, 4);
    assert.ok(h.added.length > 0);
    assert.ok(h.added.every(value => value.sourceConnection.id === 'B'));
  } finally { await h.cleanup(); }
});

test('credential changes during provider registration still invalidate the host after startup', async () => {
  let active = selected('A'), calls = 0, reloads = 0, published;
  const providerHost = createProviderHost(value => { published = value; });
  const cleanup = await createLocalAntigravityOAuthPlugin(options, {
    fetch: async () => Response.json(++calls % 2 ? {} : catalog()),
  }).setup({
    integration: {
      transform: async callback => { callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => active, resolve: async () => credential() },
    },
    event: providerHost.event,
    provider: {
      transform: async callback => {
        const registration = await providerHost.provider.transform(callback);
        active = selected('B');
        await providerHost.emit();
        return registration;
      },
      reload: async () => { reloads++; },
    },
  });
  try {
    assert.equal(calls, 4); assert.equal(reloads, 1);
    providerHost.publish();
    assert.equal(published.sourceConnection.id, 'B');
  } finally { await cleanup(); }
});

test('a cached host model resumes after an identical live catalog is renewed at TTL', async () => {
  let time = Date.now(), calls = 0, inference = 0;
  const h = await host(async url => {
    if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
      inference++;
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } })}\n\n`);
    }
    return Response.json(++calls % 2 ? { cloudaicompanionProject: 'fixture-project' } : catalog());
  }, selected('A'), credential(), () => time);
  try {
    await h.run();
    const settings = h.added[0].info.settings;
    const native = model('fixture-model', settings);
    const ai = make();
    assert.equal((await ai.generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    time += 60000;
    assert.throws(() => model('fixture-model', settings));
    await assert.rejects(ai.generate({ model: native, prompt: 'synthetic' }));
    assert.equal(inference, 1);
    await h.run();
    assert.equal(calls, 4);
    assert.equal((await ai.generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    assert.equal(inference, 2);
  } finally { await h.cleanup(); }
});

for (const change of ['project', 'models', 'disconnect', 'account', 'invalid']) {
  test(`a cached model stays invalid after catalog renewal changes ${change}`, async () => {
    let time = Date.now(), renewed = false, invalid = change === 'invalid', inference = 0;
    const h = await host(async url => {
      if (new URL(url).pathname.endsWith(':streamGenerateContent')) { inference++; throw Error('stale model must not dispatch'); }
      if (renewed && invalid) return new Response('', { status: 503 });
      if (url.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: renewed && change === 'project' ? 'new-project' : 'fixture-project' });
      return Response.json(renewed && change === 'models' ? { ...catalog(), models: { 'fixture-model': { ...details(), maxTokens: 9000 } } } : catalog());
    }, selected('A'), credential(), () => time);
    try {
      await h.run();
      const native = model('fixture-model', h.added[0].info.settings);
      renewed = true;
      if (change === 'disconnect') { h.select(undefined); await h.run(); h.select('A'); }
      else if (change === 'account') { h.select('B'); await h.run(); h.select('A'); }
      else time += 60000;
      if (change === 'invalid') {
        await h.run(); assertDiagnostic(h);
        invalid = false;
        time += 30000;
        await h.run();
      }
      else await h.run();
      await assert.rejects(make().generate({ model: native, prompt: 'synthetic' }));
      assert.equal(inference, 0);
    } finally { await h.cleanup(); }
  });
}

test('a failed host reload is retried on the next event without rediscovery or an immediate retry loop', async () => {
  let active, calls = 0, reloads = 0;
  const providerHost = createProviderHost();
  const cleanup = await createLocalAntigravityOAuthPlugin(options, {
    fetch: async () => Response.json(++calls % 2 ? {} : catalog()),
  }).setup({
    integration: {
      transform: async callback => { callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => active, resolve: async () => credential() },
    },
    event: providerHost.event,
    provider: { ...providerHost.provider, reload: async () => {
      reloads++;
      if (reloads === 1) throw Error('synthetic-access private-project');
    } },
  });
  try {
    active = selected('A');
    await providerHost.emit();
    assert.equal(calls, 2); assert.equal(reloads, 1);
    await providerHost.emit();
    assert.equal(calls, 2); assert.equal(reloads, 2);
    await providerHost.emit();
    assert.equal(calls, 2); assert.equal(reloads, 2);
    assert.doesNotThrow(providerHost.publish);
  } finally { await cleanup(); }
});

test('a project-only catalog change invalidates the host cache and regenerates a working model without exposing the project', async () => {
  let time = Date.now(), project = 'fixture-private-first', calls = 0, reloads = 0, published, cached;
  const dispatchedProjects = [];
  const providerHost = createProviderHost(value => { published = value; });
  const readModel = () => {
    if (!cached) {
      providerHost.publish();
      cached = model('fixture-model', published.info.settings);
    }
    return cached;
  };
  const cleanup = await createLocalAntigravityOAuthPlugin(options, {
    now: () => time,
    fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
        dispatchedProjects.push(JSON.parse(init.body).project);
        return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } })}\n\n`);
      }
      calls++;
      return Response.json(url.endsWith(':loadCodeAssist') ? { cloudaicompanionProject: project } : catalog());
    },
  }).setup({
    integration: {
      transform: async callback => { callback({ method: { update() {} }, update() {} }); return { dispose: async () => {} }; },
      connection: { active: async () => selected('A'), resolve: async () => credential() },
    },
    event: providerHost.event,
    provider: { ...providerHost.provider, reload: async () => { reloads++; cached = undefined; } },
  });
  try {
    const original = readModel();
    const ai = make();
    assert.equal((await ai.generate({ model: original, prompt: 'synthetic' })).text, 'answer');
    assert.doesNotMatch(JSON.stringify(published), /fixture-private-/u);
    time += 60000;
    await providerHost.emit();
    assert.equal(calls, 4); assert.equal(reloads, 0);
    assert.equal(readModel(), original);
    time += 60000;
    project = 'fixture-private-second';
    await providerHost.emit();
    assert.equal(calls, 6); assert.equal(reloads, 1);
    const renewed = readModel();
    assert.notEqual(renewed, original);
    assert.equal((await ai.generate({ model: renewed, prompt: 'synthetic' })).text, 'answer');
    await assert.rejects(ai.generate({ model: original, prompt: 'synthetic' }));
    assert.deepEqual(dispatchedProjects, ['fixture-private-first', 'fixture-private-second']);
    assert.doesNotMatch(JSON.stringify(published), /fixture-private-/u);
  } finally { await cleanup(); }
});

const effortDetails = () => ({ displayName: 'Gemini 3.8 Flash', maxTokens: 1048576, maxOutputTokens: 65536 });
const effortCatalog = () => ({
  models: {
    'gemini-3.8-flash-low': { ...effortDetails(), displayName: 'Gemini 3.8 Flash (Low)' },
    'gemini-3.8-flash-medium': { ...effortDetails(), displayName: 'Gemini 3.8 Flash (Medium)' },
    'gemini-3.8-flash-high': { ...effortDetails(), displayName: 'Gemini 3.8 Flash (High)' },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 200000, maxOutputTokens: 64000 },
  },
  defaultAgentModelId: 'gemini-3.8-flash-medium',
  agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high', 'claude-sonnet-4-6'] }] }],
});

test('effort-suffixed catalog models group into one base model with ordered variants and a medium default', async () => {
  const client = createCatalogClient(async (_url, init) => Response.json(JSON.parse(init.body).metadata ? { cloudaicompanionProject: 'fixture-project' } : effortCatalog()), new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.equal(result.models.length, 2);
  const flash = result.models.find(value => value.id === 'gemini-3.8-flash');
  assert.ok(flash, 'expected a grouped base flash model');
  assert.equal(flash.modelID, 'gemini-3.8-flash');
  assert.equal(flash.name, 'Gemini 3.8 Flash');
  assert.deepEqual(flash.variants.map(value => value.id), ['low', 'medium', 'high']);
  assert.deepEqual(flash.variants.map(value => value.settings.antigravityModel), ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high']);
  assert.equal(flash.settings.antigravityModel, 'gemini-3.8-flash-medium');
  assert.deepEqual(flash.limit, { context: 1048576, output: 65536 });
  const claude = result.models.find(value => value.id === 'claude-sonnet-4-6');
  assert.deepEqual(claude.variants, []);
  assert.equal(claude.settings, undefined);
  assert.equal(result.excluded, 0);
});

test('effort variants resolve the wire model in the driver; unknown wires are rejected', async () => {
  const dispatched = [];
  let n = 0;
  const h = await host(async (url, init) => {
    if (new URL(url).pathname.endsWith(':streamGenerateContent')) {
      dispatched.push(JSON.parse(init.body).model);
      return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }] } })}\n\n`);
    }
    return Response.json(++n === 1 ? { cloudaicompanionProject: 'fixture-project' } : effortCatalog());
  });
  try {
    await h.run();
    const entry = h.added[0];
    const flash = entry.models.find(value => value.id === 'gemini-3.8-flash');
    const ai = make();
    const base = { ...entry.info.settings, ...credential().metadata, apiKey: 'ignored-host-key' };
    const defaultModel = model('gemini-3.8-flash', { ...base, ...flash.settings });
    assert.equal((await ai.generate({ model: defaultModel, prompt: 'synthetic' })).text, 'answer');
    for (const effort of ['low', 'high']) {
      const variant = flash.variants.find(value => value.id === effort);
      const native = model('gemini-3.8-flash', { ...base, ...flash.settings, ...variant.settings });
      assert.equal((await ai.generate({ model: native, prompt: 'synthetic' })).text, 'answer');
    }
    assert.deepEqual(dispatched, ['gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'gemini-3.8-flash-high']);
    assert.throws(() => model('gemini-3.8-flash', { ...base, ...flash.settings, antigravityModel: 'gemini-3.8-flash-ultra' }));
    for (const bad of [null, 42, {}, '']) assert.throws(() => model('gemini-3.8-flash', { ...base, ...flash.settings, antigravityModel: bad }));
    assert.throws(() => model('gemini-3.8-flash-low', { ...base, ...flash.settings }));
    const claude = entry.models.find(value => value.id === 'claude-sonnet-4-6');
    assert.throws(() => model('claude-sonnet-4-6', { ...base, ...claude.settings, antigravityModel: 'gemini-3.8-flash-low' }));
  } finally { await h.cleanup(); }
});

test('static experimental fallback uses the same base-plus-variant effort shape', async () => {
  let n = 0;
  const h = await host(async () => ++n === 1
    ? Response.json({ ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] })
    : Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }));
  try {
    await h.run();
    const ids = h.added[0].models.map(value => value.id);
    assert.equal(ids.includes('gemini-3.8-flash'), true);
    assert.equal(ids.some(value => /-(?:low|medium|high)$/u.test(value)), false);
    const flash = h.added[0].models.find(value => value.id === 'gemini-3.8-flash');
    assert.deepEqual(flash.variants.map(value => value.id), ['medium']);
    assert.equal(flash.settings.antigravityModel, 'gemini-3.8-flash-medium');
  } finally { await h.cleanup(); }
});

test('effort default falls back to high then minimal when medium is absent', async () => {
  const catalogBody = {
    models: { 'gemini-3.8-flash-high': effortDetails(), 'gemini-3.8-flash-minimal': effortDetails() },
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash-high', 'gemini-3.8-flash-minimal'] }] }],
  };
  const client = createCatalogClient(async (_url, init) => Response.json(JSON.parse(init.body).metadata ? {} : catalogBody), new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  const flash = result.models.find(value => value.id === 'gemini-3.8-flash');
  assert.deepEqual(flash.variants.map(value => value.id), ['minimal', 'high']);
  assert.equal(flash.settings.antigravityModel, 'gemini-3.8-flash-high');
});

test('a plain base entry colliding with effort variants is superseded by the grouped model', async () => {
  const catalogBody = {
    models: { 'gemini-3.8-flash': effortDetails(), 'gemini-3.8-flash-low': effortDetails(), 'gemini-3.8-flash-medium': effortDetails() },
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.8-flash', 'gemini-3.8-flash-low', 'gemini-3.8-flash-medium'] }] }],
  };
  const client = createCatalogClient(async (_url, init) => Response.json(JSON.parse(init.body).metadata ? {} : catalogBody), new AbortController().signal);
  const result = await client.discover('synthetic-access', async () => {});
  assert.equal(result.models.filter(value => value.id === 'gemini-3.8-flash').length, 1);
  const flash = result.models.find(value => value.id === 'gemini-3.8-flash');
  assert.deepEqual(flash.variants.map(value => value.id), ['low', 'medium']);
  assert.equal(flash.settings.antigravityModel, 'gemini-3.8-flash-medium');
});
