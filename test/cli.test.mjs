import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeElf } from './fixture.mjs';

function run(...args) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8', timeout: 10000 });
}

test('help requires no binary or private user state', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /offline/);
});

test('CLI reads the explicitly supplied artifact without executing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-offline-test-'));
  try {
    const file = join(dir, 'synthetic.elf');
    await writeFile(file, makeElf(), { mode: 0o600 });
    const r = run('--binary', file, '--query', 'refresh');
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(r.stdout);
    assert.equal(report.goTables[0].matchCount, 1);
    assert.equal(report.goTables[0].functions[0].name, 'example/auth.refreshAndSaveStoredToken');
    const link = join(dir, 'link.elf'); await symlink(file, link);
    assert.equal(run('--binary', link).status, 1);
    assert.equal(run('--binary', dir).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('CLI fails closed on missing, duplicate, unknown and relative arguments', () => {
  for (const args of [[], ['--binary', 'relative'], ['--unknown'], ['--binary', '/none', '--binary', '/other'], ['--binary', '/none', '--limit', '1e2'], ['--query']]) {
    const r = run(...args);
    assert.equal(r.status, 1);
    assert.equal(JSON.parse(r.stderr).error.code, 'INSPECTION_FAILED');
  }
});
