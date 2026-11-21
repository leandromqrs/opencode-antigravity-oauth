import { inferOffline } from 'opencode-google-antigravity-oauth/offline-inference';

const input = {
  project: 'synthetic-project', model: 'synthetic-model', requestId: 'synthetic-request',
  contents: [{ role: 'user', parts: [{ text: 'Synthetic prompt' }] }],
};

async function* fixtureTransport(body, signal) {
  const request = JSON.parse(body);
  if (signal.aborted || request.request.contents[0].parts[0].text !== 'Synthetic prompt') throw new Error('Invalid synthetic fixture');
  const responses = [
    { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic answer' }] } }] } },
    { response: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } } },
  ];
  for (const response of responses) {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(response)}\n\n`);
    for (let offset = 0; offset < bytes.length; offset += 7) yield bytes.subarray(offset, offset + 7);
  }
}

for await (const chunk of inferOffline(input, fixtureTransport)) console.log(JSON.stringify(chunk));
