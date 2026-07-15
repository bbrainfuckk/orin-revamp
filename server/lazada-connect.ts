import {
  commitWrites,
  documentName,
  getDocument,
  googleAccessToken,
  verifyFirebaseUid,
  type FirestoreDocument,
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

type FirestoreRunQueryRow = { document?: FirestoreDocument };

function requestBody(req: ApiRequest) {
  try {
    return (typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}) as { workspaceId?: string };
  } catch {
    throw new Error('INVALID_REQUEST');
  }
}

function fieldStringArray(document: FirestoreDocument | null, name: string) {
  return (document?.fields?.[name]?.arrayValue?.values || []).flatMap((value) => value.stringValue ? [value.stringValue] : []);
}

async function conversationRouteNames(projectId: string, accessToken: string, workspaceId: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'conversationRoutes' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'workspaceId' }, op: 'EQUAL', value: { stringValue: workspaceId } } },
        { fieldFilter: { field: { fieldPath: 'provider' }, op: 'EQUAL', value: { stringValue: 'lazada' } } },
      ] } },
      limit: 250,
    } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return [];
  const rows = await response.json() as FirestoreRunQueryRow[];
  return rows.flatMap((row) => row.document?.name ? [row.document.name] : []);
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
    const connection = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/connections/lazada`);
    const routeIds = fieldStringArray(connection, 'routeIds').filter((routeId) => /^lazada_seller_[A-Za-z0-9_-]{40}$/.test(routeId));
    const privateConversationRoutes = await conversationRouteNames(projectId, accessToken, workspaceId);
    await commitWrites(projectId, accessToken, [
      { delete: documentName(projectId, `workspaces/${workspaceId}/connections/lazada`) },
      { delete: documentName(projectId, `workspaces/${workspaceId}/connectorVault/lazada`) },
      ...routeIds.map((routeId) => ({ delete: documentName(projectId, `connectorRoutes/${routeId}`) })),
      ...privateConversationRoutes.map((name) => ({ delete: name })),
    ]);
    return res.status(200).json({ ok: true, status: 'disconnected' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message === 'INVALID_REQUEST') return res.status(400).json({ ok: false, error: 'Invalid request' });
    console.error('Lazada disconnect failed', cause);
    return res.status(502).json({ ok: false, error: 'The Lazada connection could not be removed.' });
  }
}
