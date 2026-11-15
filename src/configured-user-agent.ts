import os from 'node:os';

// Copied from the local reference CLI; this static version can become outdated.
const referenceCliVersion = '1.4.11';

export function localCliUserAgent(defaultVersion = referenceCliVersion): string {
  const override = process.env.OPENCODE_AGY_CLI_VERSION;
  if (override !== undefined && (override.length > 256 || /[^\x20-\x7e]/u.test(override))) {
    throw new Error('Invalid CLI version');
  }
  const version = override?.trim() || defaultVersion;
  const platform = os.platform() === 'win32' ? 'windows' : os.platform();
  const arch = os.arch() === 'x64' ? 'amd64' : os.arch();
  return `antigravity/cli/${version} ${platform}/${arch}`;
}
