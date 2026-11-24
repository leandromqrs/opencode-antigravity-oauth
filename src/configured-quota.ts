import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Fetch } from './configured-security.js';
import { localCliUserAgent } from './configured-user-agent.js';

const origin = 'https://daily-cloudcode-pa.googleapis.com';
const maxSummaryBytes = 1048576;
const maxReplyBytes = 65536;
const maxEntries = 64;

interface PercentEntry { kind: 'percent'; name: string; resultType: 'quota'; percentRemaining: number; label?: string; resetTimeIso?: string; observedAtIso: string }
interface StatusEntry { kind: 'value'; name: string; resultType: 'status'; value: string; label?: string; observedAtIso: string }
export interface QuotaV1 { version: 'quota-v1'; entries: (PercentEntry | StatusEntry)[] }
export interface AccountQuota { account: string; quota: QuotaV1 }

function displayText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const points = [...cleaned];
  if (!points.length) return undefined;
  return points.slice(0, max).join('');
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString();
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function unavailableQuotaV1(observedAt: string): QuotaV1 {
  return { version: 'quota-v1', entries: [{ kind: 'value', name: 'Antigravity quota', resultType: 'status', value: 'Unavailable', observedAtIso: observedAt }] };
}

export function quotaV1FromSummary(summary: unknown, observedAt: string): QuotaV1 {
  const root = object(summary);
  const buckets: { bucket: Record<string, unknown>; group?: string }[] = [];
  const collect = (list: unknown, group?: string) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const bucket = object(item);
      if (bucket) buckets.push({ bucket, group });
    }
  };
  if (Array.isArray(root?.groups)) {
    for (const rawGroup of root.groups) {
      const group = object(rawGroup);
      if (!group) continue;
      collect(group.buckets, displayText(group.displayName, 80));
    }
  }
  collect(root?.buckets);
  const entries: PercentEntry[] = [];
  const used = new Set<string>();
  for (const { bucket, group } of buckets) {
    if (entries.length >= maxEntries) break;
    if (bucket.disabled === true) continue;
    const fraction = bucket.remainingFraction;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) continue;
    const percent = Math.min(100, Math.max(0, fraction * 100));
    const base = displayText(bucket.displayName, 60) ?? displayText(bucket.bucketId, 60) ?? 'Quota';
    const window = displayText(bucket.window, 16);
    // 76 code points leaves room for a two-digit suffix below the 80-code-point row limit, so a deduplicated name is never truncated back into a collision.
    const stem = displayText(window ? `${base} (${window})` : base, 76) ?? 'Quota';
    let name = stem, suffix = 2;
    while (used.has(name)) name = `${stem} ${suffix++}`;
    used.add(name);
    const entry: PercentEntry = { kind: 'percent', name, resultType: 'quota', percentRemaining: percent, observedAtIso: observedAt };
    if (group) entry.label = group;
    const reset = isoTime(bucket.resetTime);
    if (reset) entry.resetTimeIso = reset;
    entries.push(entry);
  }
  if (!entries.length) return unavailableQuotaV1(observedAt);
  return { version: 'quota-v1', entries };
}

function clipPoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join('');
}

export function quotaV1ForAccounts(accounts: AccountQuota[], observedAt: string): QuotaV1 {
  if (!accounts.length) return unavailableQuotaV1(observedAt);
  if (accounts.length === 1) return accounts[0]!.quota;
  const entries: QuotaV1['entries'] = [];
  accounts.forEach(({ account, quota }, index) => {
    const tag = account || `conta ${index + 1}`;
    const suffix = ` [${index + 1}]`;
    const room = 80 - [...suffix].length;
    for (const entry of quota.entries) {
      if (entries.length >= maxEntries) break;
      const name = clipPoints(entry.name, room) + suffix;
      const label = clipPoints(`${entry.label ?? entry.name} — ${tag}`, 80);
      entries.push({ ...entry, name, label });
    }
  });
  return entries.length ? { version: 'quota-v1', entries } : unavailableQuotaV1(observedAt);
}

export async function fetchAccountEmail(fetcher: Fetch, access: string, signal: AbortSignal): Promise<string | undefined> {
  if (!/^[\x21-\x7e]{1,32768}$/u.test(access)) return undefined;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  const url = 'https://www.googleapis.com/oauth2/v3/userinfo';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, { method: 'GET',
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/json', 'User-Agent': localCliUserAgent() },
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: bounded });
    if (bounded.aborted || !response.ok || response.redirected || response.url && response.url !== url) {
      void response.body?.cancel().catch(() => {});
      return undefined;
    }
    reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (bounded.aborted) return undefined;
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxReplyBytes) return undefined;
      chunks.push(part.value);
    }
    const email = displayText(object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))))?.email, 120);
    return email && email.includes('@') ? email : undefined;
  } catch { return undefined; }
  finally {
    try { reader?.releaseLock(); } catch { /* reader may outlive cancellation */ }
  }
}

export async function fetchQuotaSummary(fetcher: Fetch, access: string, project: string, signal: AbortSignal): Promise<unknown> {
  if (!/^[\x21-\x7e]{1,32768}$/u.test(access) || !/^[\x21-\x7e]{1,512}$/u.test(project)) throw new Error('Quota unavailable.');
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const url = `${origin}/v1internal:retrieveUserQuotaSummary`;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(url, { method: 'POST', body: JSON.stringify({ project }),
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': localCliUserAgent() },
      redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: bounded });
    if (bounded.aborted) { void response.body?.cancel().catch(() => {}); throw new Error('Quota unavailable.'); }
    if (!response.ok || response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== url) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Quota unavailable.');
    }
    reader = response.body?.getReader();
    if (!reader) throw new Error('Quota unavailable.');
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (bounded.aborted) throw new Error('Quota unavailable.');
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxSummaryBytes) throw new Error('Quota unavailable.');
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Error('Quota unavailable.');
  } finally {
    try { reader?.releaseLock(); } catch { /* reader may outlive cancellation */ }
  }
}

