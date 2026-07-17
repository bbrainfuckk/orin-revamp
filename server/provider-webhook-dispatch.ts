import lazadaWebhook from './lazada-webhook';
import shopeeWebhook from './shopee-webhook';
import shopifyWebhook from './shopify-webhook';
import paymongoWebhook from './paymongo-webhook';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  end: (payload?: string) => void;
};

export const config = { api: { bodyParser: false } };

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  const provider = queryValue(req.query?.provider);
  if (provider === 'lazada') return lazadaWebhook(req, res);
  if (provider === 'shopee') return shopeeWebhook(req, res);
  if (provider === 'paymongo') return paymongoWebhook(req, res);
  return shopifyWebhook(req, res);
}
