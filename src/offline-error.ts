export type OfflineErrorCode = 'invalid' | 'unsupported' | 'limit' | 'remote' | 'truncated' | 'closed' | 'cancelled' | 'transport';
export type OfflineErrorStage = 'framing' | 'response' | 'native_usage' | 'http_400' | 'http_401' | 'http_403' | 'http_429' | 'http_429_capacity' | 'http_429_quota' | 'http_429_rate' | 'http_5xx' | 'http_error';

// Stable module: the inference chain is re-imported per runtime to pick up code updates on location reload.
// The host may keep separate copies of this module per runtime, so class identity (instanceof) is not a
// reliable test across them. Instances carry a process-wide symbol brand; recognize them with
// isOfflineInferenceError rather than instanceof.
const brand = Symbol.for('opencode-antigravity-oauth.offline-inference-error.v1');

export class OfflineInferenceError extends Error {
  constructor(public readonly code: OfflineErrorCode, public readonly stage?: OfflineErrorStage) {
    super(`Offline inference: ${code}`);
    this.name = 'OfflineInferenceError';
    Object.defineProperty(this, brand, { value: true });
  }
}

export function isOfflineInferenceError(value: unknown): value is OfflineInferenceError {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[brand] === true;
}
