type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

type FirebaseAccountLookup = {
  users?: Array<{ localId?: string; email?: string; emailVerified?: boolean; displayName?: string; photoUrl?: string; disabled?: boolean }>;
};

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
  const payload = await response.json() as FirebaseAccountLookup;
  const account = payload.users?.[0];
  if (!account?.localId || account.disabled) throw new Error('UNAUTHENTICATED');
  return {
    uid: account.localId,
    email: account.email,
    email_verified: account.emailVerified,
    name: account.displayName,
    picture: account.photoUrl,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const identity = await verifyFirebaseRequest(req);
    return res.status(200).json({
      ok: true,
      user: {
        uid: identity.uid,
        email: identity.email || null,
        emailVerified: Boolean(identity.email_verified),
        name: identity.name || null,
        picture: identity.picture || null,
      },
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === 'AUTH_SERVICE_UNAVAILABLE') {
      return res.status(503).json({ ok: false, error: 'Session verification is temporarily unavailable' });
    }
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
  }
}
