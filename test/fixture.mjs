export function makeElf({ textStart = 0n } = {}) {
  const b = Buffer.alloc(1024);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(b);
  b.writeUInt16LE(3, 16);
  b.writeUInt16LE(62, 18);
  b.writeUInt32LE(1, 20);
  b.writeBigUInt64LE(768n, 40);
  b.writeUInt16LE(64, 52);
  b.writeUInt16LE(64, 58);
  b.writeUInt16LE(3, 60);
  b.writeUInt16LE(1, 62);
  b.write('\0.shstrtab\0.gopclntab\0', 64, 'ascii');
  function section(i, name, type, offset, size) {
    const p = 768 + i * 64;
    b.writeUInt32LE(name, p);
    b.writeUInt32LE(type, p + 4);
    b.writeBigUInt64LE(BigInt(offset), p + 24);
    b.writeBigUInt64LE(BigInt(size), p + 32);
  }
  section(1, 1, 3, 64, 22);
  section(2, 11, 1, 128, 400);
  b.writeUInt32LE(0xfffffff1, 128);
  b[134] = 1;
  b[135] = 8;
  [2n, 1n, textStart, 72n, 160n, 164n, 168n, 176n].forEach((v, i) => b.writeBigUInt64LE(v, 136 + i * 8));
  b.write('example/auth.getOAuthConfig\0example/auth.refreshAndSaveStoredToken\0', 200, 'ascii');
  b.writeUInt32LE(0, 304);
  b.writeUInt32LE(24, 308);
  b.writeUInt32LE(32, 312);
  b.writeUInt32LE(32, 316);
  b.writeUInt32LE(64, 320);
  b.writeUInt32LE(0, 328);
  b.writeInt32LE(0, 332);
  b.writeUInt32LE(32, 336);
  b.writeInt32LE(Buffer.byteLength('example/auth.getOAuthConfig') + 1, 340);
  return b;
}
