import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { BigIntStats } from 'node:fs';

export const AGY_CONSUMER_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

type LocalOAuthClientErrorReason = 'unreadable' | 'invalid_client_configuration';

export class LocalOAuthClientError extends Error {
  readonly reason: LocalOAuthClientErrorReason;

  constructor(reason: LocalOAuthClientErrorReason) {
    super(reason === 'unreadable'
      ? 'Local OAuth client configuration is unreadable.'
      : 'Local OAuth client configuration is invalid.');
    this.name = 'LocalOAuthClientError';
    this.reason = reason;
  }
}

function configurationPath(): string {
  const configuredHome = process.env.XDG_CONFIG_HOME;
  if (configuredHome && !isAbsolute(configuredHome)) {
    throw new LocalOAuthClientError('invalid_client_configuration');
  }
  return join(configuredHome || join(homedir(), '.config'), 'opencode', 'antigravity-oauth-client.json');
}

function validateFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.size < 0n || stats.size > 4096n) {
    throw new LocalOAuthClientError('invalid_client_configuration');
  }
  if (process.platform !== 'win32') {
    const permissions = stats.mode & 0o7777n;
    if (typeof process.getuid !== 'function'
      || stats.uid !== BigInt(process.getuid())
      || (permissions !== 0o600n && permissions !== 0o400n)) {
      throw new LocalOAuthClientError('invalid_client_configuration');
    }
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.uid === after.uid
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function parseSecret(content: string): string {
  let configuration: unknown;
  try {
    configuration = JSON.parse(content);
  } catch {
    throw new LocalOAuthClientError('invalid_client_configuration');
  }
  if (typeof configuration !== 'object' || configuration === null || Array.isArray(configuration)) {
    throw new LocalOAuthClientError('invalid_client_configuration');
  }
  const record = configuration as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('clientId') || !keys.includes('clientSecret')
    || record.clientId !== AGY_CONSUMER_CLIENT_ID
    || typeof record.clientSecret !== 'string'
    || !/^[\x21-\x7e]{35}$/.test(record.clientSecret)) {
    throw new LocalOAuthClientError('invalid_client_configuration');
  }
  return record.clientSecret;
}

export async function loadLocalConsumerSecret(): Promise<string> {
  const buffer = Buffer.alloc(4097);
  try {
    const handle = await open(configurationPath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      validateFile(before);
      const size = Number(before.size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
        if (bytesRead === 0) {
          throw new LocalOAuthClientError('invalid_client_configuration');
        }
        offset += bytesRead;
      }
      const { bytesRead } = await handle.read(buffer, size, 1, size);
      const after = await handle.stat({ bigint: true });
      validateFile(after);
      if (bytesRead !== 0 || !unchanged(before, after)) {
        throw new LocalOAuthClientError('invalid_client_configuration');
      }
      return parseSecret(buffer.toString('utf8', 0, size));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LocalOAuthClientError) throw error;
    throw new LocalOAuthClientError('unreadable');
  } finally {
    buffer.fill(0);
  }
}
