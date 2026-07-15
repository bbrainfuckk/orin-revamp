import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, MessageSquareText, X } from 'lucide-react';
import { useParams } from 'react-router-dom';
import './widget.css';

type WidgetConfig = { assistantName: string; businessName: string; greeting: string };
type WidgetMessage = { id: string; role: 'customer' | 'agent' | 'team'; body: string; handoff?: boolean; senderName?: string };

function requestId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `request_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

export function WidgetPage() {
  const { widgetKey = '' } = useParams();
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [conversationId, setConversationId] = useState('');
  const syncCursorRef = useRef('');
  const logRef = useRef<HTMLDivElement>(null);
  const token = useMemo(() => {
    try { return decodeURIComponent(window.location.hash.slice(1)); } catch { return ''; }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('orin-widget-document');
    if (!token) setError('This chat session has expired. Refresh the page to reconnect.');
    return () => document.documentElement.classList.remove('orin-widget-document');
  }, [token]);

  useEffect(() => {
    let active = true;
    fetch(`/api/widget/session?key=${encodeURIComponent(widgetKey)}`, { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { config?: WidgetConfig; error?: string };
        if (!response.ok || !payload.config) throw new Error(payload.error || 'This chat is unavailable.');
        if (!active) return;
        setConfig(payload.config);
        setMessages([{ id: 'greeting', role: 'agent', body: payload.config.greeting }]);
        setLoading(false);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'This chat is unavailable.');
        setLoading(false);
      });
    return () => { active = false; };
  }, [widgetKey]);

  useEffect(() => {
    window.parent.postMessage({ type: 'orin:widget:resize', open }, '*');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open, sending]);

  useEffect(() => {
    if (!open || !conversationId || !token || !syncCursorRef.current) return undefined;
    let active = true;
    const sync = async () => {
      try {
        const response = await fetch('/api/widget/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'widget_sync', token, widgetKey, after: syncCursorRef.current }),
        });
        const payload = await response.json().catch(() => ({})) as { cursor?: string; messages?: Array<{ id?: string; role?: string; body?: string; senderName?: string }> };
        if (!active || !response.ok) return;
        if (payload.cursor) syncCursorRef.current = payload.cursor;
        const incoming = Array.isArray(payload.messages) ? payload.messages.flatMap((message) => (
          message.id && message.body ? [{ id: message.id, role: 'team' as const, body: message.body, senderName: message.senderName || 'Team' }] : []
        )) : [];
        if (incoming.length) setMessages((current) => {
          const known = new Set(current.map((message) => message.id));
          return [...current, ...incoming.filter((message) => !known.has(message.id))];
        });
      } catch {
        // A later poll retries. Customer messaging remains usable during a transient sync failure.
      }
    };
    void sync();
    const timer = window.setInterval(sync, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [conversationId, open, token, widgetKey]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const message = input.trim();
    if (!message || sending || !token) return;
    const id = requestId();
    setInput('');
    setError('');
    setSending(true);
    setMessages((current) => [...current, { id, role: 'customer', body: message }]);
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, widgetKey, requestId: id, message }),
      });
      const payload = await response.json().catch(() => ({})) as { reply?: string; handoff?: boolean; conversationId?: string; cursor?: string; error?: string };
      if (!response.ok || !payload.reply) throw new Error(payload.error || 'The message could not be completed.');
      if (payload.conversationId) setConversationId(payload.conversationId);
      syncCursorRef.current = payload.cursor || new Date().toISOString();
      setMessages((current) => [...current, { id: `${id}_reply`, role: 'agent', body: payload.reply!, handoff: payload.handoff }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The message could not be completed.');
    } finally {
      setSending(false);
    }
  };

  if (!open) return (
    <button type="button" className="orin-embed-launcher" aria-label={`Chat with ${config?.assistantName || 'ORIN AI'}`} onClick={() => setOpen(true)}>
      <img src="/assets/brand/orin-mascot-3d-master.webp" alt="" />
      {!loading && !error && <span />}
    </button>
  );

  return (
    <main className="orin-embed-page">
      <section className="orin-embed-panel" aria-label={`Chat with ${config?.assistantName || 'ORIN AI'}`}>
        <header>
          <img src="/assets/brand/orin-mascot-3d-master.webp" alt="" />
          <div><strong>{config?.assistantName || 'ORIN AI'}</strong><span>{config?.businessName || 'Customer support'}</span></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close chat"><X aria-hidden="true" /></button>
        </header>
        <div ref={logRef} className="orin-embed-log" aria-live="polite">
          {messages.map((message) => <div key={message.id} className={`is-${message.role}`}><small>{message.role === 'customer' ? 'You' : message.role === 'team' ? message.senderName || 'Team' : config?.assistantName || 'ORIN AI'}</small><p>{message.body}</p>{message.handoff && <span>Shared with the team</span>}</div>)}
          {sending && <div className="is-agent is-thinking"><small>{config?.assistantName || 'ORIN AI'}</small><p><i /><i /><i /></p></div>}
          {!loading && !messages.length && <div className="orin-embed-empty"><MessageSquareText aria-hidden="true" /><p>{error || 'This chat is unavailable.'}</p></div>}
        </div>
        {error && <p className="orin-embed-error" role="alert">{error}</p>}
        <form onSubmit={submit}>
          <label htmlFor="orin-embed-message">Message</label>
          <textarea id="orin-embed-message" value={input} onChange={(event) => setInput(event.currentTarget.value)} placeholder="Ask a question…" rows={1} maxLength={1_200} disabled={loading || !config || !token} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} />
          <button type="submit" disabled={!input.trim() || sending || !token} aria-label="Send message"><ArrowUp aria-hidden="true" /></button>
        </form>
        <footer>Answers use information approved by {config?.businessName || 'the business'}.</footer>
      </section>
    </main>
  );
}
