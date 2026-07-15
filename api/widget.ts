import message from '../server/widget-message';
import session from '../server/widget-session';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  end: () => void;
};

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const action = queryValue(req.query?.action);
  if (action === 'session') return session(req, res);
  if (action === 'message') return message(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ ok: false, error: 'Widget route not found' });
}
