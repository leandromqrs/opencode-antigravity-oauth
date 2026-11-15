import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveS256Challenge, encodeStateEntropy, buildAuthorizationUrl, validateAuthorizationResponse } from '../dist/oauth-workbench.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const state = 'synthetic-state-for-tests-123';
const redirectUri = 'https://client.example/callback';
const config = { authorizationEndpoint: 'https://auth.example/authorize', clientId: 'synthetic client&1', redirectUri, scopes: ['openid', 'https://api.example/read'], state, verifier };
const response = query => ({ responseUrl: `${redirectUri}?${query}`, redirectUri, expectedState: state });

test('S256 matches RFC 7636 Appendix B without padding', () => {
  assert.equal(deriveS256Challenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  for (const n of [43, 128]) assert.match(deriveS256Challenge('~'.repeat(n)), /^[A-Za-z0-9_-]{43}$/u);
  for (const v of ['', 'a'.repeat(42), 'a'.repeat(129), '+'.repeat(43), 'é'.repeat(43), null]) assert.throws(() => deriveS256Challenge(v));
});

test('state encoding uses exactly 16 supplied bytes without mutation', () => {
  const bytes = new Uint8Array(16).fill(255);
  assert.equal(encodeStateEntropy(bytes), '_____________________w');
  assert.deepEqual(bytes, new Uint8Array(16).fill(255));
  for (const b of [new Uint8Array(15), new Uint8Array(17), [], null]) assert.throws(() => encodeStateEntropy(b));
});

test('authorization request has explicit synthetic configuration and no verifier', () => {
  const url = buildAuthorizationUrl(config);
  const u = new URL(url);
  assert.equal(u.origin, 'https://auth.example');
  assert.deepEqual(Object.fromEntries(u.searchParams), { response_type: 'code', client_id: config.clientId, redirect_uri: redirectUri, scope: config.scopes.join(' '), state, code_challenge: deriveS256Challenge(verifier), code_challenge_method: 'S256', prompt: 'consent' });
  assert.ok(!url.includes(verifier));
  assert.equal(u.searchParams.has('code_verifier'), false);
  assert.equal(config.scopes.length, 2);
});

test('rejects unsafe or incomplete configuration and excessive serialized requests', () => {
  const changes = [{clientId:''}, {clientId:'bad\nvalue'}, {state:'short'}, {state:'é'.repeat(22)}, {scopes:[]}, {scopes:['a b']}, {scopes:['x','x']}, {scopes:['"']}, {scopes:['\\']}, {scopes:Array(33).fill('x')}, {authorizationEndpoint:'http://auth.example/'}, {authorizationEndpoint:'https://auth.example/?state=x'}, {authorizationEndpoint:'https://u:p@auth.example/'}, {redirectUri:redirectUri+'#'}, {redirectUri:redirectUri+'?'}, {redirectUri:'https://client.example/\ncallback'}, {verifier:'bad'}, {scopes:Array.from({length:32},(_,i)=>`${i}${'x'.repeat(250)}`), clientId:'&'.repeat(256)}];
  for (const change of changes) assert.throws(() => buildAuthorizationUrl({...config,...change}));
  assert.throws(() => buildAuthorizationUrl({}));
});

test('validates code and state against an explicit callback', () => {
  assert.deepEqual(validateAuthorizationResponse(response(`state=${state}&code=synthetic%2Bcode`)), {kind:'code',code:'synthetic+code'});
});

test('pure validation deliberately provides no replay protection', () => {
  const input = response(`state=${state}&code=synthetic-code`);
  assert.deepEqual(validateAuthorizationResponse(input), validateAuthorizationResponse(input));
});

test('rejects encoded duplicate parameter names and invalid runtime inputs', () => {
  for (const q of [`state=${state}&%73tate=${state}&code=x`, `state=${state}&code=x&%63ode=y`, `state=${state}&code=x&error_uri=x`]) assert.throws(() => validateAuthorizationResponse(response(q)));
  for (const input of [null, {}, {...response(''), expectedState:null}, {...response(''), responseUrl:null}, {...response(''), redirectUri:'https://CLIENT.example/callback'}]) assert.throws(() => validateAuthorizationResponse(input));
  for (const scopes of [null, 'openid', [undefined], ['x'.repeat(257)], ['é']]) assert.throws(() => buildAuthorizationUrl({...config, scopes}));
});

test('workbench remains a named helper alongside the inert root plugin', async () => {
  const module = await import('opencode-antigravity-oauth/oauth-workbench');
  assert.equal(module.deriveS256Challenge(verifier), deriveS256Challenge(verifier));
  assert.equal('default' in module, false);
  assert.equal(typeof (await import('opencode-antigravity-oauth')).default.setup, 'function');
});

test('rejects missing duplicate empty or mismatched state and ambiguous outcomes', () => {
  for (const q of ['code=x', 'state=&code=x', `state=${state}x&code=x`, `state=${state}&state=${state}&code=x`, `state=${state}&code=x&code=y`, `state=${state}&code=`, `state=${state}`, `state=${state}&code=x&error=denied`, `state=${state}&error=`, `state=${state}&code=x&error_description=x`, `state=${state}&code=x&unknown=x`]) assert.throws(() => validateAuthorizationResponse(response(q)));
});

test('rejects bare code and wrong callback origin path port or syntax', () => {
  for (const base of ['synthetic-code', 'https://evil.example/callback', 'https://client.example/other', 'https://client.example:444/callback', 'http://client.example/callback', 'https://u:p@client.example/callback', 'https://client.example/a/../callback', 'https://client.example\\callback', ' '+redirectUri]) assert.throws(() => validateAuthorizationResponse({...response(`state=${state}&code=x`),responseUrl:`${base}?state=${state}&code=x`}));
  for (const q of [`state=${state}&code=x#`, `state=${state}&code=%ZZ`, `state=${state}&code=%FF`, `state=${state}&code=%00`, `state=${state}&code=${'x'.repeat(2049)}`, `state=${state}&code=${'x'.repeat(8200)}`]) assert.throws(() => validateAuthorizationResponse(response(q)));
});

test('denial validates state and discards all remote error details', () => {
  assert.deepEqual(validateAuthorizationResponse(response(`state=${state}&error=access_denied&error_description=DO_NOT_ECHO&error_uri=https%3A%2F%2Fevil.example`)), {kind:'denied'});
  assert.throws(() => validateAuthorizationResponse(response('error=access_denied')));
  assert.throws(() => validateAuthorizationResponse(response(`state=${state}&error=x&error=x`)));
});

test('validation errors never echo caller-controlled content', () => {
  const marker = 'DO_NOT_ECHO';
  for (const fn of [() => deriveS256Challenge(marker), () => buildAuthorizationUrl({...config,authorizationEndpoint:marker}), () => validateAuthorizationResponse(response(`state=${marker}&code=${marker}`))]) {
    assert.throws(fn, error => error instanceof Error && !String(error.stack).includes(marker));
  }
});
