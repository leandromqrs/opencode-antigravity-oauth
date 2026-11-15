import { makeElf } from './fixture.mjs';

export function makeMappedElf() {
  const b = Buffer.alloc(4096);
  makeElf().copy(b);
  b.writeBigUInt64LE(1024n, 32);
  b.writeUInt16LE(56, 54);
  b.writeUInt16LE(3, 56);
  b.writeBigUInt64LE(3584n, 40);
  b.writeUInt16LE(6, 60);
  const names = '\0.shstrtab\0.gopclntab\0.go.module\0.rela.dyn\0.text\0';
  b.write(names, 960, 'ascii');
  function section(i, name, type, va, offset, size, flags = 0, entrySize = 0) {
    const p = 3584 + i * 64;
    b.writeUInt32LE(names.indexOf(name), p);
    b.writeUInt32LE(type, p + 4);
    b.writeBigUInt64LE(BigInt(flags), p + 8);
    b.writeBigUInt64LE(BigInt(va), p + 16);
    b.writeBigUInt64LE(BigInt(offset), p + 24);
    b.writeBigUInt64LE(BigInt(size), p + 32);
    b.writeBigUInt64LE(BigInt(entrySize), p + 56);
  }
  section(1, '.shstrtab', 3, 0x103c0, 960, names.length);
  section(2, '.gopclntab', 1, 0x10080, 128, 400);
  section(3, '.go.module', 1, 0x10500, 1280, 0x238, 3);
  section(4, '.rela.dyn', 4, 0x10800, 2048, 13 * 24, 0, 24);
  section(5, '.text', 1, 0x20000, 3456, 128, 6);
  for (const [i, flags, offset, va, size] of [[0, 6, 0, 0x10000, 3456], [1, 5, 3456, 0x20000, 128]]) {
    const p = 1024 + i * 56;
    b.writeUInt32LE(1, p); b.writeUInt32LE(flags, p + 4);
    b.writeBigUInt64LE(BigInt(offset), p + 8);
    b.writeBigUInt64LE(BigInt(va), p + 16);
    b.writeBigUInt64LE(BigInt(size), p + 32);
    b.writeBigUInt64LE(BigInt(size), p + 40);
    b.writeBigUInt64LE(1n, p + 48);
  }
  b.writeUInt32LE(2, 1136);
  b.writeBigUInt64LE(1200n, 1144);
  b.writeBigUInt64LE(0x104b0n, 1152);
  b.writeBigUInt64LE(64n, 1168);
  b.writeBigInt64LE(7n, 1200); b.writeBigUInt64LE(0x10800n, 1208);
  b.writeBigInt64LE(8n, 1216); b.writeBigUInt64LE(312n, 1224);
  b.writeBigInt64LE(9n, 1232); b.writeBigUInt64LE(24n, 1240);
  const pointers = [[0, 0x10080], [8, 0x100c8], [32, 0x10120], [56, 0x10124], [80, 0x10128], [104, 0x10130], [128, 0x10130], [160, 0x20010], [168, 0x20050], [176, 0x20010], [184, 0x20060], [360, 0x10700], [528, 0x20010]];
  pointers.forEach(([slot, addend], i) => {
    const p = 2048 + i * 24;
    b.writeBigUInt64LE(BigInt(0x10500 + slot), p);
    b.writeBigUInt64LE(8n, p + 8);
    b.writeBigInt64LE(BigInt(addend), p + 16);
  });
  b.writeBigUInt64LE(3n, 1280 + 136);
  b.writeBigUInt64LE(3n, 1280 + 144);
  b.writeBigUInt64LE(1n, 1280 + 368);
  b.writeBigUInt64LE(1n, 1280 + 376);
  b.writeBigUInt64LE(0x50n, 1280 + 520);
  b.fill(0xcc, 3456, 3584);
  return b;
}
