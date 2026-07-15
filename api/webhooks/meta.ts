type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  send: (payload: string) => void;
  json: (payload: unknown) => void;
};

export const config = { api: { bodyParser: false } };

const encoder = new TextEncoder();

function stringValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function headerValue(req: ApiRequest, name: string) {
  const value = req.headers?.[name] || req.headers?.[name.toLowerCase()];
  return stringValue(value);
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

function hexToBytes(value: string) {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return new Uint8Array();
  return Uint8Array.from(value.match(/.{2}/g) || [], (byte) => Number.parseInt(byte, 16));
}

async function readRawBody(req: ApiRequest) {
  if (typeof req.body === 'string') return encoder.encode(req.body);
  if (req.body instanceof Uint8Array) return req.body;
  if (typeof req[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of req as Required<Pick<ApiRequest, typeof Symbol.asyncIterator>>) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      length += bytes.byteLength;
      if (length > 1_000_000) throw new Error('PAYLOAD_TOO_LARGE');
      chunks.push(bytes);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => { body.set(chunk, offset); offset += chunk.byteLength; });
    return body;
  }
  throw new Error('RAW_BODY_UNAVAILABLE');
}

async function validSignature(rawBody: Uint8Array, signatureHeader: string, appSecret: string) {
  if (!signatureHeader.startsWith('sha256=')) return false;
  const signature = hexToBytes(signatureHeader.slice('sha256='.length));
  if (signature.byteLength !== 32) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const body = new Uint8Array(rawBody.byteLength);
  body.set(rawBody);
  return crypto.subtle.verify('HMAC', key, signature, body.buffer);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  const appSecret = process.env.META_APP_SECRET || '';

  if (req.method === 'GET') {
    const mode = stringValue(req.query?.['hub.mode']);
    const token = stringValue(req.query?.['hub.verify_token']);
    const challenge = stringValue(req.query?.['hub.challenge']);
    if (verifyToken && mode === 'subscribe' && challenge && constantTimeEqual(token, verifyToken)) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Webhook verification failed');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!appSecret || !verifyToken) return res.status(503).json({ ok: false, error: 'Meta webhooks are not configured' });

  try {
    const rawBody = await readRawBody(req);
    if (!(await validSignature(rawBody, headerValue(req, 'x-hub-signature-256'), appSecret))) {
      return res.status(401).json({ ok: false, error: 'Invalid webhook signature' });
    }
    const payload = JSON.parse(new TextDecoder().decode(rawBody)) as { object?: string; entry?: unknown[] };
    if (!payload.object || !Array.isArray(payload.entry)) {
      return res.status(400).json({ ok: false, error: 'Invalid Meta webhook payload' });
    }

    // Signature-verified delivery is acknowledged immediately. Event routing is
    // added only after a Page has completed authorization and webhook health.
    return res.status(200).send('EVENT_RECEIVED');
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'PAYLOAD_TOO_LARGE') {
      return res.status(413).json({ ok: false, error: 'Webhook payload is too large' });
    }
    console.error('Meta webhook processing failed', cause);
    return res.status(400).json({ ok: false, error: 'Meta webhook could not be processed' });
  }
}
