import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectBytes } from '../dist/index.js';
import { makeElf } from './fixture.mjs';
import { makeMappedElf } from './mapping-fixture.mjs';

test('maps through moduledata RELA and PT_LOAD, not the .text section start', () => {
  const r = inspectBytes(makeMappedElf());
  const m = r.goCodeMappings[0];
  assert.equal(m.status, 'validated-link-time');
  assert.equal(m.runtimeAddressesRecovered, false);
  assert.equal(m.textLinkTimeVa, '0x20010');
  assert.equal(m.moduledataFileOffset, 1280);
  assert.equal(m.functions[0].linkTimeVaStart, '0x20010');
  assert.equal(m.functions[0].codeFileOffset, 3472);
  assert.equal(m.functions[1].codeFileEndExclusive, 3536);
  assert.equal(r.goTables[0].absoluteAddressesRecovered, false);
});

test('does not map a table without a matching moduledata relation', () => {
  assert.equal(inspectBytes(makeElf()).goCodeMappings[0].status, 'unresolved');
  const b = makeMappedElf(); b.writeBigInt64LE(0x10088n, 2064);
  assert.equal(inspectBytes(b).goCodeMappings[0].status, 'unresolved');
});

test('permits a file-backed text section to include the etext marker byte', () => {
  const b = makeMappedElf(); b.writeBigUInt64LE(0x51n, 1280 + 520);
  assert.equal(inspectBytes(b).goCodeMappings[0].status, 'validated-link-time');
});

test('rejects missing, wrong-type and duplicate anchor relocations', () => {
  for (const mutate of [
    b => b.writeBigUInt64LE(0n, 2056),
    b => b.writeBigUInt64LE(1n, 2056),
    b => b.writeBigUInt64LE(0x10500n, 2072),
    b => b.writeBigUInt64LE(0x100000008n, 2056),
  ]) {
    const b = makeMappedElf(); mutate(b);
    assert.equal(inspectBytes(b).goCodeMappings[0].status, 'unresolved');
  }
});

test('requires executable file-backed ranges, consistent endpoints and a single text map', () => {
  for (const mutate of [
    b => b.writeUInt32LE(4, 1084),
    b => b.writeBigInt64LE(0x20051n, 2048 + 8 * 24 + 16),
    b => b.writeBigUInt64LE(2n, 1280 + 368),
    b => b.writeBigInt64LE(0x20020n, 2048 + 12 * 24 + 16),
    b => b.writeBigUInt64LE(4n, 1280 + 136),
    b => b.writeBigInt64LE(0x100d0n, 2048 + 24 + 16),
    b => b.writeBigUInt64LE(0x4fn, 1280 + 520),
    b => b.writeBigUInt64LE(0x1000n, 1280 + 520),
  ]) {
    const b = makeMappedElf(); mutate(b);
    assert.equal(inspectBytes(b).goCodeMappings[0].status, 'unresolved');
  }
});

test('requires relocation coverage through PT_DYNAMIC, not just a section name', () => {
  for (const mutate of [
    b => b.writeUInt32LE(0, 1136),
    b => b.writeBigUInt64LE(0x10818n, 1208),
    b => b.writeBigUInt64LE(288n, 1224),
    b => b.writeBigUInt64LE(16n, 1240),
  ]) {
    const b = makeMappedElf(); mutate(b);
    assert.equal(inspectBytes(b).goCodeMappings[0].status, 'unresolved');
  }
});

test('leaves a second embedded table unresolved while mapping the related main table', () => {
  const b = makeMappedElf();
  makeElf().subarray(128, 528).copy(b, 2700);
  const namesSize = Number(b.readBigUInt64LE(3584 + 64 + 32));
  b.write('.embedded\0', 960 + namesSize, 'ascii');
  b.writeBigUInt64LE(BigInt(namesSize + 10), 3584 + 64 + 32);
  b.writeUInt16LE(7, 60);
  const h = 3584 + 6 * 64;
  b.writeUInt32LE(namesSize, h); b.writeUInt32LE(1, h + 4);
  b.writeBigUInt64LE(0x10a8cn, h + 16);
  b.writeBigUInt64LE(2700n, h + 24); b.writeBigUInt64LE(400n, h + 32);
  const r = inspectBytes(b);
  assert.equal(r.goCodeMappings.length, 2);
  assert.equal(r.goCodeMappings[0].status, 'validated-link-time');
  assert.equal(r.goCodeMappings[1].status, 'unresolved');
  const withUnmappedPayload = Buffer.alloc(4600);
  b.copy(withUnmappedPayload);
  b.subarray(2700, 3100).copy(withUnmappedPayload, 4200);
  withUnmappedPayload.fill(0, 2700, 3100);
  withUnmappedPayload.writeBigUInt64LE(0n, h + 16);
  withUnmappedPayload.writeBigUInt64LE(4200n, h + 24);
  const separate = inspectBytes(withUnmappedPayload);
  assert.equal(separate.goCodeMappings[0].status, 'validated-link-time');
  assert.equal(separate.goCodeMappings[1].status, 'unresolved');
});
