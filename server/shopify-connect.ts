import {
  commitWrites,
  documentName,
  fieldString,
  getDocument,
  googleAccessToken,
  verifyFirebaseUid,
} from './server-data';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: { workspaceId?: string } | string;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

function requestBody(req: ApiRequest) {
  try {
    return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) as { workspaceId?: string };
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'DELETE') {
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const body = requestBody(req);
    const uid = await verifyFirebaseUid(req);
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
    if (workspaceId !== `personal_${uid}`) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    const { projectId, accessToken } = await googleAccessToken();
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/shopify`);
    const routeId = fieldString(connection, 'routeId');
    const writes: unknown[] = [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/shopify`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/shopify`) },
    ];
    if (/^shopify_[A-Za-z0-9_-]{40}$/.test(routeId)) writes.push({ delete: documentName(projectId, `connectorRoutes/${routeId}`) });
    await commitWrites(projectId, accessToken, writes);
    return res.status(200).json({ ok: true, status: 'disconnected' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST') return res.status(400).json({ ok: false, error: 'Invalid request' });
    console.error('Shopify disconnect failed', cause);
    return res.status(502).json({ ok: false, error: 'The Shopify connection could not be removed.' });
  }
}
