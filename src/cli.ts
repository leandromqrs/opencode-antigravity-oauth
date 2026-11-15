#!/usr/bin/env node
import { inspectFile } from './index.js';

function argumentsFrom(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!flag || !['--binary', '--query', '--limit'].includes(flag) || flags.has(flag) || value === undefined || value.startsWith('--')) throw new Error('Expected --binary PATH [--query TEXT] [--limit 1..100]');
    flags.set(flag, value);
  }
  const path = flags.get('--binary');
  if (!path) throw new Error('An explicit --binary absolute path is required');
  const rawLimit = flags.get('--limit') ?? '20';
  if (!/^[0-9]+$/.test(rawLimit)) throw new Error('Invalid --limit');
  return { path, options: { query: flags.get('--query') ?? '', limit: Number(rawLimit) } };
}

if (process.argv.length === 3 && process.argv[2] === '--help') {
  process.stdout.write('Antigravity offline evidence inspector (does not execute binaries or authenticate)\nUsage: antigravity-offline-inspect --binary /absolute/path [--query TEXT] [--limit 1..100]\n');
} else {
  try {
    const { path, options } = argumentsFrom(process.argv.slice(2));
    const report = await inspectFile(path, options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ error: { code: 'INSPECTION_FAILED', message: 'Invalid arguments, unsupported artifact, or unstable/unreadable regular file. Use --help.' } })}\n`);
    process.exitCode = 1;
  }
}
