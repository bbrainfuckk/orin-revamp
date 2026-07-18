import {
  ANALYTICS_EVENT_LIMIT,
  buildAnalyticsRange,
  summarizeAnalytics,
  type AnalyticsEvent,
} from './analytics';
import {
  fieldString,
  getDocument,
  googleAccessToken,
  verifyFirebaseUid,
  type FirestoreDocument,
  type FirestoreValue,
} from './server-data';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

type RunQueryRow = { document?: FirestoreDocument };

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function validWorkspaceId(value: string) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function fieldNumber(document: FirestoreDocument, name: string) {
  const value = document.fields?.[name];
  const parsed = value?.doubleValue ?? (value?.integerValue === undefined ? Number.NaN : Number(value.integerValue));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fieldTimestamp(document: FirestoreDocument, name: string) {
  const value = document.fields?.[name]?.timestampValue || '';
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
}

function eventId(document: FirestoreDocument) {
  return document.name?.split('/').pop() || '';
}

function toAnalyticsEvent(document: FirestoreDocument): AnalyticsEvent | null {
  const occurredAt = fieldTimestamp(document, 'occurredAt');
  if (!occurredAt) return null;
  const firstResponseValue = document.fields?.firstResponseMs;
  const firstResponseMs = firstResponseValue
    ? fieldNumber({ fields: { firstResponseMs: firstResponseValue } }, 'firstResponseMs')
    : null;
  return {
    id: eventId(document),
    type: fieldString(document, 'type') || 'unknown',
    provider: fieldString(document, 'provider') || 'unknown',
    channel: fieldString(document, 'channel') || 'Unspecified',
    conversationId: fieldString(document, 'conversationId'),
    contactId: fieldString(document, 'contactId'),
    value: fieldNumber(document, 'value'),
    currency: fieldString(document, 'currency').toUpperCase(),
    firstResponseMs,
    occurredAt,
  };
}

function timestampFilter(op: 'GREATER_THAN_OR_EQUAL' | 'LESS_THAN', value: string) {
  return { fieldFilter: { field: { fieldPath: 'occurredAt' }, op, value: { timestampValue: value } as FirestoreValue } };
}

async function queryEvents(projectId: string, accessToken: string, workspaceId: string, start: string, end: string) {
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/workspaces/${encodeURIComponent(workspaceId)}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: {
      select: { fields: ['type', 'provider', 'channel', 'conversationId', 'contactId', 'value', 'currency', 'firstResponseMs', 'occurredAt'].map((fieldPath) => ({ fieldPath })) },
      from: [{ collectionId: 'events', allDescendants: false }],
      where: { compositeFilter: { op: 'AND', filters: [timestampFilter('GREATER_THAN_OR_EQUAL', start), timestampFilter('LESS_THAN', end)] } },
      orderBy: [{ field: { fieldPath: 'occurredAt' }, direction: 'DESCENDING' }],
      limit: ANALYTICS_EVENT_LIMIT + 1,
    } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('ANALYTICS_QUERY_FAILED');
  const rows = await response.json() as RunQueryRow[];
  const documents = rows.flatMap((row) => row.document ? [row.document] : []);
  const truncated = documents.length > ANALYTICS_EVENT_LIMIT;
  return {
    events: documents.slice(0, ANALYTICS_EVENT_LIMIT).flatMap((document) => {
      const event = toAnalyticsEvent(document);
      return event ? [event] : [];
    }),
    truncated,
  };
}

export async function loadAnalyticsSummary(
  projectId: string,
  accessToken: string,
  workspaceId: string,
  daysInput: unknown,
  timezoneOffsetInput: unknown,
) {
  const range = buildAnalyticsRange(daysInput, timezoneOffsetInput);
  const [current, previous] = await Promise.all([
    queryEvents(projectId, accessToken, workspaceId, range.currentStart, range.currentEnd),
    queryEvents(projectId, accessToken, workspaceId, range.previousStart, range.previousEnd),
  ]);
  return summarizeAnalytics(current.events, previous.events, range, { current: current.truncated, previous: previous.truncated });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Authorization');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const uid = await verifyFirebaseUid(req);
    const workspaceId = queryValue(req.query?.workspaceId);
    if (!validWorkspaceId(workspaceId)) return res.status(400).json({ ok: false, error: 'A valid workspace is required' });
    const { projectId, accessToken } = await googleAccessToken();
    const membership = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/members/${uid}`);
    if (!membership) return res.status(403).json({ ok: false, error: 'You do not have access to this workspace' });
    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      summary: await loadAnalyticsSummary(projectId, accessToken, workspaceId, queryValue(req.query?.days), queryValue(req.query?.timezoneOffset)),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
    }
    if (message === 'AUTH_SERVICE_UNAVAILABLE') return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    if (message.startsWith('SERVER_STORAGE_')) return res.status(503).json({ ok: false, error: 'Analytics storage is temporarily unavailable' });
    console.error('Analytics summary failed', cause);
    return res.status(500).json({ ok: false, error: 'Analytics could not be loaded' });
  }
}
