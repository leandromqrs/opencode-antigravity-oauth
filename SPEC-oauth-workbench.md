# Pure offline OAuth workbench

Expose only the named subpath `./oauth-workbench`, not a default plugin. No I/O, randomness, network, token exchange, embedded client configuration or provider registration. Inputs are explicitly caller-supplied; tests use synthetic `.example` hosts and the public RFC 7636 Appendix B vector.

## Interface

- `deriveS256Challenge(verifier: string): string`: RFC 7636 ASCII unreserved syntax, 43–128 characters; SHA-256, unpadded base64url. No plain fallback.
- `encodeStateEntropy(entropy: Uint8Array): string`: exactly 16 supplied bytes, unpadded base64url, mirroring the observed encoding, not generating or certifying randomness.
- `buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scopes, state, verifier }): string`: explicit HTTPS endpoints without query, fragment or credentials; no defaults. Fixed response_type=code, code_challenge_method=S256 and prompt=consent. At least one and at most 32 distinct RFC scope-token strings (each at most 256 characters), joined with spaces. Client ID printable ASCII 1–256 characters; state ASCII unreserved 22–128 characters. Verifier never included in the URL. URLs capped at 8192 characters after serialization.
- `validateAuthorizationResponse({ responseUrl, redirectUri, expectedState }): { kind: 'code'; code: string } | { kind: 'denied' }`: accept only full HTTPS callback URL, exact serialized base URI matching the explicit redirectUri, no fragment, credentials, whitespace/backslash, malformed percent escapes or replacement characters. Exactly one nonempty matching state and exactly one nonempty code OR error; reject duplicate parameters and unknown fields. Permit error_description/error_uri only with error, discard their values. Code visible non-space ASCII 1–2048 characters; error visible non-space ASCII 1–256 characters. Errors are fixed sanitized messages without supplied URLs, codes, states or remote error details.

Base URL inputs must equal their canonical WHATWG URL serialization (including an explicit trailing slash for a host-only URL). This intentionally rejects normalization aliases such as dot segments rather than interpreting them as equivalent callback paths.

## Security policy, not recovered compatibility

Strict state/callback checks are NEW local policy. No state/origin comparison was observed in SubmitAuthorizationCode or the reviewed completeOAuth dispatch path. Unlike that paste handler, this interface deliberately rejects bare codes and URLs from other origins/paths. It is not a compatible reimplementation of that handler or a general OAuth client. HTTPS-only/queryless redirect policy deliberately excludes localhost HTTP, custom schemes and preconfigured query strings.

Caller owns CSPRNG entropy (at least 128 state bits, 256 verifier bits), secure per-transaction storage, binding redirect/state/verifier to the same request, expiry, atomic single-use consumption/replay protection, issuer/account validation and client authorization. Syntax checks cannot measure entropy. A repeated pure validation succeeds again; no transaction storage exists. Do not log authorization URLs or returned codes. There is no live token/refresh interface.

## Verification path

Write synthetic failing tests first: RFC vector and boundaries, state encoding/nonmutation, exact request fields and escaping, no verifier leakage, invalid configuration and URL limits, callback success, missing/duplicate/mismatched state, incorrect origin/path/port, bare code, fragments, malformed URLs, denial and mixed outcomes, sanitized failures. Build and run only focused new tests plus typecheck in this lane; parent independently owns the full existing suite and final review. Documentation must distinguish static binary observations, public standards and new security policy.

References: https://www.rfc-editor.org/rfc/rfc7636.txt sections 4.1–4.3 and Appendix B; https://nodejs.org/api/crypto.html (`createHash`, `timingSafeEqual`). Evidence ranges are recorded in `FINDINGS-state-and-refresh.md`.
