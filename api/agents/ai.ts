import {
  aiConnectionSummary,
  aiProviderIds,
  getAiModelCatalog,
  removeAiCredential,
  storeAiCredential,
  validateAiProviderCredential,
  type AiProviderId,
} from '../../server/ai-router.js';
import { runScheduledFollowUp, runScheduledFollowUpSweep } from '../../server/followup-dispatch.js';
import { fieldInteger, fieldString, getDocument, googleAccessToken, verifyFirebaseAccount } from '../../server/server-data.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

const queryValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || '' : value || '';
const clean = (value: unknown, maximum = 500) => typeof value === 'string' ? value.trim().slice(0, maximum) : '';
const validWorkspace = (value: string) => /^[A-Za-z0-9_-]{8,200}$/.test(value);
const validAgent = (value: string) => !value || /^[A-Za-z0-9_-]{8,128}$/.test(value);
const providerSet = new Set<string>(aiProviderIds);

function requestBody(req: ApiRequest) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) as Record<string, unknown>; } catch { return {}; }
  }
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}

async function authorize(req: ApiRequest, workspaceId: string, edit = false) {
  const account = await verifyFirebaseAccount(req);
  const { projectId, accessToken } = await googleAccessToken();
  const membership = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${account.localId}`);
  const role = fieldString(membership, 'role');
  if (!membership || !(edit ? ['owner', 'admin', 'editor'] : ['owner', 'admin', 'editor', 'viewer']).includes(role)) throw new Error('FORBIDDEN');
  return { account, projectId, accessToken, role };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method === 'POST' && queryValue(req.query?.action) === 'followup') {
      return res.status(200).json(await runScheduledFollowUp(req));
    }
    if (req.method === 'POST' && queryValue(req.query?.action) === 'sweep') {
      return res.status(200).json(await runScheduledFollowUpSweep(req));
    }
    if (req.method === 'GET') {
      const workspaceId = clean(queryValue(req.query?.workspaceId), 200);
      const action = clean(queryValue(req.query?.action), 40) || 'status';
      const provider = clean(queryValue(req.query?.provider), 30).toLowerCase();
      const agentId = clean(queryValue(req.query?.agentId), 128);
      if (!validWorkspace(workspaceId) || !validAgent(agentId)) throw new Error('INVALID_REQUEST');
      const { projectId, accessToken } = await authorize(req, workspaceId);
      if (action === 'models') {
        if (provider && provider !== 'managed' && !providerSet.has(provider)) throw new Error('INVALID_PROVIDER');
        const models = await getAiModelCatalog(provider === 'managed' ? '' : provider);
        return res.status(200).json({ ok: true, models: models.slice(0, 500) });
      }
      const connections = await Promise.all(aiProviderIds.map(async (item) => aiConnectionSummary(
        await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/ai_${item}`),
        item,
      )));
      const day = new Date().toISOString().slice(0, 10);
      const usage = agentId ? await getDocument(projectId, accessToken, `workspaces/${workspaceId}/usageMeters/${day}_ai_${agentId}`) : null;
      return res.status(200).json({
        ok: true,
        managedReady: Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.CEREBRAS_API_KEY),
        connections,
        usage: usage ? { requests: fieldInteger(usage, 'requests'), inputTokens: fieldInteger(usage, 'inputTokens'), outputTokens: fieldInteger(usage, 'outputTokens'), estimatedCostUsd: Number(usage.fields?.estimatedCostUsd?.doubleValue || 0), provider: fieldString(usage, 'provider'), model: fieldString(usage, 'model') } : null,
      });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }
    const body = requestBody(req);
    const workspaceId = clean(body.workspaceId, 200);
    const action = clean(body.action, 40);
    const providerValue = clean(body.provider, 30).toLowerCase();
    if (!validWorkspace(workspaceId) || !providerSet.has(providerValue)) throw new Error('INVALID_REQUEST');
    const provider = providerValue as AiProviderId;
    const { account, projectId, accessToken } = await authorize(req, workspaceId, true);
    if (action === 'disconnect') {
      await removeAiCredential(projectId, accessToken, workspaceId, provider);
      return res.status(200).json({ ok: true, disconnected: provider });
    }
    if (action !== 'connect') throw new Error('INVALID_REQUEST');
    const apiKey = clean(body.apiKey, 8_000);
    if (apiKey.length < 8) throw new Error('INVALID_CREDENTIAL');
    await validateAiProviderCredential(provider, apiKey);
    const keyHint = await storeAiCredential({ projectId, accessToken, workspaceId, ownerId: account.localId, provider, apiKey });
    return res.status(200).json({ ok: true, provider, connected: true, keyHint });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') return res.status(401).json({ ok: false, error: 'Sign in again to manage AI models.' });
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: ['followup', 'sweep'].includes(queryValue(req.query?.action)) ? 'Forbidden' : 'You do not have permission to change AI models in this workspace.' });
    if (message === 'INVALID_REQUEST' || message === 'INVALID_PROVIDER' || message === 'INVALID_CREDENTIAL') return res.status(400).json({ ok: false, error: 'Check the provider and API key, then try again.' });
    if (message === 'AI_CREDENTIAL_REJECTED') return res.status(409).json({ ok: false, error: 'The provider rejected that API key.' });
    if (message === 'AI_MODEL_CATALOG_UNAVAILABLE' || message === 'AI_PROVIDER_UNAVAILABLE') return res.status(502).json({ ok: false, error: 'The AI provider could not be reached. Try again in a moment.' });
    console.error('AI provider setup failed', cause);
    return res.status(502).json({ ok: false, error: 'AI provider setup could not be completed.' });
  }
}
