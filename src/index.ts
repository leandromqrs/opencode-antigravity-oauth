import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { elfSections } from './elf.js';
import { goTables } from './go-pclntab.js';
import { goCodeMappings } from './go-code-mapping.js';

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export interface InspectOptions { query?: string; limit?: number }

export function inspectBytes(bytes: Buffer, options: InspectOptions = {}) {
  const query = options.query ?? '';
  const limit = options.limit ?? 20;
  if (typeof query !== 'string' || query.length > 256 || /[\u0000-\u001f\u007f]/u.test(query)) throw new Error('Invalid query: maximum 256 printable characters');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid limit: expected an integer from 1 to 100');
  if (bytes.length > MAX_FILE_BYTES) throw new Error('Artifact exceeds 512 MiB byte limit');
  const sections = elfSections(bytes);
  const recovered = goTables(bytes, sections, query, limit);
  return {
    schemaVersion: 1,
    mode: 'offline-static-inspection',
    artifact: { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, format: 'elf64-le-x86_64' },
    evidenceKind: 'structured-byte-observation-not-rea-evidence',
    serviceContract: 'unverified',
    sections,
    ...recovered,
    goCodeMappings: goCodeMappings(bytes, sections, recovered.goTables),
    limitations: [
      'Metadata declares names and relative PC ranges, not execution, OAuth flow, or native call relationships.',
      'An absent or rejected table does not prove absence of Go code.',
      'Carrier sections may contain embedded payloads; table ownership is not established.',
      'The pcHeader textStart slot is not an address proof and newer Go layouts leave it unused; link-time mappings require independently validated moduledata relocations. Runtime addresses and load bias remain unknown.',
      'Only the Go 1.20-style little-endian 64-bit pclntab layout is inspected; compatibility is validated structurally, not by compiler version.',
    ],
  };
}

export async function inspectFile(path: string, options: InspectOptions = {}) {
  if (!isAbsolute(path)) throw new Error('Expected an explicit absolute binary path');
  const supplied = await lstat(path);
  if (!supplied.isFile()) throw new Error('Expected a regular file, not a symbolic link or directory');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) throw new Error('Expected a regular file within the 512 MiB byte limit');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (read.bytesRead === 0) throw new Error('Artifact changed or became incomplete while reading');
      offset += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Artifact changed while reading');
    return inspectBytes(bytes, options);
  } finally {
    await file.close();
  }
}
