import type { User } from 'firebase/auth';
import { useEffect, useState } from 'react';

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

export type AnalyticsPeriod = {
  metrics: AnalyticsMetrics;
  channels: Array<{ name: string; count: number }>;
  currencies: Array<{ code: string; value: number }>;
  commerceCurrencies: Array<{ code: string; value: number }>;
};

export type WorkspaceAnalyticsSummary = {
  range: {
    days: 7 | 30 | 90;
    timezoneOffset: number;
    currentStart: string;
    currentEnd: string;
    previousStart: string;
    previousEnd: string;
  };
  current: AnalyticsPeriod;
  previous: AnalyticsPeriod;
  trend: Array<{ date: string; conversations: number; aiResponses: number; escalations: number }>;
  truncated: { current: boolean; previous: boolean };
};

export const emptyAnalyticsMetrics: AnalyticsMetrics = {
  conversations: 0,
  aiHandled: 0,
  escalated: 0,
  leads: 0,
  attributedValue: 0,
  verifiedCommerceValue: 0,
  aiHandledRate: 0,
  escalationRate: 0,
  medianFirstResponseMs: null,
  p90FirstResponseMs: null,
  automationFailures: 0,
  events: 0,
};

export function useWorkspaceAnalytics(user: User | null, workspaceId: string | undefined, days: 7 | 30 | 90) {
  const [summary, setSummary] = useState<WorkspaceAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(Boolean(user && workspaceId));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!user || !workspaceId) {
      setSummary(null);
      setLoading(false);
      setError('');
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    user.getIdToken()
      .then((token) => fetch(`/api/analytics/summary?${new URLSearchParams({
        workspaceId,
        days: String(days),
        timezoneOffset: String(new Date().getTimezoneOffset()),
      }).toString()}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal: controller.signal,
      }))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { summary?: WorkspaceAnalyticsSummary; error?: string };
        if (!response.ok || !payload.summary) throw new Error(payload.error || 'Analytics could not be loaded.');
        if (active) setSummary(payload.summary);
      })
      .catch((cause) => {
        if (!active || cause instanceof DOMException && cause.name === 'AbortError') return;
        setSummary(null);
        setError(cause instanceof Error ? cause.message : 'Analytics could not be loaded.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [days, user, workspaceId]);

  return { error, loading, summary };
}

export function formatResponseTime(value: number | null) {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} sec`;
  return `${(value / 60_000).toFixed(1)} min`;
}
