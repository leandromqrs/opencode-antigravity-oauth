export type OfflineErrorCode = 'invalid' | 'unsupported' | 'limit' | 'remote' | 'truncated' | 'closed' | 'cancelled' | 'transport';
export type OfflineErrorStage = 'framing' | 'response' | 'native_usage' | 'http_400' | 'http_401' | 'http_403' | 'http_429' | 'http_429_capacity' | 'http_429_quota' | 'http_429_rate' | 'http_5xx' | 'http_error';

// Stable module: the inference chain is re-imported per runtime to pick up code updates on location reload,
// and every consumer must share one error class identity for instanceof checks across those copies.
export class OfflineInferenceError extends Error {
  constructor(public readonly code: OfflineErrorCode, public readonly stage?: OfflineErrorStage) {
    super(`Offline inference: ${code}`);
    this.name = 'OfflineInferenceError';
  }
}
