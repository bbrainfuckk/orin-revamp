import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

type RequestWithHeaders = {
  headers?: Record<string, string | string[] | undefined>;
};

const projectId = process.env.FIREBASE_PROJECT_ID
  || process.env.VITE_FIREBASE_PROJECT_ID
  || 'orin-ai-502503';

const adminApp = getApps().length ? getApp() : initializeApp({ projectId });

function authorizationHeader(req: RequestWithHeaders) {
  const value = req.headers?.authorization;
  return Array.isArray(value) ? value[0] : value;
}

export async function verifyFirebaseRequest(req: RequestWithHeaders): Promise<DecodedIdToken> {
  const authorization = authorizationHeader(req);
  if (!authorization?.startsWith('Bearer ')) throw new Error('UNAUTHENTICATED');

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new Error('UNAUTHENTICATED');

  return getAuth(adminApp).verifyIdToken(token);
}
