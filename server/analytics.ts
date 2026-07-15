export const ANALYTICS_EVENT_LIMIT = 5_000;
export const ANALYTICS_DAY_OPTIONS = [7, 30, 90] as const;

export type AnalyticsEvent = {
  id: string;
  type: string;
  channel: string;
  conversationId: string;
  contactId: string;
  value: number;
  currency: string;
  firstResponseMs: number | null;
  occurredAt: string;
};

export type AnalyticsMetrics = {
  conversations: number;
  aiHandled: number;
  escalated: number;
  leads: number;
  attributedValue: number;
  verifiedCommerceValue: number;
  aiHandledRate: number;
  escalationRate: number;
  medianFirstResponseMs: number | null;
  p90FirstResponseMs: number | null;
  automationFailures: number;
  events: number;
};

export type AnalyticsRange = {
  days: 7 | 30 | 90;
  timezoneOffset: number;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
};

export type AnalyticsPeriod = {
  metrics: AnalyticsMetrics;
  channels: Array<{ name: string; count: number }>;
  currencies: Array<{ code: string; value: number }>;
  commerceCurrencies: Array<{ code: string; value: number }>;
};

export type AnalyticsSummary = {
  range: AnalyticsRange;
  current: AnalyticsPeriod;
  previous: AnalyticsPeriod;
  trend: Array<{ date: string; conversations: number; aiResponses: number; escalations: number }>;
  truncated: { current: boolean; previous: boolean };
};

const dayMs = 86_400_000;

export function normalizeAnalyticsDays(value: unknown): 7 | 30 | 90 {
  const parsed = typeof value === 'number' ? value : Number(value);
  return ANALYTICS_DAY_OPTIONS.includes(parsed as 7 | 30 | 90) ? parsed as 7 | 30 | 90 : 30;
}

export function normalizeTimezoneOffset(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(parsed)));
}

export function buildAnalyticsRange(daysInput: unknown, timezoneOffsetInput: unknown, nowInput = new Date()): AnalyticsRange {
  const days = normalizeAnalyticsDays(daysInput);
  const timezoneOffset = normalizeTimezoneOffset(timezoneOffsetInput);
  const now = Number.isFinite(nowInput.getTime()) ? nowInput : new Date();
  const localNow = new Date(now.getTime() - timezoneOffset * 60_000);
  const localStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) - (days - 1) * dayMs;
  const currentStartMs = localStart + timezoneOffset * 60_000;
  const currentEndMs = now.getTime();
  const duration = Math.max(dayMs, currentEndMs - currentStartMs);
  const previousEndMs = currentStartMs;
  const previousStartMs = previousEndMs - duration;
  return {
    days,
    timezoneOffset,
    currentStart: new Date(currentStartMs).toISOString(),
    currentEnd: new Date(currentEndMs).toISOString(),
    previousStart: new Date(previousStartMs).toISOString(),
    previousEnd: new Date(previousEndMs).toISOString(),
  };
}

function uniqueConversationIds(events: AnalyticsEvent[], type: string) {
  return new Set(events.filter((event) => event.type === type).map((event) => event.conversationId || event.id));
}

