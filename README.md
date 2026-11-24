# opencode-google-antigravity-oauth

Google Antigravity authentication plugin for OpenCode V2.

[Installation](#installation) · [Sign in](#sign-in) · [Quota](#quota) · [Tests](#tests)

> [!WARNING]
> Use this plugin at your own risk. Google's [official FAQ](https://antigravity.google/docs/faq/#why-cant-i-use-third-party-software-such-as-claude-code-openclaw-or-opencode-with-my-antigravity-login) prohibits using an Antigravity login in third-party tools, including OpenCode, and warns that doing so can lead to account suspension or termination. This plugin is unofficial and not endorsed by Google. The `authorizationAcknowledged` option does not grant permission; it only records that you accepted this risk for your own account. For Gemini in a third-party tool, Google recommends a Gemini Enterprise or Google AI Studio API key.

The plugin connects your Antigravity account to OpenCode with OAuth PKCE, discovers the account's model catalog, and publishes its quota to OpenCode Quota. Credentials stay in OpenCode's native credential storage.

## Features

- OAuth PKCE sign-in with the Antigravity consumer client, code-paste callback, and token refresh.
- Account-bound credentials and catalog discovery, with a static experimental fallback when the live catalog is unavailable.
- Native streaming driver that preserves text, tool calls, reasoning, and usage metadata.
- Quota publication through the ticket-based `slkiser.opencode-quota/publishQuota` RPC, with no local HTTP server.
- Optional legacy loopback quota bridge for older OpenCode Quota builds.

## Requirements

- Node.js 22+ and npm.
- OpenCode V2 (the plugin pins the OpenCode 2.2.5 SDK).
- An OpenCode Quota build with [`mode: "published"`](https://github.com/slkiser/opencode-quota/pull/518) support for quota publication.

## Installation

1. Place the Antigravity consumer client secret in `~/.config/opencode/antigravity-oauth-client.json` (or `$XDG_CONFIG_HOME/opencode/antigravity-oauth-client.json`). The file must be a regular file owned by you, readable only by you (`0600` or `0400`), at most 4 KiB, holding the 35-character secret. The plugin reads it lazily, only for token exchange and refresh. Never commit it.

2. Build the plugin and add it to `plugins` in your project or global `opencode.jsonc`, preserving existing entries:

   ```sh
   npm ci --ignore-scripts --no-audit --no-fund
   npm run build
   ```

   ```jsonc
   {
     "package": "/absolute/path/to/opencode-google-antigravity-oauth",
     "options": {
       "mode": "google-agy-oauth",
       "authorizationAcknowledged": true,
       "publishQuota": true
     }
   }
   ```

## Sign in

```sh
opencode auth login google-agy-oauth --method configured-pkce
```

Open the authorization URL, sign in with your Google account, and paste the code shown on the Antigravity callback page. Paste only that code, never an access or refresh token and never the address-bar URL.

After sign-in, select an `antigravity-local` model. The catalog is discovered automatically and refreshed while the connection is active.

Options:

| Option | Meaning |
| --- | --- |
| `mode` | `google-agy-oauth` for the consumer-client integration. `agy-public-oauth` is an experimental secretless login, unverified by Google. |
| `authorizationAcknowledged` | Must be `true`; records your acceptance of the account risk. |
| `publishQuota` | `true` publishes the account quota to OpenCode Quota. Local mode only. |
| `quotaBridge` | Legacy loopback HTTP bridge (`port`, `apiKeyEnv`, `autoKey`, `shared`). Prefer `publishQuota`. |

## Quota

With `publishQuota: true`, the plugin reads the account's quota summary with the active OAuth credential and publishes `quota-v1` snapshots through `slkiser.opencode-quota/publishQuota`. Each publication requests a single-use ticket first. The first attempt runs about 15 seconds after load, then every 30 seconds. When the account is disconnected or the summary is unavailable, the plugin publishes empty entries, which withdraws the panel row. No port is opened.

Register the source in the OpenCode Quota settings, under `providers.custom`:

```json
{ "id": "antigravity-quota", "providerId": "antigravity-local", "label": "Google Antigravity", "mode": "published" }
```

The legacy `quotaBridge` option still serves the same quota over an authenticated loopback HTTP endpoint for Quota builds without published support. It is kept for compatibility; new setups should use `publishQuota`.

## Tests

```sh
npm run typecheck
npm test
```

`npm test` includes the build. The suite covers OAuth transactions and refresh, catalog discovery, the streaming driver, quota parsing and publication, the legacy bridge, and option validation, all against synthetic fixtures. Fixture results do not confirm compatibility with Google's services, model access, or entitlement.

## Project layout

`src/configured-plugin.ts` registers the integration, catalog, and driver. `src/configured-oauth.ts` and `src/local-oauth-client.ts` handle the PKCE flow and the local consumer client. `src/configured-quota.ts` reads and shapes the account quota; `src/configured-quota-publication.ts` publishes it through the ticket RPC. `src/server.ts` is the plugin entrypoint.