export interface QuotaBridgeOptions {
  port: number;
  token: string;
  getQuota: (signal: AbortSignal) => Promise<QuotaV1>;
  signal?: AbortSignal;
  sharedHealth?: boolean;
}

export interface QuotaBridge { url: string; close(): Promise<void> }

export function quotaBridgeProof(token: string, direction: 'request' | 'response', nonce: string): string {
  return createHmac('sha256', token).update(`antigravity-quota-bridge-v1:${direction}:${nonce}`).digest('hex');
}

export function validQuotaBridgeProof(token: string, direction: 'request' | 'response', nonce: string, proof: string): boolean {
  return /^[a-f0-9]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(quotaBridgeProof(token, direction, nonce), 'hex'));
}

function headerCount(request: IncomingMessage, name: string): number {
  return request.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === name).length;
}

function send(response: ServerResponse, status: number, body: string): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close', ...(status === 405 ? { Allow: 'GET' } : {}) });
  response.end(body);
}

function reject(response: ServerResponse, status: number): void {
  send(response, status, JSON.stringify({ error: status === 503 ? 'Quota unavailable' : 'Request rejected' }));
}

function serializeQuota(quota: QuotaV1): string {
  const body = JSON.stringify(quota);
  if (Buffer.byteLength(body) > maxReplyBytes) throw new Error('Quota unavailable.');
  return body;
}

export async function startQuotaBridge(options: QuotaBridgeOptions): Promise<QuotaBridge> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || typeof options.token !== 'string'
    || !/^[\x21-\x7e]{32,512}$/.test(options.token) || typeof options.getQuota !== 'function') throw new Error('Invalid quota bridge options.');
  if (options.signal?.aborted) throw new Error('Quota bridge start cancelled.');
  const expectedAuth = createHash('sha256').update(`Bearer ${options.token}`).digest();
  const sockets = new Set<Socket>();
  const active = new Set<AbortController>();
  let authority = '';
  let closing: Promise<void> | undefined;
  let healthWindow = 0, healthCount = 0;
  const server = createServer({ maxHeaderSize: 4096, headersTimeout: 3000, requestTimeout: 5000, connectionsCheckingInterval: 500, keepAliveTimeout: 1 },
    (request, response) => { void handle(request, response).catch(() => reject(response, 503)); });
  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(20000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('checkContinue', (_request, response) => reject(response, 400));
  server.on('checkExpectation', (_request, response) => reject(response, 400));
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.on('connect', (_request, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) return reject(response, 503);
    if (request.method !== 'GET') return reject(response, 405);
    const health = options.sharedHealth && request.url === '/quota-bridge-health';
    if (request.url !== '/quota' && !health) return reject(response, 404);
    if (request.socket.remoteAddress !== '127.0.0.1' || request.headers.host !== authority || headerCount(request, 'host') !== 1) return reject(response, 400);
    if (request.headers.origin !== undefined) return reject(response, 403);
    if (request.headers['transfer-encoding'] !== undefined || (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) return reject(response, 400);
    if (health) {
      if (Date.now() - healthWindow >= 1000) { healthWindow = Date.now(); healthCount = 0; }
      if (++healthCount > 32) return reject(response, 429);
      const nonce = request.headers['x-agy-nonce'], proof = request.headers['x-agy-proof'];
      const challenge = `${authority.slice('127.0.0.1:'.length)}:${nonce}`;
      if (request.headers.authorization !== undefined || typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce) || typeof proof !== 'string'
        || headerCount(request, 'x-agy-nonce') !== 1 || headerCount(request, 'x-agy-proof') !== 1
        || !validQuotaBridgeProof(options.token, 'request', challenge, proof)) return reject(response, 401);
      response.writeHead(204, { 'X-Agy-Protocol': '1', 'X-Agy-Proof': quotaBridgeProof(options.token, 'response', challenge),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
      response.end();
      return;
    }
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 519 || headerCount(request, 'authorization') !== 1
      || !timingSafeEqual(createHash('sha256').update(authorization).digest(), expectedAuth)) return reject(response, 401);
    const controller = new AbortController();
    active.add(controller);
    const onClose = () => controller.abort();
    response.once('close', onClose);
    const timer = setTimeout(onClose, 15000);
    try {
      const quota = await options.getQuota(controller.signal);
      send(response, 200, serializeQuota(quota));
    } catch { reject(response, 503); }
    finally { clearTimeout(timer); response.removeListener('close', onClose); active.delete(controller); }
  }

  const onStop = () => { void close(); };
  function close(): Promise<void> {
    if (closing) return closing;
    options.signal?.removeEventListener('abort', onStop);
    for (const controller of active) controller.abort();
    closing = new Promise<void>(resolve => {
      server.close(() => { server.removeAllListeners(); resolve(); });
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  }

  try {
    await new Promise<void>((resolve, rejectPromise) => {
      const onError = () => { server.removeListener('listening', onListening); rejectPromise(new Error('Unable to start quota bridge.')); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: '127.0.0.1', port: options.port, exclusive: true });
    });
    server.on('error', onStop);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unable to start quota bridge.');
    authority = `127.0.0.1:${address.port}`;
    options.signal?.addEventListener('abort', onStop, { once: true });
    if (options.signal?.aborted) throw new Error('Quota bridge start cancelled.');
    return { url: `http://${authority}/quota`, close };
  } catch {
    await close();
    throw new Error('Unable to start quota bridge.');
  }
}