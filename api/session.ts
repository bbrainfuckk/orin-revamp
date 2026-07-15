import { verifyFirebaseRequest } from '../server/firebase-admin';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

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
  } catch {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ ok: false, error: 'A valid ORIN AI session is required' });
  }
}
