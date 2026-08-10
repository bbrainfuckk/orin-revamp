import {
  commitWrites,
  decryptJson,
  documentName,
  doubleValue,
  encryptJson,
  fieldInteger,
  fieldString,
  getDocument,
  integerValue,
  stringValue,
  timestampValue,
  type FirestoreDocument,
} from './server-data.js';
import { prismAnchorKey, qorxPromptBlock, resolveQorxContext, type QorxResolution } from './qorx-client.js';

export const aiProviderIds = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'agentrouter', 'qwen', 'groq', 'cerebras', 'mistral', 'deepseek', 'mimo'] as const;
export type AiProviderId = typeof aiProviderIds[number];

export type AiModelSummary = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
};

export type RoutedAgentReply = {
  reply: string;
  needs_handoff: boolean;
  reason: string;
  route?: {
    mode: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    qorx?: Pick<QorxResolution, 'engine' | 'coverage' | 'indexedTokens' | 'usedTokens' | 'omittedTokens' | 'contextReductionX' | 'quarksUsed' | 'latencyMs'>;
  };
};

type AiCredential = { provider: AiProviderId; apiKey: string; createdAt?: string };
type ChatMessage = { role: 'assistant' | 'user'; content: string };
type RoutedGeneration = {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  priceKnown: boolean;
};

type GatewayModel = {
  id?: string;
  name?: string;
  type?: string;
  context_window?: number;
  pricing?: { input?: string; output?: string };
};

const providerSet = new Set<string>(aiProviderIds);
const modelCache: { expiresAt: number; models: AiModelSummary[] } = { expiresAt: 0, models: [] };
const openAiCompatibleEndpoints: Record<Exclude<AiProviderId, 'anthropic'>, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  agentrouter: 'https://co.agentrouter.org/v1/chat/completions',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  mimo: 'https://api.xiaomimimo.com/v1/chat/completions',
};

