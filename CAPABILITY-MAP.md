# Capability map: opencode-antigravity-oauth

## Authorized scope

Continue static investigation with REA and prepare an offline prototype. Do not log in, read existing credentials, call Antigravity services, register a live provider, or activate the plugin. Engine installation requires separate approval. The implemented OAuth integration is verified only with synthetic fixtures, not live Antigravity access.

The Google Antigravity FAQ explicitly names OpenCode as an unsupported consumer-login integration and warns of account suspension. Continuing offline investigation does not establish permission for live access. Do not silently substitute API-key billing or an ACP agent bridge for the requested OAuth model provider.

## Modules

| Module ID | Responsibility | Depends on |
| --- | --- | --- |
| protocol-evidence | Record artifact identity, REA evidence, supported interfaces, and unresolved protocol questions. | — |
| oauth | Implement and test only evidence-backed authorization and token-lifecycle behavior using synthetic credentials. | protocol-evidence |
| model-provider | Discover models and adapt inference/streaming to OpenCode using offline fixtures. | oauth |
| quota | Represent documented quota states without inventing balances or equating visibility with entitlement. | oauth, protocol-evidence |

Build order: protocol-evidence → oauth → model-provider; quota follows only if its contract is established.

## Initial artifact evidence

- Target: `/var/home/leandromqrs/.local/bin/agy`, Linux x86-64 ELF, 280,564,136 bytes.
- SHA-256: `5df525a2d6908989c57b897723caea66e00d7c4d2e24411f91ad306989574642`.
- REA 6.8.0 ELF-note evidence: `ev_dd0f2ac56bf46881a4d9607cf2ebfd104c4bd4cf803bd171c387055688ad12a9`.
- REA artifact inventory: `ev_afa61db4896643bcea060392a06789d71a03e462406ed2f39d95240b6bf6a7b0`; coverage is the ELF root, not function behavior.
- Native analysis was attempted with Ghidra 12.1.4, 4 GiB heap and a 30-minute deadline; it timed out with Go 1.28 RTTI/analyzer failures and no recovered functions. Cleanup was confirmed. REA's built-in Go inspection also rejects this artifact because it exceeds its fixed size allowance; the artifact was not truncated.
- The runnable `protocol-evidence` slice independently validates structured Go metadata: 187,711 functions in `.lrodata` and 19,365 in `.noptrdata`. It preserves relative PCs and original offsets without claiming absolute addresses, native call recovery, payload ownership or verified OAuth. See `README.md`, `SPEC-protocol-evidence.md` and `FINDINGS.md`.
- The second slice validates PT_DYNAMIC/DT_RELA and moduledata anchors to recover main-image link-time VAs and code file offsets. The Go text base is `.text + 128`, established by relocations rather than guessed. The second embedded table remains unresolved. Focused objdump analysis anchors public endpoint/callback literals and calls compatible with authorization-code + PKCE S256; these are ordinary static observations, not REA decompilation or a supported third-party OAuth contract. See `FINDINGS-addresses-and-oauth.md`.
- Symbol names and internal API descriptors are investigation seeds, not proof of an authorization grant, active OAuth client, request format, or supported third-party API.
- Initial local evidence is retained outside this project in `/tmp/opencode/antigravity-rea/`; no raw binary, saved user context, or credential material belongs in this repository.

## Unresolved boundaries

Static observations now anchor a CLI callback literal, endpoint object, scope transformation and calls into AuthCodeURL/Exchange/PKCE helpers. Complete state/code validation, client authorization, wire-level grant and token contracts, refresh semantics, account binding, request envelope, streaming framing, model descriptors, and quota schema remain unverified. Do not implement a successful-looking login, guessed protocol, or fabricated model/quota fixture and present it as observed behavior.

The third slice adds `./oauth-workbench`: pure S256 derivation, caller-supplied 16-byte state encoding, explicit authorization URL construction and strict callback/state validation. Tests use synthetic configuration and the public RFC 7636 vector. Strict checks are NEW security policy, not observed binary compatibility: reviewed code-paste/completeOAuth paths did not reveal state/origin validation. Static refresh evidence establishes local caching/save behavior, not service rotation or durable persistence. No randomness, network, live token exchange, default client configuration or provider activation was added. See `SPEC-oauth-workbench.md` and `FINDINGS-state-and-refresh.md`.

