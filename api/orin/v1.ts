import { handleOrinApi } from '../../server/orin-api.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    return res.status(200).json(await handleOrinApi(req));
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : 'REQUEST_FAILED';
    const status = error === 'UNAUTHENTICATED' ? 401
      : error === 'FORBIDDEN' ? 403
        : error === 'RATE_LIMITED' ? 429
          : error === 'METHOD_NOT_ALLOWED' ? 405
            : error === 'INVALID_REQUEST' ? 400
              : error.startsWith('SERVER_') ? 503 : 500;
    return res.status(status).json({ ok: false, error });
  }
}
