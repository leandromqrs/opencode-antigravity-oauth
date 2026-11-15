import assert from 'node:assert/strict';

const captures = new Set();
let originalWarn;

export function assertDiagnostic(host, validate = () => true) {
  const diagnostic = host.diagnostics.at(-1);
  assert.ok(diagnostic instanceof Error, 'expected a logged discovery diagnostic');
  assert.equal(diagnostic.cause, undefined);
  assert.equal(validate(diagnostic), true);
}

export function createProviderHost(add = () => {}, beforePublish = () => {}) {
  let transform, wake, signal;
  const queue = [];
  const diagnostics = [];
  const capture = async operation => {
    const entry = { diagnostics };
    if (!captures.size) {
      originalWarn = console.warn;
      console.warn = (prefix, diagnostic, ...rest) => {
        if (prefix !== 'Antigravity catalog discovery failed:') return originalWarn(prefix, diagnostic, ...rest);
        for (const sink of new Set([...captures].map(value => value.diagnostics))) sink.push(diagnostic);
      };
    }
    captures.add(entry);
    try { return await operation(); }
    finally {
      captures.delete(entry);
      if (!captures.size) console.warn = originalWarn;
    }
  };
  const event = {
    async *subscribe(options) {
      signal = options.signal;
      signal.addEventListener('abort', () => wake?.(), { once: true });
      while (!signal.aborted) {
        if (!queue.length) await new Promise(resolve => { wake = resolve; });
        if (signal.aborted) break;
        const item = queue.shift();
        try { yield item.event; } finally { item.done(); }
      }
      for (const item of queue.splice(0)) item.done();
    },
  };
  const publish = () => {
    beforePublish();
    let open = true;
    try {
      assert.equal(transform({ add(value) { assert.equal(open, true, 'provider editor is closed'); add(value); } }), undefined, 'provider transform must be synchronous');
    } finally { open = false; }
  };
  const emit = (type = 'credential.updated', data = {}) => capture(() => new Promise(resolve => {
    if (signal?.aborted) return resolve();
    queue.push({ event: { type, data }, done: resolve });
    wake?.();
  }));
  return {
    event, emit, publish, capture, diagnostics,
    provider: { transform: async callback => { transform = callback; publish(); return { dispose: async () => {} }; }, reload: async () => {} },
    async run() { await emit(); publish(); },
  };
}
