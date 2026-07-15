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

  const serverDataReady = present(
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PRIVATE_KEY',
  );
  const connectorVaultReady = serverDataReady && present('CONNECTOR_ENCRYPTION_KEY');
  const oauthServerReady = connectorVaultReady && present('OAUTH_STATE_SECRET');

  return res.status(200).json({
    ok: true,
    providers: {
      meta: {
        authorizationReady: oauthServerReady && present('META_APP_ID', 'META_APP_SECRET'),
        webhookReady: connectorVaultReady && present('META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'),
      },
      whatsapp: {
        authorizationReady: oauthServerReady && present('META_APP_ID', 'META_APP_SECRET', 'META_WHATSAPP_CONFIG_ID'),
        webhookReady: connectorVaultReady
          && present('META_APP_SECRET')
          && (present('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || present('META_WEBHOOK_VERIFY_TOKEN')),
        messagingReady: oauthServerReady && present('META_APP_ID', 'META_APP_SECRET', 'META_WHATSAPP_CONFIG_ID'),
      },
      tiktok: {
        authorizationReady: oauthServerReady && present('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'),
        webhookReady: connectorVaultReady
          && present('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET')
          && process.env.TIKTOK_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: false,
        shopReady: false,
        partnerAccessRequired: true,
      },
      shopee: {
        authorizationReady: oauthServerReady && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'),
        webhookReady: connectorVaultReady
          && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY')
          && process.env.SHOPEE_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: connectorVaultReady
          && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY')
          && process.env.SHOPEE_WEBHOOKS_CONFIGURED === 'true',
        partnerAccessRequired: true,
      },
      lazada: {
        authorizationReady: oauthServerReady && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET'),
        webhookReady: connectorVaultReady
          && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET')
          && process.env.LAZADA_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: connectorVaultReady
          && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET')
          && process.env.LAZADA_WEBHOOKS_CONFIGURED === 'true',
        partnerAccessRequired: true,
      },
      shopify: {
        authorizationReady: oauthServerReady && present('SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'),
        webhookReady: process.env.SHOPIFY_WEBHOOKS_CONFIGURED === 'true',
      },
      airbnb: {
        authorizationReady: false,
        partnerAccessRequired: true,
      },
      n8n: { authorizationReady: connectorVaultReady, selfHostedReady: false },
      website: {
        authorizationReady: serverDataReady
          && (present('WIDGET_SIGNING_SECRET') || present('OAUTH_STATE_SECRET'))
          && present('CEREBRAS_API_KEY'),
      },
    },
  });
}
