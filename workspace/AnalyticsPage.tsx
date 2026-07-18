import { ChartNoAxesCombined } from 'lucide-react';
import { useState } from 'react';
import { ServiceIcon } from '../components/ServiceIcon';
import { useAuth } from '../contexts/AuthContext';
import { emptyAnalyticsMetrics, formatResponseTime, useWorkspaceAnalytics } from '../services/workspace-analytics';

const analyticsDays = [7, 30, 90] as const;
const chartGridLines = [0, 1, 2, 3, 4] as const;

function analyticsComparison(current: number, previous: number, points = false) {
  if (points) {
    const difference = Math.round(current - previous);
    if (!difference) return 'No change from prior period';
    return `${difference > 0 ? '+' : ''}${difference} points vs prior period`;
  }
  if (!previous) return current ? 'New activity this period' : 'No prior activity';
  const difference = Math.round(((current - previous) / previous) * 100);
  if (!difference) return 'No change from prior period';
  return `${difference > 0 ? '+' : ''}${difference}% vs prior period`;
}

function analyticsPath(trend: Array<{ conversations: number; aiResponses: number }>, key: 'conversations' | 'aiResponses', width = 760, height = 190) {
  const maximum = Math.max(1, ...trend.flatMap((day) => [day.conversations, day.aiResponses]));
  return trend.map((day, index) => {
    const x = trend.length === 1 ? width / 2 : (index / (trend.length - 1)) * width;
    const y = height - (day[key] / maximum) * height;
    return `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

export function AnalyticsPage() {
  const { user, workspace } = useAuth();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [advanced, setAdvanced] = useState(true);
  const { error, loading, summary } = useWorkspaceAnalytics(user, workspace?.id, days);
  const current = summary?.current;
  const previous = summary?.previous;
  const metrics = current?.metrics || emptyAnalyticsMetrics;
  const previousMetrics = previous?.metrics || emptyAnalyticsMetrics;
  const channels = current?.channels || [];
  const trend = summary?.trend || [];
  const primaryCurrency = current?.currencies[0]?.code || 'PHP';
  const mixedCurrencies = (current?.currencies.length || 0) > 1;
  const previousCurrencies = previous?.currencies || [];
  const comparableCurrency = previousCurrencies.length === 0 || previousCurrencies.length === 1 && previousCurrencies[0].code === primaryCurrency;
  const currency = new Intl.NumberFormat('en-PH', { style: 'currency', currency: primaryCurrency, maximumFractionDigits: 0 });
  const attributedValue = mixedCurrencies ? 'Mixed currencies' : currency.format(metrics.attributedValue);
  const commerceCurrencies = current?.commerceCurrencies || [];
  const commercePrimaryCurrency = commerceCurrencies[0]?.code || 'PHP';
  const mixedCommerceCurrencies = commerceCurrencies.length > 1;
  const previousCommerceCurrencies = previous?.commerceCurrencies || [];
  const comparableCommerceCurrency = previousCommerceCurrencies.length === 0 || previousCommerceCurrencies.length === 1 && previousCommerceCurrencies[0].code === commercePrimaryCurrency;
  const commerceCurrency = new Intl.NumberFormat('en-PH', { style: 'currency', currency: commercePrimaryCurrency, maximumFractionDigits: 0 });
  const verifiedCommerceValue = mixedCommerceCurrencies ? 'Mixed currencies' : commerceCurrency.format(metrics.verifiedCommerceValue);
  const largestChannel = channels[0]?.count || 0;
  const trendLabels = trend.length ? [trend[0], trend[Math.floor((trend.length - 1) / 2)], trend[trend.length - 1]] : [];

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <div><span>Analytics</span><h1>Know what ORIN AI is changing.</h1><p>Every number comes from verified workspace activity within the selected period.</p></div>
        <div className="analytics-controls"><div className="analytics-view" role="group" aria-label="Analytics detail"><button type="button" aria-pressed={!advanced} onClick={() => setAdvanced(false)}>Overview</button><button type="button" aria-pressed={advanced} onClick={() => setAdvanced(true)}>Advanced</button></div><div className="analytics-range" role="group" aria-label="Analytics period">{analyticsDays.map((option) => <button key={option} type="button" aria-pressed={days === option} onClick={() => setDays(option)}>{option} days</button>)}</div></div>
      </header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      {(summary?.truncated.current || summary?.truncated.previous) && <p className="workspace-inline-notice" role="status">This high-volume workspace reached the 5,000-event reporting limit. The dashboard shows the most recent verified activity in each period.</p>}
      <section className="analytics-summary" aria-label="Workspace analytics summary">
        <article><span>Conversations</span><strong>{loading ? '—' : metrics.conversations.toLocaleString('en-PH')}</strong><small>{analyticsComparison(metrics.conversations, previousMetrics.conversations)}</small></article>
        <article><span>Handled by ORIN AI</span><strong>{loading ? '—' : `${metrics.aiHandledRate}%`}</strong><small>{analyticsComparison(metrics.aiHandledRate, previousMetrics.aiHandledRate, true)}</small></article>
        <article><span>Leads captured</span><strong>{loading ? '—' : metrics.leads.toLocaleString('en-PH')}</strong><small>{analyticsComparison(metrics.leads, previousMetrics.leads)}</small></article>
        <article><span>Verified attributed value</span><strong>{loading ? '—' : attributedValue}</strong><small>{mixedCurrencies ? current?.currencies.map((item) => `${item.code} ${item.value.toLocaleString('en-PH')}`).join(' · ') : comparableCurrency ? analyticsComparison(metrics.attributedValue, previousMetrics.attributedValue) : `Prior period recorded ${previousCurrencies.map((item) => item.code).join(', ')}`}</small></article>
        <article><span>Verified commerce revenue</span><strong>{loading ? '—' : verifiedCommerceValue}</strong><small>{mixedCommerceCurrencies ? commerceCurrencies.map((item) => `${item.code} ${item.value.toLocaleString('en-PH')}`).join(' · ') : comparableCommerceCurrency ? analyticsComparison(metrics.verifiedCommerceValue, previousMetrics.verifiedCommerceValue) : `Prior period recorded ${previousCommerceCurrencies.map((item) => item.code).join(', ')}`}</small></article>
      </section>

      {metrics.events ? (
        <section className="analytics-detail-grid">
          <article className="analytics-trend-card">
            <header><div><span>Activity trend</span><strong>Conversations and automatic responses</strong></div><div className="analytics-trend-legend"><span><i className="is-conversations" /> Conversations</span><span><i className="is-responses" /> AI responses</span></div></header>
            <div className="analytics-trend-plot">
              <svg viewBox="0 0 760 210" role="img" aria-label={`Daily conversations and ORIN AI responses over ${days} days`} preserveAspectRatio="none">
                {chartGridLines.map((line) => <line key={line} x1="0" x2="760" y1={line * 47.5} y2={line * 47.5} />)}
                <path className="is-conversations" d={analyticsPath(trend, 'conversations')} />
                <path className="is-responses" d={analyticsPath(trend, 'aiResponses')} />
              </svg>
              <div>{trendLabels.map((item) => <time key={item.date}>{new Date(`${item.date}T00:00:00`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}</time>)}</div>
            </div>
          </article>
          <article className="analytics-channel-card">
            <header><span>Channel mix</span><strong>Conversation starts</strong></header>
            <div>{channels.map((channel) => (
              <div key={channel.name}><span><ServiceIcon service={channel.name} label={channel.name} />{channel.name}</span><i><b style={{ width: `${largestChannel ? (channel.count / largestChannel) * 100 : 0}%` }} /></i><strong>{channel.count.toLocaleString('en-PH')}</strong></div>
            ))}</div>
          </article>
          <article className="analytics-operations-card">
            <header><span>Operating quality</span><strong>Customer response</strong></header>
            <dl>
              <div><dt>Median first response</dt><dd>{formatResponseTime(metrics.medianFirstResponseMs)}</dd></div>
              <div><dt>90th percentile response</dt><dd>{formatResponseTime(metrics.p90FirstResponseMs)}</dd></div>
              <div><dt>Human escalation</dt><dd>{metrics.escalationRate}%</dd></div>
              <div><dt>Automation failures</dt><dd>{metrics.automationFailures.toLocaleString('en-PH')}</dd></div>
              <div><dt>Events analysed</dt><dd>{metrics.events.toLocaleString('en-PH')}</dd></div>
            </dl>
          </article>
          {advanced && <>
            <article className="analytics-advanced-card">
              <header><span>Conversation lifecycle</span><strong>From first message to resolution</strong></header>
              <dl>
                <div><dt>Inbound messages</dt><dd>{metrics.inboundMessages.toLocaleString('en-PH')}</dd></div>
                <div><dt>Outbound messages</dt><dd>{metrics.outboundMessages.toLocaleString('en-PH')}</dd></div>
                <div><dt>Resolved conversations</dt><dd>{metrics.resolvedConversations.toLocaleString('en-PH')}</dd></div>
                <div><dt>Resolution rate</dt><dd>{metrics.resolutionRate}%</dd></div>
              </dl>
            </article>
            <article className="analytics-advanced-card">
              <header><span>Automation outcomes</span><strong>Work completed without losing control</strong></header>
              <dl>
                <div><dt>Follow-ups sent</dt><dd>{metrics.followUpsSent.toLocaleString('en-PH')}</dd></div>
                <div><dt>Quotes requested</dt><dd>{metrics.quotesRequested.toLocaleString('en-PH')}</dd></div>
                <div><dt>Tasks completed</dt><dd>{metrics.tasksCompleted.toLocaleString('en-PH')}</dd></div>
                <div><dt>Failures</dt><dd>{metrics.automationFailures.toLocaleString('en-PH')}</dd></div>
              </dl>
            </article>
            <article className="analytics-provider-card">
              <header><span>Provider activity</span><strong>Verified event volume</strong></header>
              <div>{(current?.providers || []).map((provider) => <div key={provider.name}><ServiceIcon service={provider.name} label={provider.name} /><span>{provider.name}</span><strong>{provider.count.toLocaleString('en-PH')}</strong></div>)}</div>
            </article>
            <article className="analytics-event-card">
              <header><span>Event ledger</span><strong>Every measured operation</strong></header>
              <div>{(current?.eventTypes || []).map((event) => <div key={event.name}><span>{event.name.replaceAll('.', ' ')}</span><strong>{event.count.toLocaleString('en-PH')}</strong></div>)}</div>
            </article>
          </>}
        </section>
      ) : (
        <section className="analytics-empty">
          <div><ChartNoAxesCombined aria-hidden="true" /><h2>Analytics begin with the first conversation.</h2><p>Connect a channel and publish an AI to measure response speed, automatic handling, escalation, leads, and verified attributed outcomes.</p></div>
          <dl>
            <div><dt>Conversations</dt><dd>0</dd></div>
            <div><dt>Handled by ORIN AI</dt><dd>0%</dd></div>
            <div><dt>Leads captured</dt><dd>0</dd></div>
            <div><dt>Attributed value</dt><dd>₱0</dd></div>
          </dl>
        </section>
      )}
    </div>
  );
}
