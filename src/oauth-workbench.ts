import { createHash, timingSafeEqual } from 'node:crypto';

export interface AuthorizationRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  verifier: string;
}

export interface AuthorizationResponseInput {
  responseUrl: string;
  redirectUri: string;
  expectedState: string;
}

export type AuthorizationResponse = { kind: 'code'; code: string } | { kind: 'denied' };

function reject(): never { throw new Error('Invalid offline OAuth input'); }

function text(value: unknown, min: number, max: number, syntax: RegExp): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max || !syntax.test(value)) reject();
}

function stateText(value: unknown): asserts value is string {
  text(value, 22, 128, /^[A-Za-z0-9._~-]+$/u);
}

function httpsUrl(value: unknown): URL {
  text(value, 1, 8192, /^[\x21-\x7e]+$/u);
  if (/[\\#]/u.test(value) || /%(?![0-9a-f]{2})/iu.test(value)) reject();
  let url: URL;
  try { url = new URL(value); }
  catch { return reject(); }
  if (url.protocol !== 'https:' || url.username || url.password) reject();
  return url;
}

function baseUrl(value: unknown): URL {
  const url = httpsUrl(value);
  if ((value as string).includes('?') || url.href !== value) reject();
  return url;
}

export function deriveS256Challenge(verifier: string): string {
  text(verifier, 43, 128, /^[A-Za-z0-9._~-]+$/u);
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function encodeStateEntropy(entropy: Uint8Array): string {
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 16) reject();
  return Buffer.from(entropy).toString('base64url');
}

export function buildAuthorizationUrl(input: AuthorizationRequest): string {
  if (!input || typeof input !== 'object') reject();
  const endpoint = baseUrl(input.authorizationEndpoint);
  const redirect = baseUrl(input.redirectUri);
  text(input.clientId, 1, 256, /^[\x20-\x7e]+$/u);
  stateText(input.state);
  if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 32) reject();
  for (const scope of input.scopes) text(scope, 1, 256, /^[\x21\x23-\x5b\x5d-\x7e]+$/u);
  if (new Set(input.scopes).size !== input.scopes.length) reject();
  endpoint.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: redirect.href,
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: deriveS256Challenge(input.verifier),
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  if (endpoint.href.length > 8192) reject();
  return endpoint.href;
}

export function validateAuthorizationResponse(input: AuthorizationResponseInput): AuthorizationResponse {
  if (!input || typeof input !== 'object') reject();
  const redirect = baseUrl(input.redirectUri);
  stateText(input.expectedState);
  const response = httpsUrl(input.responseUrl);
  const separator = input.responseUrl.indexOf('?');
  if (separator < 0 || input.responseUrl.slice(0, separator) !== redirect.href) reject();
  try { decodeURIComponent(input.responseUrl.slice(separator + 1)); }
  catch { return reject(); }
  const parameters = response.searchParams;
  const allowed = new Set(['state', 'code', 'error', 'error_description', 'error_uri']);
  for (const [key, value] of parameters) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1 || value.includes('\ufffd')) reject();
  }
  const receivedState = parameters.get('state');
  stateText(receivedState);
  const expected = Buffer.from(input.expectedState, 'ascii');
  const received = Buffer.from(receivedState, 'ascii');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) reject();
  const hasCode = parameters.has('code');
  const hasError = parameters.has('error');
  if (hasCode === hasError) reject();
  if (hasError) {
    text(parameters.get('error'), 1, 256, /^[\x21-\x7e]+$/u);
    return { kind: 'denied' };
  }
  if (parameters.has('error_description') || parameters.has('error_uri')) reject();
  const code = parameters.get('code');
  text(code, 1, 2048, /^[\x21-\x7e]+$/u);
  return { kind: 'code', code };
}
