import type { ElfSection } from './elf.js';

export interface GoFunction {
  name: string;
  tableIndex: number;
  relativePcStart: string;
  relativePcEndExclusive: string;
  metadataFileOffset: number;
  nameFileOffset: number;
}

export interface GoTable {
  section: string;
  fileOffset: number;
  format: 'go120-pclntab-le64';
  attribution: 'carrier-section-only';
  functionCount: number;
  validatedFunctions: number;
  matchCount: number;
  resultsTruncated: boolean;
  textStartDeclaration: string | null;
  absoluteAddressesRecovered: false;
  functions: GoFunction[];
}

const MAGIC = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0, 0, 1, 8]);
const MAX_FUNCTIONS = 2_000_000;
const MAX_NAME_BYTES = 4096;
const MAX_CANDIDATES = 16;
const decoder = new TextDecoder('utf-8', { fatal: true });

function redact(value: string): string {
  return value.replace(/GOCSPX-[A-Za-z0-9_-]+|ya29\.[A-Za-z0-9_.-]+/g, '[REDACTED]');
}

function readTable(bytes: Buffer, section: ElfSection, start: number, query: string, limit: number): GoTable {
  const end = section.fileOffset + section.size;
  function requireRange(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < start || offset > end - length) throw new Error('Go table range outside carrier section');
  }
  requireRange(start, 72);
  function word(index: number): number {
    const n = bytes.readBigUInt64LE(start + 8 + index * 8);
    if (n > BigInt(bytes.length)) throw new Error('Go table offset or count exceeds artifact bounds');
    return Number(n);
  }
  const count = word(0);
  if (count < 1 || count > MAX_FUNCTIONS) throw new Error('Go function count exceeds supported range');
  const names = start + word(3);
  const namesEnd = start + word(4);
  const fileTable = start + word(5);
  const pcTable = start + word(6);
  const data = start + word(7);
  if (names < start + 72 || namesEnd <= names || fileTable < namesEnd || pcTable < fileTable || data < pcTable) throw new Error('Go subtable offsets are not ordered');
  requireRange(names, namesEnd - names);
  const indexSize = count * 8 + 4;
  requireRange(data, indexSize);
  const textStart = bytes.readBigUInt64LE(start + 24);
  const functions: GoFunction[] = [];
  let matches = 0;
  let decodedNameBytes = 0;
  for (let i = 0; i < count; i++) {
    const entry = bytes.readUInt32LE(data + i * 8);
    const next = bytes.readUInt32LE(data + (i + 1) * 8);
    const funcOffset = bytes.readUInt32LE(data + i * 8 + 4);
    if (next <= entry || funcOffset < indexSize) throw new Error('Invalid Go function index ordering');
    const metadata = data + funcOffset;
    requireRange(metadata, 8);
    if (bytes.readUInt32LE(metadata) !== entry) throw new Error('Go function record disagrees with index');
    const nameOffset = bytes.readInt32LE(metadata + 4);
    if (nameOffset < 0 || nameOffset >= namesEnd - names) throw new Error('Invalid Go function name offset');
    const nameStart = names + nameOffset;
    const nameLength = bytes.subarray(nameStart, Math.min(namesEnd, nameStart + MAX_NAME_BYTES + 1)).indexOf(0);
    if (nameLength < 1 || nameLength > MAX_NAME_BYTES) throw new Error('Invalid or oversized Go function name');
    decodedNameBytes += nameLength;
    if (decodedNameBytes > 128 * 1024 * 1024) throw new Error('Go function-name decoding byte limit exceeded');
    const nameEnd = nameStart + nameLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) throw new Error('Control character in Go function name');
    if (name.includes(query)) {
      matches++;
      if (functions.length < limit) functions.push({ name: redact(name), tableIndex: i, relativePcStart: `0x${entry.toString(16)}`, relativePcEndExclusive: `0x${next.toString(16)}`, metadataFileOffset: metadata, nameFileOffset: nameStart });
    }
  }
  return { section: section.name, fileOffset: start, format: 'go120-pclntab-le64', attribution: 'carrier-section-only', functionCount: count, validatedFunctions: count, matchCount: matches, resultsTruncated: matches > functions.length, textStartDeclaration: textStart === 0n ? null : `0x${textStart.toString(16)}`, absoluteAddressesRecovered: false, functions };
}

export function goTables(bytes: Buffer, sections: ElfSection[], query: string, limit: number) {
  const tables: GoTable[] = [];
  const rejectedCandidates: { fileOffset: number; reason: string }[] = [];
  let candidates = 0;
  let scannedBytes = 0;
  for (const section of sections) {
    if (section.type !== 1 || section.executable || section.size < 72) continue;
    scannedBytes += section.size;
    if (scannedBytes > 512 * 1024 * 1024) throw new Error('Carrier-section scanning byte limit exceeded');
    const end = section.fileOffset + section.size;
    let offset = section.fileOffset;
    while ((offset = bytes.indexOf(MAGIC, offset)) >= 0 && offset <= end - MAGIC.length) {
      if (++candidates > MAX_CANDIDATES) throw new Error('Go table candidate limit exceeded');
      try {
        tables.push(readTable(bytes, section, offset, query, limit));
      } catch (error) {
        rejectedCandidates.push({ fileOffset: offset, reason: error instanceof Error ? error.message : 'Candidate failed bounded layout validation' });
      }
      offset += MAGIC.length;
    }
  }
  return { goTables: tables, rejectedCandidates };
}
