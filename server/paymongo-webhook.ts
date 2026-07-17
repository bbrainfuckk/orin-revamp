import { confirmOrderPaid, extractPaidCheckout, loadPayMongoCredential, verifyPayMongoSignature } from './commerce.js';
import { booleanValue, commitWrites, documentName, fieldBoolean, fieldString, getDocument, googleAccessToken, headerValue, stableId } from './server-data.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

async function readRawBody(req: ApiRequest) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!req[Symbol.asyncIterator]) throw new Error('INVALID_BODY');
  for await (const chunk of req as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.byteLength; });
  return body;
}

export default async function paymongoWebhook(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const rawBody = await readRawBody(req);
    const paid = extractPaidCheckout(JSON.parse(new TextDecoder().decode(rawBody)) as unknown);
    if (!paid) return res.status(400).json({ ok: false, error: 'Unsupported PayMongo event' });
    const { projectId, accessToken } = await googleAccessToken();
    const routeId = `paymongo_${await stableId('paymongo-checkout', paid.sessionId)}`;
    const route = await getDocument(projectId, accessToken, `paymentRoutes/${routeId}`);
    const workspaceId = fieldString(route, 'workspaceId');
    const orderId = fieldString(route, 'orderId');
    if (!route || !workspaceId || !orderId) return res.status(404).json({ ok: false, error: 'Unknown checkout session' });
    const credential = await loadPayMongoCredential(projectId, accessToken, workspaceId);
    const signature = headerValue(req, 'paymongo-signature') || headerValue(req, 'x-paymongo-signature');
    if (paid.liveMode !== credential.liveMode || !(await verifyPayMongoSignature(rawBody, signature, credential.webhookSecret, credential.liveMode))) return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
    const order = await getDocument(projectId, accessToken, `workspaces/${workspaceId}/orders/${orderId}`);
    if (!order || (paid.reference && fieldString(order, 'reference') !== paid.reference)) return res.status(409).json({ ok: false, error: 'Checkout does not match the order' });
    if (!fieldBoolean(route, 'active')) return fieldString(order, 'status') === 'paid' ? res.status(200).json({ ok: true, received: true, alreadyPaid: true }) : res.status(409).json({ ok: false, error: 'Checkout route is inactive' });
    const result = await confirmOrderPaid(projectId, accessToken, workspaceId, orderId, 'paymongo_qrph', paid.eventId || paid.sessionId);
    await commitWrites(projectId, accessToken, [{ update: { name: documentName(projectId, `paymentRoutes/${routeId}`), fields: { active: booleanValue(false) } }, updateMask: { fieldPaths: ['active'] }, updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }], currentDocument: { exists: true } }]).catch(() => false);
    return res.status(200).json({ ok: true, received: true, alreadyPaid: result.alreadyPaid });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'PAYLOAD_TOO_LARGE') return res.status(413).json({ ok: false, error: 'Webhook payload is too large' });
    if (message === 'INVALID_BODY' || cause instanceof SyntaxError) return res.status(400).json({ ok: false, error: 'Invalid webhook payload' });
    if (message === 'PAYMONGO_NOT_CONNECTED') return res.status(503).json({ ok: false, error: 'PayMongo is not connected' });
    console.error('PayMongo webhook failed', cause);
    return res.status(500).json({ ok: false, error: 'Webhook could not be processed' });
  }
}
