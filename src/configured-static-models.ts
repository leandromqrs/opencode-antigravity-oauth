import { Model, Provider } from '@opencode/plugin';
import { LOCAL_PROVIDER_ID, groupEffortModels } from './configured-catalog.js';

export function staticFallbackModels(): readonly Model.Info[] {
  const entries = [
    ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash', 1048576, 65536],
    ['gemini-4-argon-medium', 'Gemini 4 Argon', 1048576, 65536],
    ['claude-opus-5-5-medium', 'Claude Opus 5.5', 1000000, 128000],
    ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5', 1000000, 128000],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', 131072, 32768],
  ] as const;
  return groupEffortModels(entries.map(([id, name, context, output]) => ({
    id: Model.ID.make(id), modelID: Model.ID.make(id), providerID: Provider.ID.make(LOCAL_PROVIDER_ID),
    name: `${name} (static estimate; entitlement unverified)`,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 },
    cost: [], status: 'active', enabled: true, limit: { context, output },
  })));
}
