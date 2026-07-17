export const socialProviders = [
  'facebook', 'instagram', 'tiktok', 'youtube', 'linkedin', 'threads', 'pinterest', 'x',
  'google_business', 'reddit', 'bluesky', 'mastodon', 'telegram',
] as const;

export type SocialProvider = typeof socialProviders[number];
export type SocialTarget = { provider: SocialProvider; accountId?: string; variant?: string };

export const socialRecurrences = ['none', 'daily', 'weekdays', 'weekly', 'monthly'] as const;
export type SocialRecurrence = typeof socialRecurrences[number];

export const socialCapabilities: Record<SocialProvider, { label: string; connection: 'oauth' | 'token'; availability: 'ready' | 'app_review' | 'written_approval' }> = {
  facebook: { label: 'Facebook', connection: 'oauth', availability: 'app_review' },
  instagram: { label: 'Instagram', connection: 'oauth', availability: 'app_review' },
  tiktok: { label: 'TikTok', connection: 'oauth', availability: 'app_review' },
  youtube: { label: 'YouTube', connection: 'oauth', availability: 'app_review' },
  linkedin: { label: 'LinkedIn', connection: 'oauth', availability: 'app_review' },
  threads: { label: 'Threads', connection: 'oauth', availability: 'app_review' },
  pinterest: { label: 'Pinterest', connection: 'oauth', availability: 'app_review' },
  x: { label: 'X', connection: 'oauth', availability: 'app_review' },
  google_business: { label: 'Google Business Profile', connection: 'oauth', availability: 'app_review' },
  reddit: { label: 'Reddit', connection: 'oauth', availability: 'written_approval' },
  bluesky: { label: 'Bluesky', connection: 'token', availability: 'ready' },
  mastodon: { label: 'Mastodon', connection: 'token', availability: 'ready' },
  telegram: { label: 'Telegram', connection: 'token', availability: 'ready' },
};

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, maximum) : '';
}

export function validateSocialCredential(provider: unknown, input: unknown) {
  if (!socialProviders.includes(provider as SocialProvider) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_CONNECTION');
  const values = input as Record<string, unknown>;
  if (provider === 'telegram') {
    const botToken = cleanText(values.botToken, 200);
    const chatId = cleanText(values.chatId, 100);
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,80}$/.test(botToken) || !/^-?[A-Za-z0-9_@-]{2,100}$/.test(chatId)) throw new Error('INVALID_CONNECTION');
    return { botToken, chatId };
  }
  if (provider === 'mastodon') {
    const instanceUrl = cleanText(values.instanceUrl, 300).replace(/\/$/, '');
    const accessToken = cleanText(values.accessToken, 500);
    let url: URL;
    try { url = new URL(instanceUrl); } catch { throw new Error('INVALID_CONNECTION'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !accessToken) throw new Error('INVALID_CONNECTION');
    return { instanceUrl: url.origin, accessToken };
  }
  if (provider === 'bluesky') {
    const handle = cleanText(values.handle, 253).toLowerCase();
    const appPassword = cleanText(values.appPassword, 100);
    if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(handle) || appPassword.length < 8) throw new Error('INVALID_CONNECTION');
    return { handle, appPassword };
  }
  throw new Error('MANAGED_OAUTH_REQUIRED');
}

export function validateSocialPost(input: unknown, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_POST');
  const body = input as Record<string, unknown>;
  const text = cleanText(body.text, 10_000);
  const mediaUrl = cleanText(body.mediaUrl, 2_000);
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  if ((!text && !mediaUrl) || !rawTargets.length || rawTargets.length > socialProviders.length) throw new Error('INVALID_POST');
  if (mediaUrl) {
    let url: URL;
    try { url = new URL(mediaUrl); } catch { throw new Error('INVALID_MEDIA_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_MEDIA_URL');
  }
  const seen = new Set<string>();
  const targets = rawTargets.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_TARGET');
    const candidate = raw as Record<string, unknown>;
    const provider = cleanText(candidate.provider, 40) as SocialProvider;
    if (!socialProviders.includes(provider) || seen.has(provider)) throw new Error('INVALID_TARGET');
    seen.add(provider);
    return { provider, accountId: cleanText(candidate.accountId, 300), variant: cleanText(candidate.variant, 10_000) };
  });
  const scheduledAtText = cleanText(body.scheduledAt, 50);
  let scheduledAt = '';
  if (scheduledAtText) {
    const time = Date.parse(scheduledAtText);
    if (!Number.isFinite(time) || time < now + 60_000 || time > now + 366 * 24 * 60 * 60_000) throw new Error('INVALID_SCHEDULE');
    scheduledAt = new Date(time).toISOString();
  }
  const recurrence = cleanText(body.recurrence, 20) as SocialRecurrence || 'none';
  if (!socialRecurrences.includes(recurrence)) throw new Error('INVALID_RECURRENCE');
  const suppliedRuns = typeof body.maxRuns === 'number' ? body.maxRuns : Number(body.maxRuns || 1);
  const maxRuns = recurrence === 'none' ? 1 : Math.trunc(suppliedRuns);
  if (recurrence !== 'none' && !scheduledAt) throw new Error('AUTOPOST_REQUIRES_SCHEDULE');
  if (recurrence !== 'none' && (!Number.isFinite(maxRuns) || maxRuns < 2 || maxRuns > 365)) throw new Error('INVALID_RUN_COUNT');
  return { text, mediaUrl, targets, scheduledAt, recurrence, maxRuns };
}

export function nextSocialOccurrence(current: string, recurrence: Exclude<SocialRecurrence, 'none'>) {
  const next = new Date(current);
  if (!Number.isFinite(next.getTime())) throw new Error('INVALID_SCHEDULE');
  if (recurrence === 'daily' || recurrence === 'weekdays') {
    next.setUTCDate(next.getUTCDate() + 1);
    if (recurrence === 'weekdays') {
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
    }
  } else if (recurrence === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7);
  } else {
    const day = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
  }
  return next.toISOString();
}
