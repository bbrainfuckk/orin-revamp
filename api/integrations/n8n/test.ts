type TestBody = { webhookUrl?: string; workspaceId?: string };
type ApiRequest = { method?: string; headers?: Record<string, string | string[] | undefined>; body?: TestBody | string };
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

type FirebaseAccountLookup = { users?: Array<{ localId?: string; disabled?: boolean }> };
const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

async function verifyFirebaseRequest(req: ApiRequest) {
  const header = req.headers?.authorization;
  const authorization = Array.isArray(header) ? header[0] : header;
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('UNAUTHENTICATED');

  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token }),
      signal: AbortSignal.timeout(6_000),
    });
  } catch {
    throw new Error('AUTH_SERVICE_UNAVAILABLE');
  }
  if (!response.ok) throw new Error('UNAUTHENTICATED');
  const account = ((await response.json()) as FirebaseAccountLookup).users?.[0];
  if (!account?.localId || account.disabled) throw new Error('UNAUTHENTICATED');
  return { uid: account.localId };
}

function validateN8nCloudWebhook(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_WEBHOOK_URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_WEBHOOK_URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.port && url.port !== '443')
    || (hostname !== 'n8n.cloud' && !hostname.endsWith('.n8n.cloud'))
  ) throw new Error('INVALID_WEBHOOK_URL');
  return url;
}

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

    const webhookUrl = validateN8nCloudWebhook(body.webhookUrl);
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
    if (message === 'AUTH_SERVICE_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    }
    if (message === 'INVALID_WEBHOOK_URL') {
      return res.status(400).json({ ok: false, error: 'Use a valid n8n Cloud HTTPS webhook URL. Self-hosted n8n support is coming soon.' });
    }
    if (cause instanceof Error && cause.name === 'TimeoutError') {
      return res.status(504).json({ ok: false, error: 'The n8n webhook did not respond within 8 seconds' });
    }
    console.error('n8n connection test failed', cause);
    return res.status(502).json({ ok: false, error: 'ORIN AI could not reach the n8n webhook' });
  }
}
