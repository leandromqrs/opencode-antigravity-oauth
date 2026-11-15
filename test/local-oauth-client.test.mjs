import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const moduleUrl = new URL('../dist/local-oauth-client.js', import.meta.url).href;
const clientId = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const clientSecret = 'synthetic-test-only-' + 'x'.repeat(15);
const valid = () => ({ clientId, clientSecret });

async function fixture(t, { content = JSON.stringify(valid()), mode = 0o600, missing = false, fallback = false } = {}) {
  const root = await mkdtemp(join(process.env.TMPDIR || '/tmp/opencode', 'local-oauth-client-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const config = fallback ? join(home, '.config') : join(root, 'config');
  const directory = join(config, 'opencode');
  await mkdir(directory, { recursive: true });
  const file = join(directory, 'antigravity-oauth-client.json');
  if (!missing) {
    await writeFile(file, content, { mode });
    await chmod(file, mode);
  }
  return { root, home, config, directory, file };
}

function run(f, body, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { constants } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const moduleUrl = ${JSON.stringify(moduleUrl)};
    const expectedId = ${JSON.stringify(clientId)};
    const expectedSecret = ${JSON.stringify(clientSecret)};
    ${body}
  `], {
    env: { HOME: f.home, XDG_CONFIG_HOME: f.config, PATH: f.root, ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
}

const succeeds = `
  const client = await import(moduleUrl);
  assert.equal(client.AGY_CONSUMER_CLIENT_ID, expectedId);
  assert.equal(await client.loadLocalConsumerSecret(), expectedSecret);
`;

function rejects(reason) {
  return `
    const client = await import(moduleUrl);
    await assert.rejects(client.loadLocalConsumerSecret(), error => {
      assert.ok(error instanceof client.LocalOAuthClientError);
      assert.equal(error.name, 'LocalOAuthClientError');
      assert.equal(error.reason, ${JSON.stringify(reason)});
      assert.equal(error.message, ${JSON.stringify(reason === 'unreadable'
        ? 'Local OAuth client configuration is unreadable.'
        : 'Local OAuth client configuration is invalid.')});
      assert.equal(error.cause, undefined);
      assert.ok(!String(error).includes(expectedSecret));
      assert.ok(!String(error).includes(process.env.HOME));
      return true;
    });
  `;
}

test('loads only the private local client configuration with no agy executable', async t => {
  const f = await fixture(t);
  run(f, succeeds);
});

test('import does not read configuration or resolve an invalid XDG path', async t => {
  const f = await fixture(t, { missing: true });
  run(f, `
    fs.open = async () => { throw new Error('import attempted I/O'); };
    syncBuiltinESMExports();
    const client = await import(moduleUrl);
    assert.equal(typeof client.loadLocalConsumerSecret, 'function');
  `, { XDG_CONFIG_HOME: 'relative' });
});

for (const value of [undefined, '']) {
  test(`falls back to HOME/.config when XDG_CONFIG_HOME is ${value === undefined ? 'absent' : 'empty'}`, async t => {
    const f = await fixture(t, { fallback: true });
    run(f, succeeds, { XDG_CONFIG_HOME: value });
  });
}

test('rejects relative XDG_CONFIG_HOME without opening files', async t => {
  const f = await fixture(t);
  run(f, `fs.open = async () => assert.fail('relative path reached filesystem'); syncBuiltinESMExports(); ${rejects('invalid_client_configuration')}`,
    { XDG_CONFIG_HOME: 'relative/config' });
});

test('missing configuration produces a sanitized unreadable error', async t => {
  const f = await fixture(t, { missing: true });
  run(f, rejects('unreadable'));
});

for (const mode of [0o400, 0o600]) {
  test(`accepts private file mode ${mode.toString(8)}`, async t => {
    const f = await fixture(t, { mode });
    run(f, succeeds);
  });
}

for (const mode of [0o644, 0o640, 0o604, 0o700, 0o200, 0o4600]) {
  test(`rejects unsafe file mode ${mode.toString(8)}`, async t => {
    const f = await fixture(t, { mode });
    run(f, rejects(mode === 0o200 && process.getuid() !== 0 ? 'unreadable' : 'invalid_client_configuration'));
  });
}

test('rejects a symlink as the final path component', async t => {
  const f = await fixture(t, { missing: true });
  const target = join(f.root, 'target.json');
  await writeFile(target, JSON.stringify(valid()), { mode: 0o600 });
  await symlink(target, f.file);
  run(f, rejects('unreadable'));
});

test('rejects a directory instead of a regular file', async t => {
  const f = await fixture(t, { missing: true });
  await mkdir(f.file, { mode: 0o700 });
  run(f, rejects('invalid_client_configuration'));
});

const invalidDocuments = [
  ['malformed JSON', '{sensitive-invalid-content'],
  ['null', 'null'],
  ['array', JSON.stringify([valid()])],
  ['missing clientId', JSON.stringify({ clientSecret })],
  ['missing clientSecret', JSON.stringify({ clientId })],
  ['wrong clientId', JSON.stringify({ ...valid(), clientId: 'wrong' })],
  ['extra access token', JSON.stringify({ ...valid(), accessToken: 'synthetic-access-token' })],
  ['extra refresh token', JSON.stringify({ ...valid(), refreshToken: 'synthetic-refresh-token' })],
  ['extra property', JSON.stringify({ ...valid(), extra: true })],
  ['numeric secret', JSON.stringify({ ...valid(), clientSecret: 35 })],
  ['short secret', JSON.stringify({ ...valid(), clientSecret: 'x'.repeat(34) })],
  ['long secret', JSON.stringify({ ...valid(), clientSecret: 'x'.repeat(36) })],
  ['35 characters followed by newline', JSON.stringify({ ...valid(), clientSecret: 'x'.repeat(35) + '\n' })],
  ...[' ', '\t', '\n', '\r', '\0', '\x1f', '\x7f', 'é'].map(character => [
    `forbidden secret character U+${character.codePointAt(0).toString(16)}`,
    JSON.stringify({ ...valid(), clientSecret: 'x'.repeat(34) + character }),
  ]),
];

for (const [description, content] of invalidDocuments) {
  test(`rejects ${description}`, async t => {
    const f = await fixture(t, { content });
    run(f, rejects('invalid_client_configuration'));
  });
}

test('accepts exactly 35 printable non-space ASCII secret characters', async t => {
  const secret = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~abc';
  assert.equal(secret.length, 35);
  const f = await fixture(t, { content: JSON.stringify({ clientId, clientSecret: secret }) });
  run(f, `
    const client = await import(moduleUrl);
    assert.equal(await client.loadLocalConsumerSecret(), ${JSON.stringify(secret)});
  `);
});

test('accepts a file of exactly 4096 bytes', async t => {
  const content = JSON.stringify(valid()).padEnd(4096, ' ');
  const f = await fixture(t, { content });
  run(f, succeeds);
});

test('rejects files larger than 4096 bytes', async t => {
  const f = await fixture(t, { content: JSON.stringify(valid()).padEnd(4097, ' ') });
  run(f, rejects('invalid_client_configuration'));
});

test('does not cache a secret or path between calls', async t => {
  const f = await fixture(t);
  run(f, `
    const client = await import(moduleUrl);
    assert.equal(await client.loadLocalConsumerSecret(), expectedSecret);
    process.env.XDG_CONFIG_HOME += '/missing';
    await assert.rejects(client.loadLocalConsumerSecret(), { reason: 'unreadable' });
  `);
});

function instrumentFileHandle(instrumentation) {
  return `
    const originalOpen = fs.open;
    let openedHandle;
    fs.open = async (path, flags) => {
      assert.ok(flags & constants.O_NOFOLLOW);
      assert.ok(flags & constants.O_NONBLOCK);
      const handle = await originalOpen(path, flags);
      openedHandle = handle;
      ${instrumentation}
      return handle;
    };
    syncBuiltinESMExports();
  `;
}

test('rejects a file owned by a different user', async t => {
  const f = await fixture(t);
  run(f, instrumentFileHandle(`
    const originalStat = handle.stat.bind(handle);
    handle.stat = async (...args) => {
      const stats = await originalStat(...args);
      stats.uid = typeof stats.uid === 'bigint' ? stats.uid + 1n : stats.uid + 1;
      return stats;
    };
  `) + rejects('invalid_client_configuration'));
});

for (const field of ['size', 'mtimeNs', 'ctimeNs']) {
  test(`rejects a file whose ${field} changes during reading`, async t => {
    const f = await fixture(t);
    run(f, instrumentFileHandle(`
      const originalStat = handle.stat.bind(handle);
      let calls = 0;
      handle.stat = async (...args) => {
        const stats = await originalStat(...args);
        if (++calls > 1) stats[${JSON.stringify(field)}] += 1n;
        return stats;
      };
    `) + rejects('invalid_client_configuration'));
  });
}

for (const mode of ['early EOF', 'extra bytes', 'read error', 'success']) {
  test(`zeroes its read buffer and closes the descriptor after ${mode}`, async t => {
    const f = await fixture(t);
    run(f, `
      let readBuffer;
      let closed = false;
      ${instrumentFileHandle(`
        const originalRead = handle.read.bind(handle);
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { closed = true; return originalClose(); };
        handle.read = async (buffer, offset, length, position) => {
          readBuffer = buffer;
          const result = await originalRead(buffer, offset, length, position);
          const mode = ${JSON.stringify(mode)};
          if (mode === 'read error') throw new Error(expectedSecret);
          if (mode === 'early EOF') return { bytesRead: 0, buffer };
          if (mode === 'extra bytes' && result.bytesRead === 0) {
            buffer[offset] = 120;
            return { bytesRead: 1, buffer };
          }
          return result;
        };
      `)}
      ${mode === 'success' ? succeeds : rejects(mode === 'read error' ? 'unreadable' : 'invalid_client_configuration')}
      assert.ok(readBuffer);
      assert.ok(readBuffer.every(byte => byte === 0));
      assert.ok(closed);
    `);
  });
}
