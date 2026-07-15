import callback from './shopify-callback';
import connect from './shopify-connect';
import start from './shopify-start';
import lazadaCallback from './lazada-callback';
import lazadaConnect from './lazada-connect';
import lazadaStart from './lazada-start';

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
  end: (payload?: string) => void;
};

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const action = queryValue(req.query?.action);
  const provider = queryValue(req.query?.provider);
  if (provider === 'lazada') {
    if (action === 'start') return lazadaStart(req, res);
    if (action === 'callback') return lazadaCallback(req, res);
    if (action === 'connect') return lazadaConnect(req, res);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'Lazada route not found' });
  }
  if (action === 'start') return start(req, res);
  if (action === 'callback') return callback(req, res);
  if (action === 'connect') return connect(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ ok: false, error: 'Shopify route not found' });
}
