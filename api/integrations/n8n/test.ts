import { verifyFirebaseRequest } from '../../../server/firebase-admin';
import { validatePublicWebhookUrl } from '../../../server/safe-webhook';

type TestBody = { webhookUrl?: string; workspaceId?: string };
type ApiRequest = { method?: string; headers?: Record<string, string | string[] | undefined>; body?: TestBody | string };
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const identity = await verifyFirebaseRequest(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) as TestBody : req.body || {};
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';

    // Personal workspaces use a deterministic owner-scoped id. Team-workspace
    // membership verification will replace this guard when team invites launch.
    if (workspaceId !== `personal_${identity.uid}`) {
      return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    }

    const webhookUrl = await validatePublicWebhookUrl(body.webhookUrl);
    const n8nCloudHost = webhookUrl.hostname === 'n8n.cloud' || webhookUrl.hostname.endsWith('.n8n.cloud');
    if (!n8nCloudHost) {
      return res.status(400).json({ ok: false, error: 'Use an n8n Cloud webhook URL. Self-hosted n8n support is coming soon.' });
    }
    const delivery = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ORIN-AI-Connector-Test/1.0',
        'X-ORIN-Event': 'connection.test',
      },
      body: JSON.stringify({
        event: 'connection.test',
        source: 'ORIN AI',
        workspace_id: workspaceId,
        sent_at: new Date().toISOString(),
        data: { message: 'ORIN AI reached this n8n webhook successfully.' },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });

    if (!delivery.ok) {
      return res.status(502).json({ ok: false, error: `The n8n webhook returned HTTP ${delivery.status}` });
    }

    return res.status(200).json({ ok: true, status: delivery.status });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'INVALID_WEBHOOK_URL' || message === 'PRIVATE_WEBHOOK_URL') {
      return res.status(400).json({ ok: false, error: 'Enter a public HTTPS n8n webhook URL' });
    }
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      return res.status(504).json({ ok: false, error: 'The n8n webhook did not respond within 8 seconds' });
    }
    console.error('n8n connection test failed', cause);
    return res.status(502).json({ ok: false, error: 'ORIN AI could not reach the n8n webhook' });
  }
}
