import { Rpc } from '@opencode/plugin/rpc';
import { LOCAL_PROVIDER_ID } from './configured-catalog.js';
import type { QuotaV1 } from './configured-quota.js';

const quotaReceiver = Rpc.define({
  id: 'slkiser.opencode-quota',
  methods: {
    publishQuota: {
      input: { type: 'object', properties: { providerId: { type: 'string' }, ticket: { type: 'string' }, snapshot: { type: 'object' } }, required: ['providerId'], additionalProperties: false },
      output: { type: 'object', properties: { accepted: { type: 'boolean' }, ticket: { type: 'string' } }, required: ['accepted'] },
    },
  },
  events: {},
});

export { quotaReceiver };

export interface QuotaPublicationDelays { initialMs?: number; intervalMs?: number }
export type QuotaPublicationSend = (input: { providerId: string; ticket?: string; snapshot?: QuotaV1 }) => Promise<unknown>;

export async function publishQuotaOnce(send: QuotaPublicationSend, getQuota: (signal: AbortSignal) => Promise<QuotaV1>, signal: AbortSignal): Promise<void> {
  const reply = await send({ providerId: LOCAL_PROVIDER_ID });
  if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true || !('ticket' in reply) || typeof reply.ticket !== 'string') return;
  const quota = await getQuota(signal);
  // Empty entries withdraw the panel row, matching the QwenCloud/Junie publishers; an unavailable account never publishes a fabricated balance.
  const snapshot: QuotaV1 = quota.entries.some(entry => entry.resultType === 'quota') ? quota : { version: 'quota-v1', entries: [] };
  await send({ providerId: LOCAL_PROVIDER_ID, ticket: reply.ticket, snapshot });
}

export function startQuotaPublication(send: QuotaPublicationSend, getQuota: (signal: AbortSignal) => Promise<QuotaV1>, signal: AbortSignal, delays: QuotaPublicationDelays = {}): () => void {
  const initialMs = delays.initialMs ?? 15_000;
  const intervalMs = delays.intervalMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  };
  const tick = async () => {
    if (stopped || signal.aborted) return;
    try { await publishQuotaOnce(send, getQuota, signal); } catch { /* receiver or quota unavailable; the next interval retries */ }
    if (stopped || signal.aborted) return;
    timer = setTimeout(() => { void tick(); }, intervalMs);
    timer.unref();
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) { stop(); return stop; }
  timer = setTimeout(() => { void tick(); }, initialMs);
  timer.unref();
  return stop;
}
