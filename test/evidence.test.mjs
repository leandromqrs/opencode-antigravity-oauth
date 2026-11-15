import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { inspectBytes } from '../dist/index.js';
import { makeElf } from './fixture.mjs';

test('recovers structured function records and original file coordinates', () => {
  const b = makeElf();
  const result = inspectBytes(b, { query: 'getOAuthConfig' });
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.artifact.sha256, createHash('sha256').update(b).digest('hex'));
  assert.equal(result.goTables.length, 1);
  const table = result.goTables[0];
  assert.equal(table.functionCount, 2);
  assert.equal(table.fileOffset, 128);
  assert.equal(table.validatedFunctions, 2);
  assert.equal(table.matchCount, 1);
  assert.deepEqual(table.functions[0], {
    name: 'example/auth.getOAuthConfig', tableIndex: 0,
    relativePcStart: '0x0', relativePcEndExclusive: '0x20',
    metadataFileOffset: 328, nameFileOffset: 200,
  });
  assert.equal(table.textStartDeclaration, null);
  assert.equal(table.absoluteAddressesRecovered, false);
  assert.equal(result.serviceContract, 'unverified');
});

test('keeps nonzero textStart as an unverified declaration, not a resolved address', () => {
  const r = inspectBytes(makeElf({ textStart: 0x1000n }));
  assert.equal(r.goTables[0].textStartDeclaration, '0x1000');
  assert.equal(r.goTables[0].absoluteAddressesRecovered, false);
  assert.equal('address' in r.goTables[0].functions[0], false);
});

test('limits delivery without truncating validation or hiding match count', () => {
  const r = inspectBytes(makeElf(), { limit: 1 });
  assert.equal(r.goTables[0].functions.length, 1);
  assert.equal(r.goTables[0].matchCount, 2);
  assert.equal(r.goTables[0].validatedFunctions, 2);
  assert.equal(r.goTables[0].resultsTruncated, true);
});

test('distinguishes no supported table from no Go code', () => {
  const b = makeElf(); b.writeUInt32LE(0, 128);
  const r = inspectBytes(b);
  assert.deepEqual(r.goTables, []);
  assert.ok(r.limitations.some(s => s.includes('does not prove')));
});

test('rejects unsafe ELF section ranges and unsupported headers', () => {
  assert.throws(() => inspectBytes(Buffer.alloc(64)), /ELF/);
  for (const [offset, value] of [[4, 1], [5, 2]]) {
    const b = makeElf(); b[offset] = value;
    assert.throws(() => inspectBytes(b), /ELF/);
  }
  const b = makeElf(); b.writeBigUInt64LE(9999999n, 920);
  assert.throws(() => inspectBytes(b), /range/);
});

test('rejects a corrupt pclntab instead of emitting plausible function names', () => {
  for (const mutate of [
    b => b.writeBigUInt64LE(2000001n, 136),
    b => b.writeBigUInt64LE(99999999n, 192),
    b => b.writeUInt32LE(99999, 308),
    b => b.writeInt32LE(-1, 332),
    b => b.writeUInt32LE(100, 304),
    b => b.writeUInt32LE(1, 328),
  ]) {
    const b = makeElf(); mutate(b);
    const r = inspectBytes(b);
    assert.equal(r.goTables.length, 0);
    assert.equal(r.rejectedCandidates.length, 1);
  }
});

test('validates query and limits at the API boundary', () => {
  for (const limit of [0, -1, 101, 1.5, NaN]) {
    assert.throws(() => inspectBytes(makeElf(), { limit }), /limit/);
  }
  assert.throws(() => inspectBytes(makeElf(), { query: 'a'.repeat(257) }), /query/);
});

test('does not treat an executable-section byte pattern as Go metadata', () => {
  const b = makeElf(); b.writeBigUInt64LE(4n, 904);
  assert.equal(inspectBytes(b).goTables.length, 0);
});

test('redacts credential-shaped data even inside a validated symbol name', () => {
  const b = makeElf();
  b.fill(0, 200, 200 + Buffer.byteLength('example/auth.getOAuthConfig') + 1);
  b.write('GOCSPX-example', 200, 'ascii');
  const report = inspectBytes(b);
  assert.equal(report.goTables[0].functions[0].name, '[REDACTED]');
  assert.equal(JSON.stringify(report).includes('GOCSPX-example'), false);
});

test('rejects names without a bounded terminator', () => {
  const b = makeElf(); b.fill(65, 200, 288);
  const report = inspectBytes(b);
  assert.equal(report.goTables.length, 0);
  assert.match(report.rejectedCandidates[0].reason, /name/);
});
