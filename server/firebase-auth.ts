type RequestWithHeaders = {
  headers?: Record<string, string | string[] | undefined>;
};

type FirebaseAccount = {
  localId?: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoUrl?: string;
  disabled?: boolean;
};

type FirebaseAccountLookup = {
  users?: FirebaseAccount[];
};

export type AuthenticatedIdentity = {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
};

const apiKey = process.env.FIREBASE_WEB_API_KEY
  || process.env.VITE_FIREBASE_API_KEY
  || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk';

function authorizationHeader(req: RequestWithHeaders) {
  const value = req.headers?.authorization;
  return Array.isArray(value) ? value[0] : value;
}

export async function verifyFirebaseRequest(req: RequestWithHeaders): Promise<AuthenticatedIdentity> {
  const authorization = authorizationHeader(req);
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('UNAUTHENTICATED');

  let response: Response;
  try {
    response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
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
