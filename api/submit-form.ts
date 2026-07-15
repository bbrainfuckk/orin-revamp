type LeadBody = {
  name?: string;
  business_name?: string;
  email?: string;
  ai_role?: string;
  configuration?: string;
  company_website?: string;
};

type ApiRequest = {
  method?: string;
  body?: LeadBody | string;
};

type ApiResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
};

const clean = (value: unknown, maxLength: number) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {};
  const name = clean(body.name, 120);
  const businessName = clean(body.business_name, 160);
  const email = clean(body.email, 180).toLowerCase();
  const aiRole = clean(body.ai_role, 160);
  const configuration = clean(body.configuration, 5000);

  // Honeypot field. Real visitors never see or fill this.
  if (clean(body.company_website, 200)) {
    return res.status(200).json({ ok: true });
  }

  if (!name || !email) {
    return res.status(400).json({ ok: false, error: 'Name and email are required' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid email address' });
  }

  const webhookUrl = process.env.SHEET_WEBHOOK_URL;

  if (!webhookUrl) {
    return res.status(503).json({
      ok: false,
      error: 'Lead delivery is not configured yet',
    });
  }

  try {
    const delivery = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        business_name: businessName,
        email,
        ai_role: aiRole,
        configuration,
        source: 'orin.work',
        submitted_at: new Date().toISOString(),
      }),
    });

    if (!delivery.ok) {
      throw new Error(`Lead webhook returned ${delivery.status}`);
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Lead delivery failed', error);
    return res.status(502).json({ ok: false, error: 'Lead delivery failed' });
  }
}
