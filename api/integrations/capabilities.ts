type ApiRequest = { method?: string };
type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

const present = (...names: string[]) => names.every((name) => Boolean(process.env[name]));
const approved = (name: string) => process.env[name] === 'true';

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
  const metaTestReady = process.env.META_TEST_MODE === 'true' && present('META_TEST_PAGE_ID');

  return res.status(200).json({
    ok: true,
    providers: {
      meta: {
        authorizationReady: (approved('META_PRODUCTION_APPROVED') || metaTestReady) && oauthServerReady && present('META_APP_ID', 'META_APP_SECRET'),
        webhookReady: (approved('META_PRODUCTION_APPROVED') || metaTestReady) && connectorVaultReady && present('META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN'),
        partnerAccessRequired: !approved('META_PRODUCTION_APPROVED'),
        testMode: !approved('META_PRODUCTION_APPROVED') && metaTestReady,
      },
      whatsapp: {
        authorizationReady: approved('WHATSAPP_PRODUCTION_APPROVED') && oauthServerReady && present('META_APP_ID', 'META_APP_SECRET', 'META_WHATSAPP_CONFIG_ID'),
        webhookReady: approved('WHATSAPP_PRODUCTION_APPROVED') && connectorVaultReady
          && present('META_APP_SECRET')
          && (present('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || present('META_WEBHOOK_VERIFY_TOKEN')),
        messagingReady: approved('WHATSAPP_PRODUCTION_APPROVED') && oauthServerReady && present('META_APP_ID', 'META_APP_SECRET', 'META_WHATSAPP_CONFIG_ID'),
        partnerAccessRequired: !approved('WHATSAPP_PRODUCTION_APPROVED'),
      },
      tiktok: {
        authorizationReady: approved('TIKTOK_PRODUCTION_APPROVED') && oauthServerReady && present('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'),
        webhookReady: approved('TIKTOK_PRODUCTION_APPROVED') && connectorVaultReady
          && present('TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET')
          && process.env.TIKTOK_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: false,
        shopReady: false,
        partnerAccessRequired: !approved('TIKTOK_PRODUCTION_APPROVED'),
      },
      shopee: {
        authorizationReady: approved('SHOPEE_PRODUCTION_APPROVED') && oauthServerReady && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'),
        webhookReady: approved('SHOPEE_PRODUCTION_APPROVED') && connectorVaultReady
          && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY')
          && process.env.SHOPEE_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: approved('SHOPEE_PRODUCTION_APPROVED') && connectorVaultReady
          && present('SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY')
          && process.env.SHOPEE_WEBHOOKS_CONFIGURED === 'true',
        partnerAccessRequired: !approved('SHOPEE_PRODUCTION_APPROVED'),
      },
      lazada: {
        authorizationReady: approved('LAZADA_PRODUCTION_APPROVED') && oauthServerReady && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET'),
        webhookReady: approved('LAZADA_PRODUCTION_APPROVED') && connectorVaultReady
          && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET')
          && process.env.LAZADA_WEBHOOKS_CONFIGURED === 'true',
        messagingReady: approved('LAZADA_PRODUCTION_APPROVED') && connectorVaultReady
          && present('LAZADA_APP_KEY', 'LAZADA_APP_SECRET')
          && process.env.LAZADA_WEBHOOKS_CONFIGURED === 'true',
        partnerAccessRequired: !approved('LAZADA_PRODUCTION_APPROVED'),
      },
      shopify: {
        authorizationReady: approved('SHOPIFY_PRODUCTION_APPROVED') && oauthServerReady && present('SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'),
        webhookReady: approved('SHOPIFY_PRODUCTION_APPROVED') && process.env.SHOPIFY_WEBHOOKS_CONFIGURED === 'true',
        partnerAccessRequired: !approved('SHOPIFY_PRODUCTION_APPROVED'),
      },
      airbnb: {
        authorizationReady: false,
        partnerAccessRequired: true,
      },
      n8n: { authorizationReady: connectorVaultReady, selfHostedReady: false },
      website: {
        authorizationReady: serverDataReady
          && (present('WIDGET_SIGNING_SECRET') || present('OAUTH_STATE_SECRET'))
          && (present('AI_GATEWAY_API_KEY') || present('VERCEL_OIDC_TOKEN') || present('CEREBRAS_API_KEY')),
      },
    },
  });
}
