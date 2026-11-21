import { Plugin } from '@opencode/plugin/effect';
import { Rpc } from '@opencode/plugin/rpc';
import { Effect } from 'effect';

const quotaReceiver = Rpc.define({
  id: 'slkiser.opencode-quota',
  methods: {
    publishQuota: {
      input: { type: 'object', properties: { providerId: { type: 'string' }, ticket: { type: 'string' }, snapshot: { type: 'object' } }, required: ['providerId'], additionalProperties: false },
      output: { type: 'object', properties: { accepted: { type: 'boolean' }, ticket: { type: 'string' } }, required: ['accepted'] },
    },
  },
  events: {},
});

type FixturePublication = { providerId: string; ticket?: string; snapshot?: object };

export function publishFixtureQuota(send: (input: FixturePublication) => Effect.Effect<unknown, unknown>) {
  return Effect.gen(function* () {
    const providerId = 'antigravity-demo';
    const reply = yield* send({ providerId });
    if (!reply || typeof reply !== 'object' || !('accepted' in reply) || reply.accepted !== true ||
        !('ticket' in reply) || typeof reply.ticket !== 'string') return;
    yield* send({
      providerId,
      ticket: reply.ticket,
      snapshot: {
        version: 'quota-v1',
        entries: [{ kind: 'percent', name: 'Demo quota', resultType: 'quota', percentRemaining: 73 }],
      },
    });
  });
}

export default Plugin.define({
  id: 'opencode-google-antigravity-oauth:quota-demo',
  effect: ctx => Effect.suspend(() => {
    const receiver = ctx.rpc(quotaReceiver);
    return Effect.sleep('2 seconds').pipe(
      Effect.andThen(publishFixtureQuota(input => receiver.publishQuota(input)).pipe(
        Effect.catch(() => Effect.void),
        Effect.andThen(Effect.sleep('30 seconds')),
        Effect.forever,
      )),
      Effect.forkScoped,
      Effect.asVoid,
    );
  }),
});
