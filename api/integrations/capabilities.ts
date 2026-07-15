type ApiRequest = { method?: string };
type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

const present = (...names: string[]) => names.every((name) => Boolean(process.env[name]));

export default function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const serverVaultReady = present(
    'OAUTH_STATE_SECRET',
    'CONNECTOR_ENCRYPTION_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  );

  return res.status(200).json({
    ok: true,
    providers: {
      meta: {
        authorizationReady: serverVaultReady && present('META_APP_ID', 'META_APP_SECRET'),
        webhookReady: serverVaultReady && present('META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'),
      },
      tiktok: {
        authorizationReady: serverVaultReady && present('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'),
        partnerAccessRequired: true,
      },
      shopee: {
        authorizationReady: serverVaultReady && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'),
        partnerAccessRequired: true,
      },
      lazada: {
        authorizationReady: serverVaultReady && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET'),
        partnerAccessRequired: true,
      },
      shopify: {
        authorizationReady: serverVaultReady && present('SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'),
      },
      airbnb: {
        authorizationReady: false,
        partnerAccessRequired: true,
      },
      n8n: { authorizationReady: true, selfHostedReady: false },
      website: { authorizationReady: true },
    },
  });
}
