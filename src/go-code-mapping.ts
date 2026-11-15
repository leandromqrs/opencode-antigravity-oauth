import { range, type ElfSection } from './elf.js';
import type { GoTable } from './go-pclntab.js';

interface LoadSegment { index: number; flags: number; fileOffset: number; va: number; size: number }
interface Relocation { addend: number; fileOffset: number }

function integer(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported mapping integer');
  return Number(value);
}

function hex(value: number): string { return `0x${value.toString(16)}`; }

function recover(bytes: Buffer, sections: ElfSection[], tables: GoTable[]) {
  if (bytes.readUInt16LE(16) !== 3) throw new Error('Mapping profile requires ET_DYN');
  const ph = integer(bytes.readBigUInt64LE(32));
  const width = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  if (width !== 56 || count < 1 || count > 1024) throw new Error('Unsupported program-header layout');
  range(bytes, ph, count * width);
  const loads: LoadSegment[] = [];
  const dynamics: { fileOffset: number; va: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const p = ph + i * width;
    if (bytes.readUInt32LE(p) === 2) dynamics.push({ fileOffset: integer(bytes.readBigUInt64LE(p + 8)), va: integer(bytes.readBigUInt64LE(p + 16)), size: integer(bytes.readBigUInt64LE(p + 32)) });
    if (bytes.readUInt32LE(p) !== 1) continue;
    const fileOffset = integer(bytes.readBigUInt64LE(p + 8));
    const va = integer(bytes.readBigUInt64LE(p + 16));
    const size = integer(bytes.readBigUInt64LE(p + 32));
    const memorySize = integer(bytes.readBigUInt64LE(p + 40));
    if (size > memorySize || !Number.isSafeInteger(va + memorySize)) throw new Error('Invalid load-segment range');
    range(bytes, fileOffset, size);
    loads.push({ index: i, flags: bytes.readUInt32LE(p + 4), fileOffset, va, size });
  }
  function fileAt(va: number, length: number, executable = false) {
    const matching = loads.filter(s => va >= s.va && length > 0 && va - s.va <= s.size - length);
    if (matching.length !== 1) throw new Error('Ambiguous or absent file-backed load segment');
    const segment = matching[0]!;
    if (executable && !(segment.flags & 1)) throw new Error('Code range is not executable');
    return { fileOffset: segment.fileOffset + va - segment.va, segmentIndex: segment.index };
  }
  function vaAt(fileOffset: number, length: number): number {
    const matching = loads.filter(s => fileOffset >= s.fileOffset && fileOffset - s.fileOffset <= s.size - length);
    if (matching.length !== 1) throw new Error('Ambiguous file-to-VA relation');
    return matching[0]!.va + fileOffset - matching[0]!.fileOffset;
  }
  const modules = sections.filter(s => s.name === '.go.module' && s.type === 1);
  if (modules.length !== 1 || modules[0]!.size < 384) throw new Error('No unique supported .go.module prefix');
  const module = modules[0]!;
  const moduleVa = vaAt(module.fileOffset, module.size);
  const sh = integer(bytes.readBigUInt64LE(40));
  const moduleIndex = sections.indexOf(module) + 1;
  if (integer(bytes.readBigUInt64LE(sh + moduleIndex * 64 + 16)) !== moduleVa) throw new Error('Module section VA disagrees with PT_LOAD');
  const slots = [0, 8, 32, 56, 80, 104, 128, 160, 168, 176, 184, 360];
  const relocationSections = sections.filter(s => s.type === 4);
  if (sections.some(s => s.type === 9 || s.type === 19)) throw new Error('Mixed REL/RELR profiles are not supported');
  if (dynamics.length !== 1) throw new Error('No unique PT_DYNAMIC relocation source');
  const dynamic = dynamics[0]!;
  if (dynamic.size < 16 || dynamic.size > 64 * 1024 || dynamic.size % 16 !== 0 || fileAt(dynamic.va, dynamic.size).fileOffset !== dynamic.fileOffset) throw new Error('Invalid PT_DYNAMIC range');
  const tags = new Map<number, number>();
  let terminated = false;
  for (let p = dynamic.fileOffset; p < dynamic.fileOffset + dynamic.size; p += 16) {
    const tag = integer(bytes.readBigUInt64LE(p));
    if (tag === 0) { terminated = true; break; }
    if (![7, 8, 9].includes(tag)) continue;
    if (tags.has(tag)) throw new Error('Duplicate dynamic relocation tag');
    tags.set(tag, integer(bytes.readBigUInt64LE(p + 8)));
  }
  const dynamicRelocations = relocationSections.filter(s => vaAt(s.fileOffset, s.size) === tags.get(7) && s.size === tags.get(8));
  if (!terminated || tags.get(9) !== 24 || dynamicRelocations.length !== 1) throw new Error('DT_RELA coverage does not match a supported relocation table');
  let entries = 0;
  for (const section of relocationSections) {
    const i = sections.indexOf(section) + 1;
    if (bytes.readBigUInt64LE(sh + i * 64 + 56) !== 24n || section.size % 24 !== 0) throw new Error('Unsupported RELA entry layout');
    entries += section.size / 24;
  }
  if (entries > 2_000_000) throw new Error('Relocation entry budget exceeded');
  function relocationsFor(destinations: Set<number>): Map<number, Relocation> {
    const result = new Map<number, Relocation>();
    for (const section of relocationSections) {
      for (let p = section.fileOffset; p < section.fileOffset + section.size; p += 24) {
        const destination = bytes.readBigUInt64LE(p);
        if (destination > BigInt(Number.MAX_SAFE_INTEGER) || !destinations.has(Number(destination))) continue;
        const address = Number(destination);
        if (result.has(address) || bytes.readBigUInt64LE(p + 8) !== 8n) throw new Error('Ambiguous or unsupported anchor relocation');
        fileAt(address, 8);
        result.set(address, { addend: integer(bytes.readBigInt64LE(p + 16)), fileOffset: p });
      }
    }
    if (result.size !== destinations.size) throw new Error('Missing required moduledata relocation');
    return result;
  }
  const anchors = relocationsFor(new Set(slots.map(s => moduleVa + s)));
  function requireDynamicRelocations(records: Map<number, Relocation>): void {
    const section = dynamicRelocations[0]!;
    if ([...records.values()].some(r => r.fileOffset < section.fileOffset || r.fileOffset >= section.fileOffset + section.size)) throw new Error('Anchor relocation is not covered by DT_RELA');
  }
  requireDynamicRelocations(anchors);
  const pointer = (slot: number) => anchors.get(moduleVa + slot)!.addend;
  const word = (slot: number) => integer(bytes.readBigUInt64LE(module.fileOffset + slot));
  const headerFile = fileAt(pointer(0), 72).fileOffset;
  const matching = tables.filter(t => t.fileOffset === headerFile);
  if (matching.length !== 1) throw new Error('No unique pcHeader relation to a validated table');
  const table = matching[0]!;
  const headerVa = pointer(0);
  for (const [slot, headerWord] of [[8, 3], [32, 4], [56, 5], [80, 6], [104, 7], [128, 7]] as const) {
    const offset = integer(bytes.readBigUInt64LE(table.fileOffset + 8 + headerWord * 8));
    if (pointer(slot) !== headerVa + offset) throw new Error('Module subtable anchor disagrees with pcHeader');
  }
  if (word(136) !== table.functionCount + 1 || word(144) !== word(136)) throw new Error('Module function-index length mismatch');
  const index = fileAt(pointer(128), table.functionCount * 8 + 4).fileOffset;
  const text = pointer(176);
  const etext = pointer(184);
  const first = bytes.readUInt32LE(index);
  const last = bytes.readUInt32LE(index + table.functionCount * 8);
  if (text + first !== pointer(160) || text + last !== pointer(168) || etext < text + last || etext <= text) throw new Error('Module text bounds disagree with function index');
  fileAt(text, etext - text, true);
  if (word(368) !== 1 || word(376) !== 1) throw new Error('Only a single text-section map is supported');
  const textMap = pointer(360);
  const textMapFile = fileAt(textMap, 24).fileOffset;
  const mappedTextSize = integer(bytes.readBigUInt64LE(textMapFile + 8));
  if (bytes.readBigUInt64LE(textMapFile) !== 0n || mappedTextSize < etext - text) throw new Error('Text-section map has incompatible virtual bounds');
  fileAt(text, mappedTextSize, true);
  const base = relocationsFor(new Set([textMap + 16]));
  requireDynamicRelocations(base);
  if (base.get(textMap + 16)!.addend !== text) throw new Error('Text-section relocation disagrees with module text');
  const functions = table.functions.map(f => {
    const start = text + Number(BigInt(f.relativePcStart));
    const end = text + Number(BigInt(f.relativePcEndExclusive));
    const file = fileAt(start, end - start, true);
    return { tableIndex: f.tableIndex, linkTimeVaStart: hex(start), linkTimeVaEndExclusive: hex(end), codeFileOffset: file.fileOffset, codeFileEndExclusive: file.fileOffset + end - start, loadSegmentIndex: file.segmentIndex };
  });
  return {
    tableFileOffset: table.fileOffset,
    status: 'validated-link-time' as const,
    profile: 'elf64-rela-moduledata-single-text' as const,
    runtimeAddressesRecovered: false as const,
    moduledataFileOffset: module.fileOffset,
    moduledataLinkTimeVa: hex(moduleVa),
    textLinkTimeVa: hex(text),
    textEndLinkTimeVa: hex(etext),
    dynamicTableFileOffset: dynamic.fileOffset,
    relocationFileOffsets: [...anchors.values(), ...base.values()].map(r => r.fileOffset),
    functions,
  };
}

export function goCodeMappings(bytes: Buffer, sections: ElfSection[], tables: GoTable[]) {
  let recovered: ReturnType<typeof recover> | undefined;
  let reason = 'No moduledata relation to this table; embedded payload ownership is not inferred';
  try { recovered = recover(bytes, sections, tables); }
  catch (error) { reason = error instanceof Error ? error.message : 'Unsupported moduledata mapping'; }
  return tables.map(t => recovered?.tableFileOffset === t.fileOffset ? recovered : {
    tableFileOffset: t.fileOffset, status: 'unresolved' as const, runtimeAddressesRecovered: false as const,
    reason: recovered ? 'No moduledata relation to this table; embedded payload ownership is not inferred' : reason,
  });
}
