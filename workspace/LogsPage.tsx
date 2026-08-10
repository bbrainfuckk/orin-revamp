import { Activity, AlertTriangle, Bot, CircleCheck, Radio, Search } from 'lucide-react';
import { collection, limit, onSnapshot, orderBy, query, type Timestamp } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type LogEvent = {
  id: string;
  type: string;
  status: string;
  provider: string;
  channel: string;
  model: string;
  feature: string;
  errorCode: string;
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  estimatedCostUsd: number;
  costStatus: string;
  occurredAt?: Timestamp;
};

const text = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const label = (value: string) => value.replace(/[._]/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export function LogsPage() {
  const { workspace } = useAuth();
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(query(collection(db, 'workspaces', workspace.id, 'events'), orderBy('occurredAt', 'desc'), limit(200)), (snapshot) => {
      setEvents(snapshot.docs.map((document) => {
        const data = document.data();
        return {
          id: document.id,
          type: text(data.type) || 'activity',
          status: text(data.status),
          provider: text(data.provider),
          channel: text(data.channel),
          model: text(data.model),
          feature: text(data.feature),
          errorCode: text(data.errorCode),
          conversationId: text(data.conversationId),
          inputTokens: number(data.inputTokens),
          outputTokens: number(data.outputTokens),
          latencyMs: number(data.latencyMs),
          estimatedCostUsd: number(data.estimatedCostUsd),
          costStatus: text(data.costStatus),
          occurredAt: data.occurredAt as Timestamp | undefined,
        };
      }));
      setError('');
    }, () => setError('The operations feed could not be loaded.'));
  }, [workspace]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      const group = event.type.startsWith('ai.') ? 'ai' : /failed|error/i.test(`${event.type} ${event.status}`) ? 'failed' : event.type.startsWith('message.') ? 'messages' : 'operations';
      return (filter === 'all' || filter === group) && (!needle || [event.type, event.provider, event.channel, event.model, event.feature, event.errorCode, event.conversationId].join(' ').toLowerCase().includes(needle));
    });
  }, [events, filter, search]);

  const aiCount = events.filter((event) => event.type === 'ai.generated').length;
  const failedCount = events.filter((event) => /failed|error/i.test(`${event.type} ${event.status}`)).length;
  const tokenCount = events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0);

  return (
    <section className="workspace-page logs-page">
      <header className="workspace-page-heading"><div><span>Operations</span><h1>See what ORIN AI is doing.</h1><p>A live, sanitized record of AI routing, customer operations, delivery, handoff, and CRM activity.</p></div><span className="logs-live"><Radio aria-hidden="true" /> Live</span></header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}

      <section className="logs-metrics" aria-label="Operations summary">
        <article><Activity /><span>Recent events</span><strong>{events.length}</strong><small>Latest 200 workspace events</small></article>
        <article><Bot /><span>AI generations</span><strong>{aiCount}</strong><small>{tokenCount.toLocaleString()} recorded tokens</small></article>
        <article><AlertTriangle /><span>Needs attention</span><strong>{failedCount}</strong><small>Failures are sanitized by code</small></article>
        <article><CircleCheck /><span>Privacy</span><strong>Safe</strong><small>No message bodies or credentials</small></article>
      </section>

      <div className="logs-toolbar">
        <div role="group" aria-label="Log type">{[['all', 'All'], ['ai', 'AI'], ['messages', 'Messages'], ['operations', 'Operations'], ['failed', 'Failed']].map(([value, title]) => <button type="button" key={value} className={filter === value ? 'is-active' : ''} onClick={() => setFilter(value)}>{title}</button>)}</div>
        <label><Search aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search provider, model, event, or conversation" /></label>
      </div>

      <section className="logs-feed">
        <header><span>Time</span><span>Event</span><span>Source</span><span>Usage</span><span>Result</span></header>
        {visible.length ? visible.map((event) => {
          const tokens = event.inputTokens + event.outputTokens;
          const failed = /failed|error/i.test(`${event.type} ${event.status}`);
          return <article key={event.id} className={failed ? 'is-failed' : ''}>
            <time>{event.occurredAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) || 'Just now'}</time>
            <span><strong>{label(event.type)}</strong><small>{event.feature ? label(event.feature) : event.conversationId ? `Conversation ${event.conversationId.slice(-8)}` : 'Workspace activity'}</small></span>
            <span><strong>{event.provider || event.channel || 'ORIN AI'}</strong><small>{event.model || event.channel || 'Workspace'}</small></span>
            <span><strong>{tokens ? `${tokens.toLocaleString()} tokens` : '—'}</strong><small>{event.latencyMs ? `${event.latencyMs.toLocaleString()} ms` : event.estimatedCostUsd ? `$${event.estimatedCostUsd.toFixed(6)}` : 'No metered usage'}</small></span>
            <span><em>{failed ? 'Failed' : event.status ? label(event.status) : 'Recorded'}</em><small>{event.errorCode ? label(event.errorCode) : event.costStatus === 'unavailable' ? 'Token count only' : event.estimatedCostUsd ? `$${event.estimatedCostUsd.toFixed(6)} estimated` : 'Complete'}</small></span>
          </article>;
        }) : <div className="logs-empty"><Activity /><strong>No matching events.</strong><p>New workspace activity will appear here automatically.</p></div>}
      </section>
    </section>
  );
}
