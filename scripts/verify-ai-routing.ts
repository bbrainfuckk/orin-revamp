import { strict as assert } from 'node:assert';
import aiHandler from '../api/agents/ai';
import { aiProviderIds, estimateProviderGenerationCost, getAiModelCatalog } from '../server/ai-router';
import { orinConversationPersona } from '../server/orin-persona';
import { extractKnowledgeText } from '../server/knowledge-import';
import { prismAnchorKey, qorxDocumentsFromConfig, qorxPromptBlock } from '../server/qorx-client';

assert.deepEqual(aiProviderIds, ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'agentrouter', 'qwen', 'groq', 'cerebras', 'mistral', 'deepseek', 'mimo']);
assert.equal((await getAiModelCatalog('cerebras'))[0]?.id, 'cerebras/gpt-oss-120b');
assert.equal(estimateProviderGenerationCost('qwen', 'qwen/qwen3.6-flash', 1_000_000, 1_000_000), 5);
assert.equal(estimateProviderGenerationCost('qwen', 'qwen/qwen3.6-flash', 1_000, 1_000), 0.00175);
assert.match(orinConversationPersona(), /Match the customer’s latest language/);
assert.match(orinConversationPersona(), /Never deceive, pressure/);
assert.equal(qorxDocumentsFromConfig({ knowledgeNotes: 'Approved fact', qorxDocumentation: 'Current catalog' }).length, 2);
assert.equal(prismAnchorKey('openai', 'gpt-test', 'stable'), prismAnchorKey('openai', 'gpt-test', 'stable'));
assert.notEqual(prismAnchorKey('openai', 'gpt-test', 'stable'), prismAnchorKey('anthropic', 'gpt-test', 'stable'));
assert.equal(qorxPromptBlock(null), '');
assert.match(qorxPromptBlock({ engine: 'qorx-og-void-rust', coverage: 'not_found', context: '', contextKey: '', indexedTokens: 10, usedTokens: 2, omittedTokens: 8, contextReductionX: 5, quarksUsed: 0, latencyMs: 1 }), /Do not guess/);
assert.equal(extractKnowledgeText('<title>Ignore</title><script>steal()</script><p>Approved price: ₱500</p>', 'text/html'), 'Ignore\nApproved price: ₱500');
assert.match(extractKnowledgeText('{"policy":"verified"}', 'application/json'), /"verified"/);

function responseCapture() {
  let code = 0;
  let payload: unknown;
  const response = {
    setHeader: () => undefined,
    status(value: number) { code = value; return response; },
    json(value: unknown) { payload = value; },
  };
  return { response, read: () => ({ code, payload }) };
}

const ai = responseCapture();
await aiHandler({ method: 'GET', headers: {}, query: { action: 'status', workspaceId: 'personal_attacker', agentId: 'agent_12345678' } }, ai.response);
assert.equal(ai.read().code, 401);
assert.deepEqual(ai.read().payload, { ok: false, error: 'Sign in again to manage AI models.' });

const followUp = responseCapture();
await aiHandler({ method: 'POST', headers: {}, query: { action: 'followup' }, body: { workspaceId: 'personal_attacker', followUpId: 'followup_12345678' } }, followUp.response);
assert.equal(followUp.read().code, 403);
assert.deepEqual(followUp.read().payload, { ok: false, error: 'Forbidden' });

const sweep = responseCapture();
await aiHandler({ method: 'POST', headers: {}, query: { action: 'sweep' }, body: {} }, sweep.response);
assert.equal(sweep.read().code, 403);
assert.deepEqual(sweep.read().payload, { ok: false, error: 'Forbidden' });

console.log('Secure multi-model routing and scheduled follow-up boundaries passed.');
