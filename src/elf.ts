export interface ElfSection {
  name: string;
  type: number;
  executable: boolean;
  fileOffset: number;
  size: number;
}

export function range(bytes: Buffer, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) {
    throw new Error('Invalid artifact byte range');
  }
}

function integer(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe ELF integer range');
  return Number(value);
}

export function elfSections(bytes: Buffer): ElfSection[] {
  if (bytes.length < 64 || !bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 || bytes.readUInt16LE(18) !== 62 || bytes.readUInt32LE(20) !== 1) {
    throw new Error('Expected ELF64 little-endian x86-64');
  }
  const start = integer(bytes.readBigUInt64LE(40));
  const width = bytes.readUInt16LE(58);
  const count = bytes.readUInt16LE(60);
  const namesIndex = bytes.readUInt16LE(62);
  if (width !== 64 || count < 1 || count > 4096 || namesIndex >= count || namesIndex === 0) {
    throw new Error('Unsupported ELF section header layout');
  }
  range(bytes, start, width * count);
  const namesHeader = start + namesIndex * width;
  if (bytes.readUInt32LE(namesHeader + 4) !== 3) throw new Error('Invalid ELF section-name table');
  const namesOffset = integer(bytes.readBigUInt64LE(namesHeader + 24));
  const namesSize = integer(bytes.readBigUInt64LE(namesHeader + 32));
  range(bytes, namesOffset, namesSize);
  const names = bytes.subarray(namesOffset, namesOffset + namesSize);
  const sections: ElfSection[] = [];
  for (let i = 1; i < count; i++) {
    const h = start + i * width;
    const nameOffset = bytes.readUInt32LE(h);
    const nameEnd = names.indexOf(0, nameOffset);
    if (nameOffset >= names.length || nameEnd < 0 || nameEnd - nameOffset > 128) throw new Error('Invalid ELF section-name range');
    const name = names.toString('ascii', nameOffset, nameEnd);
    if (!/^[\x20-\x7e]*$/.test(name)) throw new Error('Invalid ELF section name');
    const fileOffset = integer(bytes.readBigUInt64LE(h + 24));
    const size = integer(bytes.readBigUInt64LE(h + 32));
    const type = bytes.readUInt32LE(h + 4);
    if (type !== 8) range(bytes, fileOffset, size);
    sections.push({ name, type, executable: (bytes.readBigUInt64LE(h + 8) & 4n) !== 0n, fileOffset, size });
  }
  return sections;
}
