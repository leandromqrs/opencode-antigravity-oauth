import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect } from 'effect';
import { publishFixtureQuota } from '../dist/offline-quota-publication.js';

test('does not submit a synthetic balance without an accepted ticket', async () => {
  const calls = [];
  const receiver = input => Effect.sync(() => {
    calls.push(input);
    return { accepted: true };
  });
  await Effect.runPromise(publishFixtureQuota(receiver));
  assert.deepEqual(calls, [{ providerId: 'antigravity-demo' }]);
});

test('submits only a synthetic quota row with the receiver ticket', async () => {
  const calls = [];
  const receiver = input => Effect.sync(() => {
    calls.push(input);
    return { accepted: true, ticket: 'fixture-ticket' };
  });
  await Effect.runPromise(publishFixtureQuota(receiver));
  assert.deepEqual(calls[1], {
    providerId: 'antigravity-demo',
    ticket: 'fixture-ticket',
    snapshot: {
      version: 'quota-v1',
      entries: [{ kind: 'percent', name: 'Demo quota', resultType: 'quota', percentRemaining: 73 }],
    },
  });
});