Before implementation, review this capability map and a module-specific specification with concrete acceptance tests. The existing QwenCloud and Junie repositories remain unchanged.

## Offline finish verdict

**Superseded by the implemented inference slice below.** This section records the previous bounded pass, not a prohibition on further offline implementation.

The bounded offline investigation is closed, not the original OAuth provider implementation. `protocol-evidence` and the pure `oauth-workbench` are runnable; token lifecycle, model-provider and quota adapters remain blocked. No root plugin export, fabricated model catalog, network transport or fake successful login was added.

The installed artifact changed to SHA-256 `9db59b6371107b939befa9c507c0a24989fda974e75d81d8529f3689ef7322e5` (281,432,776 bytes). Its main text base is `0x6f68080`, with 188,458/19,365 table entries. New `final-*` evidence is separate from the initial artifact above.

Anchored descriptors now establish outer prediction fields, model-config fields and quota-summary fields. This narrows the earlier unknowns but does not recover complete nested master prediction types, stream completion/error/cancellation conversion, model selection/entitlements or quota units/defaults. Provider and integration registration were checked against official OpenCode V2 docs and read-only sibling references. A registry entry alone is not an inference driver.

See `FINDINGS-service-contracts.md` for exact schema hashes, code anchors, coverage limits and minimum authorized schemas/fixtures needed to resume. OAuth strict callback/state validation remains new local policy; none of the recovered descriptors changes that distinction. No further speculative implementation is scheduled within this offline pass.

## Implemented offline inference slice

`./offline-inference` now serializes the recovered wrapper/master text+tool subset, converts response content/thoughts/function calls/results/explicit usage and decodes fragmented data-only frames. Its injected transport has no default network implementation. A runnable synthetic demo and focused contract/error/cancellation/limit tests cover the vertical slice. Master descriptors preserve oneofs, enum numbers, field presence and map-entry semantics; schema provenance is separate from synthetic fixture values.

`FINDINGS-offline-inference.md` supersedes the earlier claim that absent vendor permission blocks this implementation. Permission remains an activation boundary. The strict decoder is a documented local subset, not complete SSE or a claim of binary-equivalent behavior.

## Native offline OpenCode V2 factory

Continuation: `CONFIGURED-INTEGRATION.md` documents the implemented native root plugin (`ctx.options`), production factory with immutable Google destination/scope/callback policy, separate reserved-host synthetic factory, real PKCE/token/refresh/HTTPS transport and native credential/provider lifecycle. Models and authorized public-client configuration remain operator-owned; configuration cannot expand the reviewed destination policy. Tests use injected synthetic HTTP only. Tools/reasoning/discovery/quota are outside the text-only minimum; no live consumer support is claimed. Final independent checks passed: 91 tests, typecheck, build, three guarded demos and isolated production-package import. Audit findings remain documented separately; these checks do not establish live authorization or compatibility.

`./offline-opencode` constructs a real LanguageModel/Route using pinned public @opencode/ai 2.2.5 and Effect 4.0.6, with injected transport and explicit synthetic text/usage policies. Actual SDK generate/stream calls are tested offline, including schema-validated events, terminal usage/errors, pending-read cancellation and consumer-break cleanup. The native subset is text-only; tools/reasoning and unsupported canonical request options fail explicitly. Usage normalization is limited to reported prompt/total counts, preserving every other count as raw usage metadata. See `FINDINGS-offline-opencode.md` for the isolated exactOptionalPropertyTypes compatibility exception and historical audit observations requiring current parent recheck. Native registration, root plugin and restricted HTTPS/OAuth transport are implemented in the continuation above. Authorized live client/account access and entitlement remain unverified; discovery and quota remain outside the minimum. Import/setup does not authorize or dispatch HTTP.

## Public references

- https://github.com/morluto/rea
- https://antigravity.google/terms
- https://antigravity.google/docs/faq