const qwenModels = [
  { id: 'qwen-flash', name: 'Qwen Flash', contextWindow: 1_000_000, inputPrice: 0.05 / 1_000_000, outputPrice: 0.4 / 1_000_000 },
  { id: 'qwen3.6-flash', name: 'Qwen 3.6 Flash', contextWindow: 1_000_000, inputPrice: 0.25 / 1_000_000, outputPrice: 1.5 / 1_000_000 },
  { id: 'qwen3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 1_000_000, inputPrice: 0.4 / 1_000_000, outputPrice: 1.6 / 1_000_000 },
  { id: 'qwen3.7-max', name: 'Qwen 3.7 Max', contextWindow: 1_000_000, inputPrice: 2.5 / 1_000_000, outputPrice: 7.5 / 1_000_000 },
] as const;

const clean = (value: unknown, maximum = 500) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const configString = (config: Record<string, unknown>, key: string, fallback = '') => clean(config[key], 300) || fallback;
const configNumber = (config: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number) => {
  const value = Number(config[key]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
};
const configBoolean = (config: Record<string, unknown>, key: string, fallback: boolean) => typeof config[key] === 'boolean' ? config[key] as boolean : fallback;

function configStrings(config: Record<string, unknown>, key: string) {
  return Array.isArray(config[key])
    ? (config[key] as unknown[]).flatMap((value) => {
      const item = clean(value, 220);
      return item ? [item] : [];
    }).slice(0, 4)
    : [];
}

function providerFromModel(model: string) {
  const provider = model.split('/')[0]?.toLowerCase() || '';
  return providerSet.has(provider) ? provider : '';
}

function directModelId(provider: AiProviderId, model: string) {
  const normalized = clean(model, 220);
  if (provider === 'openrouter') return normalized;
  return normalized.startsWith(`${provider}/`) ? normalized.slice(provider.length + 1) : normalized;
}

function gatewayAuthorization() {
  return clean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN, 8_000);
}

export async function getAiModelCatalog(provider = '', apiKey = ''): Promise<AiModelSummary[]> {
  if (provider === 'cerebras') return [
    { id: 'cerebras/gpt-oss-120b', name: 'GPT OSS 120B', provider: 'cerebras', contextWindow: 131_072, inputPrice: 0.00000035, outputPrice: 0.00000075 },
  ];
  if (provider === 'mimo') return [
    { id: 'mimo/mimo-v2.5-pro-ultraspeed', name: 'MiMo V2.5 Pro UltraSpeed', provider: 'mimo', contextWindow: 1_000_000, inputPrice: 0.000001305, outputPrice: 0.00000261 },
    { id: 'mimo/mimo-v2.5-pro', name: 'MiMo V2.5 Pro', provider: 'mimo', contextWindow: 1_000_000, inputPrice: 0.000000435, outputPrice: 0.00000087 },
    { id: 'mimo/mimo-v2.5', name: 'MiMo V2.5', provider: 'mimo', contextWindow: 1_000_000, inputPrice: 0.00000014, outputPrice: 0.00000028 },
  ];
  if (provider === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('AI_MODEL_CATALOG_UNAVAILABLE');
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; name?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> };
    return (payload.data || []).flatMap((model) => {
      const id = clean(model.id, 220);
      if (!id) return [];
      return [{
        id,
        name: clean(model.name, 160) || id,
        provider: 'openrouter',
        contextWindow: Number(model.context_length || 0),
        inputPrice: Number(model.pricing?.prompt || 0),
        outputPrice: Number(model.pricing?.completion || 0),
      }];
    });
  }
  if (provider === 'agentrouter') {
    if (!apiKey) throw new Error('AI_CREDENTIAL_REQUIRED');
    const response = await fetch('https://co.agentrouter.org/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : 'AI_MODEL_CATALOG_UNAVAILABLE');
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string; name?: string; context_length?: number }> };
    return (payload.data || []).flatMap((model) => {
      const directId = clean(model.id, 220);
      if (!directId) return [];
      return [{ id: `agentrouter/${directId}`, name: clean(model.name, 160) || directId, provider: 'agentrouter', contextWindow: Number(model.context_length || 0), inputPrice: 0, outputPrice: 0 }];
    });
  }
  if (provider === 'qwen') {
    if (!apiKey) throw new Error('AI_CREDENTIAL_REQUIRED');
    const response = await fetch('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : 'AI_MODEL_CATALOG_UNAVAILABLE');
    const payload = await response.json().catch(() => ({})) as { data?: Array<{ id?: string }> };
    const available = new Set((payload.data || []).map((model) => clean(model.id, 220)).filter(Boolean));
    return qwenModels.filter((model) => available.has(model.id)).map((model) => ({ ...model, id: `qwen/${model.id}`, provider: 'qwen' }));
  }
  if (modelCache.expiresAt > Date.now() && modelCache.models.length) {
    return provider ? modelCache.models.filter((model) => model.provider === provider) : modelCache.models;
  }
  const response = await fetch('https://ai-gateway.vercel.sh/v1/models', { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error('AI_MODEL_CATALOG_UNAVAILABLE');
  const payload = await response.json().catch(() => ({})) as { data?: GatewayModel[] };
  modelCache.models = (payload.data || []).flatMap((model) => {
    const id = clean(model.id, 220);
    if (!id || model.type !== 'language') return [];
    return [{
      id,
      name: clean(model.name, 160) || id,
      provider: id.split('/')[0] || '',
      contextWindow: Number(model.context_window || 0),
      inputPrice: Number(model.pricing?.input || 0),
      outputPrice: Number(model.pricing?.output || 0),
    }];
  });
  modelCache.expiresAt = Date.now() + 10 * 60_000;
  return provider ? modelCache.models.filter((model) => model.provider === provider) : modelCache.models;
}

function autoModelScore(model: AiModelSummary) {
  const label = `${model.id} ${model.name}`.toLowerCase();
  const providerRank = ['google', 'openai', 'anthropic', 'xai', 'mistral', 'deepseek'].indexOf(model.provider);
  let score = (providerRank < 0 ? 20 : providerRank) * 100;
  if (/flash|mini|haiku|nano|small|fast/.test(label)) score -= 55;
  if (/coder|vision|image|audio|preview|reason|thinking|pro\b|opus/.test(label)) score += 95;
  if (model.contextWindow && model.contextWindow < 16_000) score += 200;
  score += Math.min(90, (model.outputPrice || 0) * 1_000_000);
  return score;
}

async function selectAutomaticModel(preferredProvider = '') {
  const models = await getAiModelCatalog(preferredProvider);
  return models.sort((left, right) => autoModelScore(left) - autoModelScore(right))[0] || null;
}

export async function readAiCredential(projectId: string, accessToken: string, workspaceId: string, provider: AiProviderId) {
  const [connection, vault] = await Promise.all([
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/ai_${provider}`),
    getDocument(projectId, accessToken, `workspaces/${workspaceId}/connectorVault/ai_${provider}`),
  ]);
  if (!connection || fieldString(connection, 'status') !== 'connected' || !vault) return null;
  try {
    const credential = await decryptJson<AiCredential>(fieldString(vault, 'ciphertext'), fieldString(vault, 'iv'), process.env.CONNECTOR_ENCRYPTION_KEY || '');
    return credential.provider === provider && credential.apiKey ? credential : null;
  } catch {
    return null;
  }
}

function stableSystem(system: string) {
  return `${system}\nReturn one valid JSON object with exactly reply, needs_handoff, and reason. Do not use markdown fences.`;
}

function structuredMessages(system: string, history: ChatMessage[], message: string, qorx: QorxResolution | null) {
  const proof = qorxPromptBlock(qorx);
  return [
    { role: 'system', content: stableSystem(system) },
    ...(proof ? [{ role: 'system', content: proof }] : []),
    ...history.slice(-10),
    { role: 'user', content: message },
  ];
}

function estimatedTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function generationCost(inputTokens: number, outputTokens: number, model?: AiModelSummary | null) {
  return model ? inputTokens * model.inputPrice + outputTokens * model.outputPrice : 0;
}

export function estimateProviderGenerationCost(provider: AiProviderId, modelId: string, inputTokens: number, outputTokens: number) {
  const directModel = directModelId(provider, modelId);
  if (provider === 'qwen') {
    const base = qwenModels.find((model) => model.id === directModel);
    if (!base) return null;
    const highContext = inputTokens > 256_000;
    if (!highContext) return generationCost(inputTokens, outputTokens, { ...base, id: modelId, provider });
    const tier = directModel === 'qwen3.6-flash' ? [1, 4]
      : directModel === 'qwen-flash' ? [0.25, 2]
        : directModel === 'qwen3.7-plus' ? [1.2, 4.8]
          : [2.5, 7.5];
    return inputTokens * tier[0] / 1_000_000 + outputTokens * tier[1] / 1_000_000;
  }
  const known = provider === 'cerebras' && directModel === 'gpt-oss-120b'
    ? { inputPrice: 0.35 / 1_000_000, outputPrice: 0.75 / 1_000_000 }
    : provider === 'mimo' && directModel === 'mimo-v2.5-pro-ultraspeed'
      ? { inputPrice: 1.305 / 1_000_000, outputPrice: 2.61 / 1_000_000 }
      : provider === 'mimo' && directModel === 'mimo-v2.5-pro'
        ? { inputPrice: 0.435 / 1_000_000, outputPrice: 0.87 / 1_000_000 }
        : provider === 'mimo' && directModel === 'mimo-v2.5'
          ? { inputPrice: 0.14 / 1_000_000, outputPrice: 0.28 / 1_000_000 }
          : null;
  return known ? inputTokens * known.inputPrice + outputTokens * known.outputPrice : null;
}

async function gatewayGeneration(modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number, qorx: QorxResolution | null) {
  const authorization = gatewayAuthorization();
  if (!authorization) throw new Error('AI_GATEWAY_NOT_CONFIGURED');
  const startedAt = Date.now();
  const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: structuredMessages(system, history, message, qorx),
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (!response.ok) throw new Error(response.status === 402 ? 'AI_BUDGET_EXCEEDED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const inputTokens = Number(payload.usage?.prompt_tokens || estimatedTokens(system + qorxPromptBlock(qorx) + message));
  const outputText = clean(payload.choices?.[0]?.message?.content, 4_000);
  const outputTokens = Number(payload.usage?.completion_tokens || estimatedTokens(outputText));
  const catalogModel = (await getAiModelCatalog()).find((model) => model.id === modelId);
  return { text: outputText, provider: providerFromModel(modelId) || 'gateway', model: modelId, inputTokens, outputTokens, latencyMs: Date.now() - startedAt, estimatedCostUsd: generationCost(inputTokens, outputTokens, catalogModel), priceKnown: Boolean(catalogModel) } satisfies RoutedGeneration;
}

async function anthropicGeneration(credential: AiCredential, modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number, qorx: QorxResolution | null) {
  const startedAt = Date.now();
  const proof = qorxPromptBlock(qorx);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': credential.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: directModelId('anthropic', modelId),
      system: [
        { type: 'text', text: stableSystem(system), cache_control: { type: 'ephemeral' } },
        ...(proof ? [{ type: 'text', text: proof }] : []),
      ],
      messages: [...history.slice(-10), { role: 'user', content: message }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  if (!response.ok) throw new Error(response.status === 401 ? 'AI_CREDENTIAL_REJECTED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const text = clean(payload.content?.find((part) => part.type === 'text')?.text, 4_000);
  return { text, provider: 'anthropic', model: modelId, inputTokens: Number(payload.usage?.input_tokens || estimatedTokens(system + proof + message)), outputTokens: Number(payload.usage?.output_tokens || estimatedTokens(text)), latencyMs: Date.now() - startedAt, estimatedCostUsd: 0, priceKnown: false } satisfies RoutedGeneration;
}

async function compatibleGeneration(credential: AiCredential, modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number, qorx: QorxResolution | null) {
  if (credential.provider === 'anthropic') return anthropicGeneration(credential, modelId, system, history, message, temperature, maxTokens, qorx);
  const startedAt = Date.now();
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' };
  if (credential.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://www.orin.work';
    headers['X-Title'] = 'ORIN AI';
  }
  if (credential.provider === 'cerebras') headers['X-Cerebras-Version-Patch'] = '2';
  const proof = qorxPromptBlock(qorx);
  const directModel = directModelId(credential.provider, modelId);
  const response = await fetch(openAiCompatibleEndpoints[credential.provider], {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: directModel,
      messages: structuredMessages(system, history, message, qorx),
      temperature,
      ...(credential.provider === 'mimo' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      response_format: { type: 'json_object' },
      ...(credential.provider === 'qwen' && /^qwen3\./.test(directModel) ? { enable_thinking: false } : {}),
      ...(credential.provider === 'openai' ? { prompt_cache_key: prismAnchorKey('openai', directModel, stableSystem(system)) } : {}),
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const text = clean(payload.choices?.[0]?.message?.content, 4_000);
  const inputTokens = Number(payload.usage?.prompt_tokens || estimatedTokens(system + proof + message));
  const outputTokens = Number(payload.usage?.completion_tokens || estimatedTokens(text));
  const reportedCost = Number(payload.usage?.cost);
  const estimatedCost = Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : estimateProviderGenerationCost(credential.provider, modelId, inputTokens, outputTokens);
  return { text, provider: credential.provider, model: modelId, inputTokens, outputTokens, latencyMs: Date.now() - startedAt, estimatedCostUsd: estimatedCost ?? 0, priceKnown: estimatedCost !== null } satisfies RoutedGeneration;
}

function parseStructuredReply(text: string): Omit<RoutedAgentReply, 'route'> | null {
  try {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    const parsed = JSON.parse(text.slice(first, last + 1)) as { reply?: unknown; needs_handoff?: unknown; reason?: unknown };
    const reply = clean(parsed.reply, 900);
    if (!reply || typeof parsed.needs_handoff !== 'boolean') return null;
    return { reply, needs_handoff: parsed.needs_handoff, reason: clean(parsed.reason, 200) };
  } catch {
    return null;
  }
}

function usagePath(workspaceId: string, agentId: string) {
  const day = new Date().toISOString().slice(0, 10);
  return `workspaces/${workspaceId}/usageMeters/${day}_ai_${agentId}`;
}

async function enforceDailyBudget(projectId: string, accessToken: string, workspaceId: string, agentId: string, limit: number, estimatedInput: number) {
  if (!limit) return;
  const usage = await getDocument(projectId, accessToken, usagePath(workspaceId, agentId));
  if (fieldInteger(usage, 'inputTokens') + fieldInteger(usage, 'outputTokens') + estimatedInput > limit) throw new Error('AI_DAILY_LIMIT_REACHED');
}

async function recordUsage(projectId: string, accessToken: string, workspaceId: string, agentId: string, generation: RoutedGeneration, mode: string, qorx: QorxResolution | null, feature: string, conversationId: string) {
  const path = usagePath(workspaceId, agentId);
  const now = new Date().toISOString();
  const eventPath = `workspaces/${workspaceId}/events/ai_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '')}`;
  const eventWrite = { update: { name: documentName(projectId, eventPath), fields: {
    type: stringValue('ai.generated'), provider: stringValue(generation.provider), model: stringValue(generation.model), feature: stringValue(feature), agentId: stringValue(agentId), conversationId: stringValue(conversationId), inputTokens: integerValue(generation.inputTokens), outputTokens: integerValue(generation.outputTokens), estimatedCostUsd: doubleValue(generation.estimatedCostUsd), costStatus: stringValue(generation.priceKnown ? 'estimated' : 'unavailable'), latencyMs: integerValue(generation.latencyMs), occurredAt: timestampValue(now), value: doubleValue(generation.estimatedCostUsd),
  } }, currentDocument: { exists: false } };
  const existing = await getDocument(projectId, accessToken, path);
  if (!existing) {
    const created = await commitWrites(projectId, accessToken, [{
      update: { name: documentName(projectId, path), fields: {
        kind: stringValue('ai'), agentId: stringValue(agentId), date: stringValue(now.slice(0, 10)), requests: integerValue(1), pricedRequests: integerValue(generation.priceKnown ? 1 : 0), unpricedRequests: integerValue(generation.priceKnown ? 0 : 1), inputTokens: integerValue(generation.inputTokens), outputTokens: integerValue(generation.outputTokens), estimatedCostUsd: doubleValue(generation.estimatedCostUsd), latencyMs: integerValue(generation.latencyMs), provider: stringValue(generation.provider), model: stringValue(generation.model), mode: stringValue(mode), updatedAt: timestampValue(now),
        ...(qorx ? { qorxRequests: integerValue(1), qorxIndexedTokens: integerValue(qorx.indexedTokens), qorxUsedTokens: integerValue(qorx.usedTokens), qorxOmittedTokens: integerValue(qorx.omittedTokens), qorxLatencyMs: integerValue(qorx.latencyMs), qorxEngine: stringValue(qorx.engine), qorxCoverage: stringValue(qorx.coverage) } : {}),
      } },
      currentDocument: { exists: false },
    }, eventWrite], true);
    if (created) return;
  }
  const updateFields = {
    provider: stringValue(generation.provider),
    model: stringValue(generation.model),
    mode: stringValue(mode),
    ...(qorx ? { qorxEngine: stringValue(qorx.engine), qorxCoverage: stringValue(qorx.coverage) } : {}),
  };
  const updateTransforms = [
    { fieldPath: 'requests', increment: integerValue(1) },
    { fieldPath: generation.priceKnown ? 'pricedRequests' : 'unpricedRequests', increment: integerValue(1) },
    { fieldPath: 'inputTokens', increment: integerValue(generation.inputTokens) },
    { fieldPath: 'outputTokens', increment: integerValue(generation.outputTokens) },
    { fieldPath: 'estimatedCostUsd', increment: doubleValue(generation.estimatedCostUsd) },
    { fieldPath: 'latencyMs', increment: integerValue(generation.latencyMs) },
    ...(qorx ? [
      { fieldPath: 'qorxRequests', increment: integerValue(1) },
      { fieldPath: 'qorxIndexedTokens', increment: integerValue(qorx.indexedTokens) },
      { fieldPath: 'qorxUsedTokens', increment: integerValue(qorx.usedTokens) },
      { fieldPath: 'qorxOmittedTokens', increment: integerValue(qorx.omittedTokens) },
      { fieldPath: 'qorxLatencyMs', increment: integerValue(qorx.latencyMs) },
    ] : []),
    { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
  ];
  await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, path), fields: updateFields },
    updateMask: { fieldPaths: Object.keys(updateFields) },
    updateTransforms,
    currentDocument: { exists: true },
  }, eventWrite]);
}

async function recordAiFailure(projectId: string, accessToken: string, workspaceId: string, agentId: string, provider: string, mode: string, feature: string, conversationId: string) {
  const now = new Date().toISOString();
  await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `workspaces/${workspaceId}/events/ai_failed_${Date.now().toString(36)}_${crypto.randomUUID().replaceAll('-', '')}`), fields: {
    type: stringValue('ai.failed'), provider: stringValue(provider), feature: stringValue(feature), agentId: stringValue(agentId), conversationId: stringValue(conversationId), status: stringValue('failed'), errorCode: stringValue('response_service_unavailable'), occurredAt: timestampValue(now), value: integerValue(0), mode: stringValue(mode),
  } }, currentDocument: { exists: false } }]);
}

export async function generateRoutedAgentReply(input: {
  projectId: string;
  accessToken: string;
  workspaceId: string;
  agentId: string;
  config: Record<string, unknown>;
  system: string;
  history: ChatMessage[];
  message: string;
  conversationId: string;
  feature: string;
}): Promise<RoutedAgentReply | null> {
  const mode = ['managed', 'byok'].includes(configString(input.config, 'aiMode')) ? configString(input.config, 'aiMode') : 'orin_auto';
  const selectedProvider = configString(input.config, 'aiProvider').toLowerCase();
  const provider = providerSet.has(selectedProvider) ? selectedProvider as AiProviderId : 'openai';
  const temperature = configNumber(input.config, 'aiTemperature', 0.2, 0, 1);
  const maxTokens = Math.round(configNumber(input.config, 'aiMaxOutputTokens', 260, 80, 1_200));
  const dailyLimit = Math.round(configNumber(input.config, 'aiDailyTokenLimit', 250_000, 0, 10_000_000));
  const preferredModel = configString(input.config, 'aiModel');
  const fallbackModels = configStrings(input.config, 'aiFallbackModels');
  const qorxPromise = resolveQorxContext({ projectId: input.projectId, accessToken: input.accessToken, workspaceId: input.workspaceId, agentId: input.agentId, config: input.config, query: input.message, instructions: input.system, provider, model: preferredModel })
    .catch((cause) => {
      console.warn('Qorx context unavailable', { error: cause instanceof Error ? cause.message : 'UNKNOWN' });
      return null;
    });
  const credentialPromise = mode === 'byok'
    ? readAiCredential(input.projectId, input.accessToken, input.workspaceId, provider)
    : Promise.resolve(null);
  const needsAutomaticModel = mode === 'byok'
    ? configBoolean(input.config, 'aiAllowManagedFallback', true)
    : mode === 'orin_auto' || !preferredModel;
  const automaticPromise = needsAutomaticModel
    ? selectAutomaticModel(mode === 'byok' && selectedProvider === 'openrouter' ? '' : selectedProvider).catch(() => null)
    : Promise.resolve(null);
  const [qorx, credential, automatic] = await Promise.all([qorxPromise, credentialPromise, automaticPromise]);
  await enforceDailyBudget(input.projectId, input.accessToken, input.workspaceId, input.agentId, dailyLimit, estimatedTokens(input.system + qorxPromptBlock(qorx) + input.message));

  const attempts: Array<() => Promise<RoutedGeneration>> = [];
  if (mode === 'byok') {
    if (credential && preferredModel) {
      attempts.push(() => compatibleGeneration(credential, preferredModel, input.system, input.history, input.message, temperature, maxTokens, qorx));
      fallbackModels.forEach((model) => attempts.push(() => compatibleGeneration(credential, model, input.system, input.history, input.message, temperature, maxTokens, qorx)));
    } else {
      console.warn('AI BYOK route unavailable', { provider, credentialConnected: Boolean(credential), modelConfigured: Boolean(preferredModel) });
    }
    if (configBoolean(input.config, 'aiAllowManagedFallback', true)) {
      if (automatic) attempts.push(() => gatewayGeneration(automatic.id, input.system, input.history, input.message, temperature, maxTokens, qorx));
    }
  } else {
    const primary = preferredModel || automatic?.id || '';
    if (primary) attempts.push(() => gatewayGeneration(primary, input.system, input.history, input.message, temperature, maxTokens, qorx));
    fallbackModels.forEach((model) => attempts.push(() => gatewayGeneration(model, input.system, input.history, input.message, temperature, maxTokens, qorx)));
  }

  const legacyKey = clean(process.env.CEREBRAS_API_KEY, 8_000);
  const legacyModel = clean(process.env.CEREBRAS_MODEL, 220);
  if (legacyKey && legacyModel && !(mode === 'byok' && provider === 'cerebras')) {
    attempts.push(() => compatibleGeneration({ provider: 'cerebras', apiKey: legacyKey }, legacyModel, input.system, input.history, input.message, temperature, maxTokens, qorx));
  }

  for (const attempt of attempts.slice(0, 6)) {
    try {
      const generation = await attempt();
      const parsed = parseStructuredReply(generation.text);
      if (!parsed) continue;
      await recordUsage(input.projectId, input.accessToken, input.workspaceId, input.agentId, generation, mode, qorx, input.feature, input.conversationId).catch(() => undefined);
      return { ...parsed, route: { mode, provider: generation.provider, model: generation.model, inputTokens: generation.inputTokens, outputTokens: generation.outputTokens, latencyMs: generation.latencyMs, ...(qorx ? { qorx } : {}) } };
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'AI_DAILY_LIMIT_REACHED') throw cause;
      console.warn('AI generation attempt failed', { mode, provider, error: cause instanceof Error ? cause.message : 'UNKNOWN' });
    }
  }
  await recordAiFailure(input.projectId, input.accessToken, input.workspaceId, input.agentId, provider, mode, input.feature, input.conversationId).catch(() => undefined);
  return null;
}

export async function validateAiProviderCredential(provider: AiProviderId, apiKey: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  let url = '';
  if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/models?limit=1';
    delete headers.Authorization;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'google') {
    url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(apiKey)}`;
    delete headers.Authorization;
  } else if (provider === 'openrouter') {
    url = 'https://openrouter.ai/api/v1/auth/key';
  } else if (provider === 'mimo') {
    const response = await fetch(openAiCompatibleEndpoints.mimo, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mimo-v2.5-pro-ultraspeed', messages: [{ role: 'user', content: 'Reply OK' }], max_completion_tokens: 8 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : 'AI_PROVIDER_UNAVAILABLE');
    return true;
  } else {
    const base = openAiCompatibleEndpoints[provider].replace(/\/chat\/completions$/, '').replace(/\/v1\/chat\/completions$/, '/v1');
    url = `${base}/models`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : 'AI_PROVIDER_UNAVAILABLE');
  return true;
}

export async function storeAiCredential(input: { projectId: string; accessToken: string; workspaceId: string; ownerId: string; provider: AiProviderId; apiKey: string }) {
  const now = new Date().toISOString();
  const encrypted = await encryptJson({ provider: input.provider, apiKey: input.apiKey, createdAt: now } satisfies AiCredential, process.env.CONNECTOR_ENCRYPTION_KEY || '');
  const hint = input.apiKey.length > 4 ? `••••${input.apiKey.slice(-4)}` : 'Stored';
  await commitWrites(input.projectId, input.accessToken, [
    { update: { name: documentName(input.projectId, `workspaces/${input.workspaceId}/connectorVault/ai_${input.provider}`), fields: { provider: stringValue(input.provider), ownerId: stringValue(input.ownerId), ciphertext: stringValue(encrypted.ciphertext), iv: stringValue(encrypted.iv), updatedAt: timestampValue(now) } } },
    { update: { name: documentName(input.projectId, `workspaces/${input.workspaceId}/connections/ai_${input.provider}`), fields: { provider: stringValue(`ai_${input.provider}`), category: stringValue('ai_model'), displayName: stringValue(input.provider), status: stringValue('connected'), health: stringValue('healthy'), credentialState: stringValue('stored_server_side'), connectionMode: stringValue('byok'), keyHint: stringValue(hint), connectedBy: stringValue(input.ownerId), updatedAt: timestampValue(now) } } },
  ]);
  return hint;
}

export async function removeAiCredential(projectId: string, accessToken: string, workspaceId: string, provider: AiProviderId) {
  await commitWrites(projectId, accessToken, [
    { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/ai_${provider}`) },
    { delete: documentName(projectId, `workspaces/${workspaceId}/connections/ai_${provider}`) },
  ]);
}

export function aiConnectionSummary(document: FirestoreDocument | null, provider: AiProviderId) {
  return { provider, connected: fieldString(document, 'status') === 'connected', health: fieldString(document, 'health'), keyHint: fieldString(document, 'keyHint') };
}