function percentile(values: number[], position: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(position * sorted.length) - 1);
  return sorted[index];
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function summarizeAnalyticsPeriod(events: AnalyticsEvent[]): AnalyticsPeriod {
  const conversations = uniqueConversationIds(events, 'conversation.started');
  const responded = uniqueConversationIds(events, 'conversation.responded');
  const explicitlyResolved = uniqueConversationIds(events, 'conversation.resolved');
  const escalated = uniqueConversationIds(events, 'conversation.escalated');
  const aiHandled = new Set([...responded, ...explicitlyResolved].filter((conversationId) => conversations.has(conversationId) && !escalated.has(conversationId)));
  const firstResponses = events
    .filter((event) => event.type === 'conversation.responded' && event.firstResponseMs !== null && event.firstResponseMs >= 0)
    .map((event) => event.firstResponseMs as number);
  const attributedEvents = events.filter((event) => event.type === 'value.attributed' && Number.isFinite(event.value));
  const attributedValue = roundMoney(attributedEvents.reduce((total, event) => total + event.value, 0));
  const commerceEvents = events.filter((event) => event.type === 'commerce.order_paid' && Number.isFinite(event.value));
  const verifiedCommerceValue = roundMoney(commerceEvents.reduce((total, event) => total + event.value, 0));
  const currencyValues = new Map<string, number>();
  attributedEvents.forEach((event) => {
    const currency = /^[A-Z]{3}$/.test(event.currency) ? event.currency : 'PHP';
    currencyValues.set(currency, roundMoney((currencyValues.get(currency) || 0) + event.value));
  });
  const commerceCurrencyValues = new Map<string, number>();
  commerceEvents.forEach((event) => {
    if (!/^[A-Z]{3}$/.test(event.currency)) return;
    commerceCurrencyValues.set(event.currency, roundMoney((commerceCurrencyValues.get(event.currency) || 0) + event.value));
  });
  const channels = new Map<string, number>();
  events.filter((event) => event.type === 'conversation.started').forEach((event) => {
    const channel = event.channel || 'Unspecified';
    channels.set(channel, (channels.get(channel) || 0) + 1);
  });
  return {
    metrics: {
      conversations: conversations.size,
      aiHandled: aiHandled.size,
      escalated: escalated.size,
      leads: events.filter((event) => event.type === 'lead.captured').length,
      attributedValue,
      verifiedCommerceValue,
      aiHandledRate: conversations.size ? Math.round((aiHandled.size / conversations.size) * 100) : 0,
      escalationRate: conversations.size ? Math.round((escalated.size / conversations.size) * 100) : 0,
      medianFirstResponseMs: median(firstResponses),
      p90FirstResponseMs: percentile(firstResponses, 0.9),
      automationFailures: events.filter((event) => event.type === 'automation.failed').length,
      events: events.length,
    },
    channels: [...channels.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    currencies: [...currencyValues.entries()].map(([code, value]) => ({ code, value })).sort((left, right) => right.value - left.value || left.code.localeCompare(right.code)),
    commerceCurrencies: [...commerceCurrencyValues.entries()].map(([code, value]) => ({ code, value })).sort((left, right) => right.value - left.value || left.code.localeCompare(right.code)),
  };
}

function localDateKey(occurredAt: string, timezoneOffset: number) {
  const time = Date.parse(occurredAt);
  if (!Number.isFinite(time)) return '';
  return new Date(time - timezoneOffset * 60_000).toISOString().slice(0, 10);
}

export function buildAnalyticsTrend(events: AnalyticsEvent[], range: AnalyticsRange) {
  const start = Date.parse(range.currentStart) - range.timezoneOffset * 60_000;
  const buckets: Array<[string, { date: string; conversations: number; aiResponses: number; escalations: number }]> = Array.from({ length: range.days }, (_, index) => {
    const date = new Date(start + index * dayMs).toISOString().slice(0, 10);
    return [date, { date, conversations: 0, aiResponses: 0, escalations: 0 }];
  });
  const byDate = new Map(buckets);
  events.forEach((event) => {
    const bucket = byDate.get(localDateKey(event.occurredAt, range.timezoneOffset));
    if (!bucket) return;
    if (event.type === 'conversation.started') bucket.conversations += 1;
    if (event.type === 'conversation.responded') bucket.aiResponses += 1;
    if (event.type === 'conversation.escalated') bucket.escalations += 1;
  });
  return [...byDate.values()];
}

export function summarizeAnalytics(currentEvents: AnalyticsEvent[], previousEvents: AnalyticsEvent[], range: AnalyticsRange, truncated = { current: false, previous: false }): AnalyticsSummary {
  return {
    range,
    current: summarizeAnalyticsPeriod(currentEvents),
    previous: summarizeAnalyticsPeriod(previousEvents),
    trend: buildAnalyticsTrend(currentEvents, range),
    truncated,
  };
}
