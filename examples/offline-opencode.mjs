import { make } from '@opencode/ai';
import { createOfflineModel } from 'opencode-google-antigravity-oauth/offline-opencode';

const model = createOfflineModel({
  provider: 'synthetic-offline', model: 'synthetic-model', project: 'synthetic-project', requestId: 'synthetic-request',
  textSemantics: 'delta', usageSemantics: 'single-report',
  transport: async function* (body, signal) {
    if (signal.aborted || !JSON.parse(body).request.contents.length) throw new Error('Invalid synthetic input');
    for (const response of [
      { candidates: [{ content: { parts: [{ text: 'Synthetic native answer' }] } }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, totalTokenCount: 5 } },
    ]) yield new TextEncoder().encode(`data: ${JSON.stringify({ response })}\n\n`);
  },
});

const ai = make();
console.log((await ai.generate({ model, prompt: 'Synthetic prompt' })).text);
for await (const event of ai.stream({ model, prompt: 'Synthetic prompt' })) console.log(JSON.stringify(event));
