import assert from 'node:assert/strict';
import { test } from 'node:test';
import { make } from '@opencode/ai';
import { createOfflineModel } from 'opencode-antigravity-oauth/offline-opencode';

const ai = make();
const config = transport => ({ provider: 'synthetic-offline', model: 'synthetic-model', project: 'synthetic-project',
  requestId: 'synthetic-request', textSemantics: 'delta', usageSemantics: 'single-report', transport });
const frame = response => new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
const candidate = (text, finishReason) => ({ candidates: [{ ...(text === undefined ? {} : { content: { parts: [{ text }] } }), ...(finishReason ? { finishReason } : {}) }] });
const fixture = (...responses) => async function* () { for (const response of responses) yield frame(response); };
const TRIGGER = 'tools.opencode.session_move';
const REPLACEMENT = 'the opencode session_move tool';
const capture = () => { const state = { body: undefined }; const model = createOfflineModel(config(async function* (request) {
  state.body = JSON.parse(request); yield frame(candidate('OK', 'STOP'));
  yield frame({ usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1, totalTokenCount: 1 } });
})); return { model, state }; };
const systemText = body => (body.request.systemInstruction?.parts ?? []).map(p => p.text).join('\n');

test('system instruction neutralizes the remote-filtered session_move reference', async () => {
  const { model, state } = capture();
  await ai.generate({ model, system: `Before ${TRIGGER} after.`, prompt: 'x' });
  const text = systemText(state.body);
  assert.ok(!text.includes(TRIGGER), 'trigger must not reach the wire');
  assert.ok(text.includes(REPLACEMENT), 'equivalent description preserved');
  assert.ok(text.includes('Before ') && text.includes(' after.'), 'surrounding rules preserved');
});

test('only the filtered reference changes; other tool paths and rules stay intact', async () => {
  const { model, state } = capture();
  const system = `Use tools.opencode.worktree_list and tools.openchamber.session_create. Also ${TRIGGER}.`;
  await ai.generate({ model, system, prompt: 'x' });
  const text = systemText(state.body);
  assert.ok(text.includes('tools.opencode.worktree_list'));
  assert.ok(text.includes('tools.openchamber.session_create'));
  assert.ok(!text.includes(TRIGGER));
});

test('multi-part system neutralizes each part without touching user history', async () => {
  const { model, state } = capture();
  await ai.generate({ model, system: [{ type: 'text', text: `part one ${TRIGGER}` }, { type: 'text', text: 'part two clean' }],
    prompt: `user mentions ${TRIGGER} verbatim` });
  const text = systemText(state.body);
  assert.ok(!text.includes(TRIGGER));
  assert.ok(text.includes('part two clean'));
  const userText = state.body.request.contents.flatMap(c => c.parts).map(p => p.text).join('\n');
  assert.ok(userText.includes(TRIGGER), 'user/history text must remain byte-for-byte intact');
});

test('system-role message wrapped as system-update is neutralized too', async () => {
  const { model, state } = capture();
  await ai.generate({ model, prompt: 'x', messages: [{ role: 'system', content: [{ type: 'text', text: `note ${TRIGGER}` }] }] });
  const wire = JSON.stringify(state.body.request.contents);
  assert.ok(!wire.includes(TRIGGER));
  assert.ok(wire.includes('system-update'));
  assert.ok(wire.includes(REPLACEMENT));
});

test('benign system instruction passes through unchanged', async () => {
  const { model, state } = capture();
  const system = 'You are a coding assistant. Use tools.opencode.worktree_list.';
  await ai.generate({ model, system, prompt: 'x' });
  assert.equal(systemText(state.body), system);
});
