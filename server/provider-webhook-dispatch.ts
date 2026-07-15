import lazadaWebhook from './lazada-webhook';
import shopifyWebhook from './shopify-webhook';

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
};

export const config = { api: { bodyParser: false } };

function queryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (queryValue(req.query?.provider) === 'lazada') return lazadaWebhook(req, res);
  return shopifyWebhook(req, res);
}
