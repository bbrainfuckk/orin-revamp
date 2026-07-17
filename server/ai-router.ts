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

export const aiProviderIds = ['openai', 'anthropic', 'google', 'xai', 'openrouter', 'groq', 'cerebras', 'mistral', 'deepseek', 'mimo'] as const;
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
  route?: { mode: string; provider: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number };
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
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/chat/completions',
  mimo: 'https://api.xiaomimimo.com/v1/chat/completions',
};

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

export async function getAiModelCatalog(provider = ''): Promise<AiModelSummary[]> {
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

async function readAiCredential(projectId: string, accessToken: string, workspaceId: string, provider: AiProviderId) {
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

function structuredMessages(system: string, history: ChatMessage[], message: string) {
  return [
    { role: 'system', content: `${system}\nReturn one valid JSON object with exactly reply, needs_handoff, and reason. Do not use markdown fences.` },
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

async function gatewayGeneration(modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number) {
  const authorization = gatewayAuthorization();
  if (!authorization) throw new Error('AI_GATEWAY_NOT_CONFIGURED');
  const startedAt = Date.now();
  const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: structuredMessages(system, history, message),
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; error?: { message?: string } };
  if (!response.ok) throw new Error(response.status === 402 ? 'AI_BUDGET_EXCEEDED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const inputTokens = Number(payload.usage?.prompt_tokens || estimatedTokens(system + message));
  const outputText = clean(payload.choices?.[0]?.message?.content, 4_000);
  const outputTokens = Number(payload.usage?.completion_tokens || estimatedTokens(outputText));
  const catalogModel = (await getAiModelCatalog()).find((model) => model.id === modelId);
  return { text: outputText, provider: providerFromModel(modelId) || 'gateway', model: modelId, inputTokens, outputTokens, latencyMs: Date.now() - startedAt, estimatedCostUsd: generationCost(inputTokens, outputTokens, catalogModel) } satisfies RoutedGeneration;
}

async function anthropicGeneration(credential: AiCredential, modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number) {
  const startedAt = Date.now();
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': credential.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: directModelId('anthropic', modelId),
      system: `${system}\nReturn one valid JSON object with exactly reply, needs_handoff, and reason. Do not use markdown fences.`,
      messages: [...history.slice(-10), { role: 'user', content: message }],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
  if (!response.ok) throw new Error(response.status === 401 ? 'AI_CREDENTIAL_REJECTED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const text = clean(payload.content?.find((part) => part.type === 'text')?.text, 4_000);
  return { text, provider: 'anthropic', model: modelId, inputTokens: Number(payload.usage?.input_tokens || estimatedTokens(system + message)), outputTokens: Number(payload.usage?.output_tokens || estimatedTokens(text)), latencyMs: Date.now() - startedAt, estimatedCostUsd: 0 } satisfies RoutedGeneration;
}

async function compatibleGeneration(credential: AiCredential, modelId: string, system: string, history: ChatMessage[], message: string, temperature: number, maxTokens: number) {
  if (credential.provider === 'anthropic') return anthropicGeneration(credential, modelId, system, history, message, temperature, maxTokens);
  const startedAt = Date.now();
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' };
  if (credential.provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://www.orin.work';
    headers['X-Title'] = 'ORIN AI';
  }
  if (credential.provider === 'cerebras') headers['X-Cerebras-Version-Patch'] = '2';
  const response = await fetch(openAiCompatibleEndpoints[credential.provider], {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: directModelId(credential.provider, modelId),
      messages: structuredMessages(system, history, message),
      temperature,
      ...(credential.provider === 'mimo' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(18_000),
  });
  const payload = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'AI_CREDENTIAL_REJECTED' : response.status === 429 ? 'AI_RATE_LIMITED' : 'AI_PROVIDER_UNAVAILABLE');
  const text = clean(payload.choices?.[0]?.message?.content, 4_000);
  return { text, provider: credential.provider, model: modelId, inputTokens: Number(payload.usage?.prompt_tokens || estimatedTokens(system + message)), outputTokens: Number(payload.usage?.completion_tokens || estimatedTokens(text)), latencyMs: Date.now() - startedAt, estimatedCostUsd: 0 } satisfies RoutedGeneration;
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

async function recordUsage(projectId: string, accessToken: string, workspaceId: string, agentId: string, generation: RoutedGeneration, mode: string) {
  const path = usagePath(workspaceId, agentId);
  const now = new Date().toISOString();
  const existing = await getDocument(projectId, accessToken, path);
  if (!existing) {
    const created = await commitWrites(projectId, accessToken, [{
      update: { name: documentName(projectId, path), fields: {
        kind: stringValue('ai'), agentId: stringValue(agentId), date: stringValue(now.slice(0, 10)), requests: integerValue(1), inputTokens: integerValue(generation.inputTokens), outputTokens: integerValue(generation.outputTokens), estimatedCostUsd: doubleValue(generation.estimatedCostUsd), latencyMs: integerValue(generation.latencyMs), provider: stringValue(generation.provider), model: stringValue(generation.model), mode: stringValue(mode), updatedAt: timestampValue(now),
      } },
      currentDocument: { exists: false },
    }], true);
    if (created) return;
  }
  await commitWrites(projectId, accessToken, [{
    update: { name: documentName(projectId, path), fields: { provider: stringValue(generation.provider), model: stringValue(generation.model), mode: stringValue(mode) } },
    updateMask: { fieldPaths: ['provider', 'model', 'mode'] },
    updateTransforms: [
      { fieldPath: 'requests', increment: integerValue(1) },
      { fieldPath: 'inputTokens', increment: integerValue(generation.inputTokens) },
      { fieldPath: 'outputTokens', increment: integerValue(generation.outputTokens) },
      { fieldPath: 'estimatedCostUsd', increment: doubleValue(generation.estimatedCostUsd) },
      { fieldPath: 'latencyMs', increment: integerValue(generation.latencyMs) },
      { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
    ],
    currentDocument: { exists: true },
  }]);
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
  await enforceDailyBudget(input.projectId, input.accessToken, input.workspaceId, input.agentId, dailyLimit, estimatedTokens(input.system + input.message));

  const attempts: Array<() => Promise<RoutedGeneration>> = [];
  if (mode === 'byok') {
    const credential = await readAiCredential(input.projectId, input.accessToken, input.workspaceId, provider);
    if (credential && preferredModel) {
      attempts.push(() => compatibleGeneration(credential, preferredModel, input.system, input.history, input.message, temperature, maxTokens));
      fallbackModels.forEach((model) => attempts.push(() => compatibleGeneration(credential, model, input.system, input.history, input.message, temperature, maxTokens)));
    }
    if (configBoolean(input.config, 'aiAllowManagedFallback', true)) {
      const automatic = await selectAutomaticModel(selectedProvider === 'openrouter' ? '' : selectedProvider).catch(() => null);
      if (automatic) attempts.push(() => gatewayGeneration(automatic.id, input.system, input.history, input.message, temperature, maxTokens));
    }
  } else {
    const automatic = mode === 'orin_auto' || !preferredModel ? await selectAutomaticModel(selectedProvider).catch(() => null) : null;
    const primary = preferredModel || automatic?.id || '';
    if (primary) attempts.push(() => gatewayGeneration(primary, input.system, input.history, input.message, temperature, maxTokens));
    fallbackModels.forEach((model) => attempts.push(() => gatewayGeneration(model, input.system, input.history, input.message, temperature, maxTokens)));
  }

  const legacyKey = clean(process.env.CEREBRAS_API_KEY, 8_000);
  const legacyModel = clean(process.env.CEREBRAS_MODEL, 220);
  if (legacyKey && legacyModel && !(mode === 'byok' && provider === 'cerebras')) {
    attempts.push(() => compatibleGeneration({ provider: 'cerebras', apiKey: legacyKey }, legacyModel, input.system, input.history, input.message, temperature, maxTokens));
  }

  for (const attempt of attempts.slice(0, 6)) {
    try {
      const generation = await attempt();
      const parsed = parseStructuredReply(generation.text);
      if (!parsed) continue;
      await recordUsage(input.projectId, input.accessToken, input.workspaceId, input.agentId, generation, mode).catch(() => undefined);
      return { ...parsed, route: { mode, provider: generation.provider, model: generation.model, inputTokens: generation.inputTokens, outputTokens: generation.outputTokens, latencyMs: generation.latencyMs } };
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'AI_DAILY_LIMIT_REACHED') throw cause;
    }
  }
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
