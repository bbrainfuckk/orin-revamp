import { handleCommerce } from '../server/commerce.js';

type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};
type ApiResponse = { setHeader: (name: string, value: string) => void; status: (code: number) => ApiResponse; json: (payload: unknown) => void };

const queryValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] || '' : value || '';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const result = await handleCommerce(req, queryValue(req.query?.action));
    return res.status(200).json(result);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'UNAUTHENTICATED') return res.status(401).json({ ok: false, error: 'Sign in again to continue.' });
    if (message === 'FORBIDDEN') return res.status(403).json({ ok: false, error: 'Your workspace role cannot make this change.' });
    if (['INVALID_REQUEST', 'INVALID_CATALOG_ITEM', 'INVALID_CATALOG_PRICE', 'INVALID_CATALOG_STOCK', 'INVALID_CATALOG_IMAGE', 'INVALID_PAYMONGO_CREDENTIALS', 'INVALID_GCASH_ACCOUNT', 'ORDER_STATUS_INVALID'].includes(message)) {
      const errors: Record<string, string> = {
        INVALID_CATALOG_PRICE: 'Enter a price of at least ₱1, or choose quotation only.',
        INVALID_CATALOG_STOCK: 'Stock must be blank for unlimited or a whole number of zero or more.',
        INVALID_CATALOG_IMAGE: 'Use a public HTTPS image URL.',
        INVALID_PAYMONGO_CREDENTIALS: 'Enter a PayMongo secret API key and the signing secret for this webhook.',
        INVALID_GCASH_ACCOUNT: 'Enter both the GCash account name and an 11-digit Philippine mobile number.',
        ORDER_STATUS_INVALID: 'Only a pending native GCash order can be manually marked paid.',
      };
      return res.status(400).json({ ok: false, error: errors[message] || 'Check the submitted commerce details.' });
    }
    if (message === 'PAYMONGO_REJECTED_CREDENTIALS') return res.status(400).json({ ok: false, error: 'PayMongo rejected that secret API key.' });
    if (['PAYMONGO_UNAVAILABLE', 'AUTH_SERVICE_UNAVAILABLE', 'SERVER_STORAGE_NOT_CONFIGURED', 'SERVER_STORAGE_AUTH_FAILED'].includes(message)) return res.status(503).json({ ok: false, error: 'The secure connection service is temporarily unavailable.' });
    if (message === 'ORDER_NOT_FOUND') return res.status(404).json({ ok: false, error: 'That order no longer exists.' });
    console.error('Commerce request failed', cause);
    return res.status(500).json({ ok: false, error: 'The commerce change could not be completed.' });
  }
}
