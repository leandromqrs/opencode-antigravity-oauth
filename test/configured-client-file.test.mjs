import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const binary of ['absent', 'unrecognized']) {
  test(`default OAuth exchange and refresh work with the agy executable ${binary}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'agy-client-file-'));
    try {
      const config = join(root, 'config');
      await mkdir(join(config, 'opencode'), { recursive: true });
      await writeFile(join(config, 'opencode', 'antigravity-oauth-client.json'), JSON.stringify({
        clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
        clientSecret: 's'.repeat(35),
      }), { mode: 0o600 });
      if (binary === 'unrecognized') {
        await mkdir(join(root, '.local', 'bin'), { recursive: true });
        await writeFile(join(root, '.local', 'bin', 'agy'), 'not an executable');
      }
      const oauth = new URL('../dist/configured-oauth.js', import.meta.url).href;
      const security = new URL('../dist/configured-security.js', import.meta.url).href;
      const script = `
        import assert from 'node:assert/strict';
        import { createOAuthClient } from ${JSON.stringify(oauth)};
        import { validateLocalOAuthConfiguration } from ${JSON.stringify(security)};
        let requests = 0;
        const client = createOAuthClient(validateLocalOAuthConfiguration({ mode: 'google-agy-oauth', authorizationAcknowledged: true }), {
          fetch: async (url, init) => {
            const form = new URLSearchParams(init.body);
            assert.equal(url, 'https://oauth2.googleapis.com/token');
            assert.equal(form.get('client_secret'), 's'.repeat(35));
            assert.equal(form.get('grant_type'), requests++ === 0 ? 'authorization_code' : 'refresh_token');
            return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 });
          }
        });
        try {
          const credential = await client.begin().complete('synthetic-code');
          const renewed = await client.refresh(credential);
          assert.equal(renewed.access, 'synthetic-access');
          assert.equal(requests, 2);
          assert.equal(JSON.stringify(renewed).includes('s'.repeat(35)), false);
          console.log('ok');
        } catch (error) {
          console.error('OAuth test failed: ' + (error.stage || 'unknown') + '/' + (error.reason || 'unknown'));
          process.exitCode = 1;
        } finally { client.close(); }
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, HOME: root, XDG_CONFIG_HOME: config }, encoding: 'utf8', timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'ok');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
