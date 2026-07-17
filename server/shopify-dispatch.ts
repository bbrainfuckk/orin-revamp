import callback from './shopify-callback';
import connect from './shopify-connect';
import start from './shopify-start';
import lazadaCallback from './lazada-callback';
import lazadaConnect from './lazada-connect';
import lazadaStart from './lazada-start';
import shopeeCallback from './shopee-callback';
import shopeeConnect from './shopee-connect';
import shopeeStart from './shopee-start';
import analyticsSummary from './analytics-summary';
import { handleSocial } from './social-dispatch';
import { handleCommunications } from './communications-dispatch';

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
  if (provider === 'communications') {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json(await handleCommunications(req, action)); }
    catch (cause) { const error = cause instanceof Error ? cause.message : 'COMMUNICATIONS_REQUEST_FAILED'; const status = error === 'UNAUTHENTICATED' ? 401 : error === 'FORBIDDEN' ? 403 : error === 'METHOD_NOT_ALLOWED' ? 405 : error.includes('PROVIDER_') ? 422 : 400; return res.status(status).json({ ok: false, error }); }
  }
  if (provider === 'social') {
    res.setHeader('Cache-Control', 'no-store');
    try { return res.status(200).json(await handleSocial(req, action)); }
    catch (cause) {
      const error = cause instanceof Error ? cause.message : 'SOCIAL_REQUEST_FAILED';
      const status = error === 'UNAUTHENTICATED' ? 401 : error === 'FORBIDDEN' ? 403 : error === 'METHOD_NOT_ALLOWED' ? 405 : error.includes('PROVIDER_') || error.includes('MEDIA_') ? 422 : 400;
      return res.status(status).json({ ok: false, error });
    }
  }
  if (provider === 'analytics') {
    if (action === 'summary') return analyticsSummary(req, res);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'Analytics route not found' });
  }
  if (provider === 'lazada') {
    if (action === 'start') return lazadaStart(req, res);
    if (action === 'callback') return lazadaCallback(req, res);
    if (action === 'connect') return lazadaConnect(req, res);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'Lazada route not found' });
  }
  if (provider === 'shopee') {
    if (action === 'start') return shopeeStart(req, res);
    if (action === 'callback') return shopeeCallback(req, res);
    if (action === 'connect') return shopeeConnect(req, res);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, error: 'Shopee route not found' });
  }
  if (action === 'start') return start(req, res);
  if (action === 'callback') return callback(req, res);
  if (action === 'connect') return connect(req, res);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ ok: false, error: 'Shopify route not found' });
}
