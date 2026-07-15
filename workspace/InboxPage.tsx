import { collection, doc, onSnapshot, type Timestamp } from 'firebase/firestore';
import { Check, ChevronDown, Inbox, MessageSquareText, Send, StickyNote, Tag, UserRoundCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type Conversation = {
  id: string;
  contactName: string;
  channel: string;
  sourceProvider: string;
  contactId: string;
  preview: string;
  status: string;
  assignedUserId: string;
  assignedUserName: string;
  priority: 'normal' | 'high' | 'urgent';
  contactTags: string[];
  unreadCount: number;
  updatedAt?: Timestamp;
};

type Message = {
  id: string;
  body: string;
  senderType: 'customer' | 'agent' | 'team';
  senderName: string;
  sentAt?: Timestamp;
};

type InternalNote = {
  id: string;
  body: string;
  authorName: string;
  createdAt?: Timestamp;
};

function replyRequestId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `reply_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function statusLabel(status: string) {
  if (status === 'team_active') return 'Team active';
  if (status === 'escalated') return 'Needs your team';
  if (status === 'resolved') return 'Resolved';
  return status === 'open' ? 'Open' : status;
}

export function InboxPage() {
  const { user, workspace } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [internalNotes, setInternalNotes] = useState<InternalNote[]>([]);
  const [contactTags, setContactTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reply, setReply] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [replyError, setReplyError] = useState('');
  const [resumingAI, setResumingAI] = useState(false);
  const [crmSaving, setCrmSaving] = useState('');
  const [crmError, setCrmError] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'conversations'), (snapshot) => {
      const next = snapshot.docs.map((conversation) => ({
        id: conversation.id,
        contactName: typeof conversation.data().contactName === 'string' ? conversation.data().contactName : 'Customer',
        channel: typeof conversation.data().channel === 'string' ? conversation.data().channel : 'Unknown channel',
        sourceProvider: typeof conversation.data().sourceProvider === 'string' ? conversation.data().sourceProvider : '',
        contactId: typeof conversation.data().contactId === 'string' ? conversation.data().contactId : '',
        preview: typeof conversation.data().preview === 'string' ? conversation.data().preview : '',
        status: typeof conversation.data().status === 'string' ? conversation.data().status : 'open',
        assignedUserId: typeof conversation.data().assignedUserId === 'string' ? conversation.data().assignedUserId : '',
        assignedUserName: typeof conversation.data().assignedUserName === 'string' ? conversation.data().assignedUserName : '',
        priority: ['normal', 'high', 'urgent'].includes(conversation.data().priority) ? conversation.data().priority : 'normal',
        contactTags: Array.isArray(conversation.data().contactTags) ? conversation.data().contactTags.filter((tag): tag is string => typeof tag === 'string') : [],
        unreadCount: typeof conversation.data().unreadCount === 'number' ? conversation.data().unreadCount : 0,
        updatedAt: conversation.data().updatedAt as Timestamp | undefined,
      })).sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0));
      setConversations(next);
      setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id || '');
      setLoading(false);
      setError('');
    }, (cause) => {
      setError(cause.message);
      setLoading(false);
    });
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace || !selectedId) {
      setMessages([]);
      return undefined;
    }
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'conversations', selectedId, 'messages'), (snapshot) => {
      setMessages(snapshot.docs.map((message) => ({
        id: message.id,
        body: typeof message.data().body === 'string' ? message.data().body : '',
        senderType: ['customer', 'agent', 'team'].includes(message.data().senderType) ? message.data().senderType : 'customer',
        senderName: typeof message.data().senderName === 'string' ? message.data().senderName : '',
        sentAt: message.data().sentAt as Timestamp | undefined,
      })).sort((a, b) => (a.sentAt?.toMillis() || 0) - (b.sentAt?.toMillis() || 0)));
    }, (cause) => setError(cause.message));
  }, [selectedId, workspace]);

  const selected = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) || null, [conversations, selectedId]);
  const canReply = Boolean(selected && (
    selected.sourceProvider === 'website' && selected.channel === 'Website'
    || selected.sourceProvider === 'meta' && ['Messenger', 'Instagram'].includes(selected.channel)
    || selected.sourceProvider === 'whatsapp' && selected.channel === 'WhatsApp'
    || selected.sourceProvider === 'lazada' && selected.channel === 'Lazada'
    || selected.sourceProvider === 'shopee' && selected.channel === 'Shopee'
  ));

  useEffect(() => {
    setReply('');
    setReplyError('');
    setCrmError('');
    setTagDraft('');
    setNoteDraft('');
  }, [selectedId]);

  useEffect(() => {
    if (!db || !workspace || !selected) {
      setContactTags([]);
      return undefined;
    }
    setContactTags(selected.contactTags);
    if (!selected.contactId) return undefined;
    return onSnapshot(doc(db, 'workspaces', workspace.id, 'contacts', selected.contactId), (snapshot) => {
      const tags = snapshot.data()?.tags;
      setContactTags(Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : selected.contactTags);
    }, () => setContactTags(selected.contactTags));
  }, [selected, workspace]);

  useEffect(() => {
    if (!db || !workspace || !selectedId) {
      setInternalNotes([]);
      return undefined;
    }
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'conversations', selectedId, 'notes'), (snapshot) => {
      setInternalNotes(snapshot.docs.map((note) => ({
        id: note.id,
        body: typeof note.data().body === 'string' ? note.data().body : '',
        authorName: typeof note.data().authorName === 'string' ? note.data().authorName : 'Team member',
        createdAt: note.data().createdAt as Timestamp | undefined,
      })).filter((note) => note.body).sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0)));
    }, (cause) => setCrmError(cause.message));
  }, [selectedId, workspace]);

  useEffect(() => {
    if (!selected || selected.unreadCount < 1 || !user || !workspace) return;
    const controller = new AbortController();
    user.getIdToken().then((token) => fetch('/api/widget/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'mark_read', workspaceId: workspace.id, conversationId: selected.id }),
      signal: controller.signal,
    })).catch(() => undefined);
    return () => controller.abort();
  }, [selected, user, workspace]);

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = reply.trim();
    if (!message || !selected || !canReply || !user || !workspace || sendingReply) return;
    setSendingReply(true);
    setReplyError('');
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'team_reply',
          workspaceId: workspace.id,
          conversationId: selected.id,
          requestId: replyRequestId(),
          message,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'Your reply could not be sent.');
      setReply('');
    } catch (cause) {
      setReplyError(cause instanceof Error ? cause.message : 'Your reply could not be sent.');
    } finally {
      setSendingReply(false);
    }
  };

  const resumeAI = async () => {
    if (!selected || !['meta', 'whatsapp', 'lazada', 'shopee'].includes(selected.sourceProvider) || !user || !workspace || resumingAI) return;
    setResumingAI(true);
    setReplyError('');
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'resume_ai', workspaceId: workspace.id, conversationId: selected.id }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'ORIN AI could not be resumed.');
    } catch (cause) {
      setReplyError(cause instanceof Error ? cause.message : 'ORIN AI could not be resumed.');
    } finally {
      setResumingAI(false);
    }
  };

  const updateCrm = async (action: string, values: { priority?: string; tags?: string[]; note?: string } = {}) => {
    if (!selected || !user || !workspace || crmSaving) return false;
    setCrmSaving(action);
    setCrmError('');
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'crm_update',
          action,
          workspaceId: workspace.id,
          conversationId: selected.id,
          requestId: replyRequestId(),
          ...values,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The conversation could not be updated.');
      return true;
    } catch (cause) {
      setCrmError(cause instanceof Error ? cause.message : 'The conversation could not be updated.');
      return false;
    } finally {
      setCrmSaving('');
    }
  };

  const addTag = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const tag = tagDraft.trim().replace(/\s+/g, ' ').slice(0, 32);
    if (!tag || contactTags.some((current) => current.toLocaleLowerCase() === tag.toLocaleLowerCase()) || contactTags.length >= 12) return;
    if (await updateCrm('set_tags', { tags: [...contactTags, tag] })) setTagDraft('');
  };

  const removeTag = (tag: string) => {
    void updateCrm('set_tags', { tags: contactTags.filter((current) => current !== tag) });
  };

  const addNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const note = noteDraft.trim();
    if (!note) return;
    if (await updateCrm('add_note', { note })) setNoteDraft('');
  };

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading"><div><span>Inbox</span><h1>Every conversation, in one place.</h1><p>Messages appear here only after a verified channel begins delivering real conversations.</p></div></header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      {!loading && !conversations.length ? (
        <section className="workspace-empty"><span><Inbox aria-hidden="true" /></span><h2>The inbox is ready for a connection</h2><p>Connect a customer channel, then test a conversation before going live.</p><Link className="workspace-secondary-action" to="/app/integrations">View integrations</Link></section>
      ) : (
        <section className="inbox-shell" aria-label="Unified inbox">
          <aside className="inbox-list">
            <header><span>Conversations</span><strong>{loading ? 'Loading…' : conversations.length.toLocaleString('en-PH')}</strong></header>
            {conversations.map((conversation) => (
              <button key={conversation.id} type="button" className={selectedId === conversation.id ? 'is-selected' : ''} onClick={() => setSelectedId(conversation.id)}>
                <span className="inbox-list__avatar">{conversation.contactName.charAt(0).toUpperCase()}</span>
                <span><strong>{conversation.contactName}</strong><small>{conversation.preview || 'No preview available'}</small><i>{conversation.channel}</i></span>
                {conversation.unreadCount > 0 && <b>{conversation.unreadCount}</b>}
              </button>
            ))}
          </aside>
          <article className="inbox-thread">
            {selected ? <>
              <header className="inbox-thread__header">
                <div><strong>{selected.contactName}</strong><span>{selected.channel} · {statusLabel(selected.status)}</span></div>
                <div className="inbox-triage">
                  <button type="button" className={selected.assignedUserId === user?.uid ? 'is-assigned' : ''} disabled={Boolean(crmSaving)} onClick={() => void updateCrm('assign_to_me')}>
                    <UserRoundCheck aria-hidden="true" />
                    {selected.assignedUserId === user?.uid ? 'Assigned to you' : selected.assignedUserName || 'Assign to me'}
                  </button>
                  <label>
                    <span className="sr-only">Priority</span>
                    <select aria-label="Conversation priority" value={selected.priority} disabled={Boolean(crmSaving)} onChange={(event) => void updateCrm('set_priority', { priority: event.currentTarget.value })}>
                      <option value="normal">Normal priority</option>
                      <option value="high">High priority</option>
                      <option value="urgent">Urgent</option>
                    </select>
                    <ChevronDown aria-hidden="true" />
                  </label>
                  <button type="button" disabled={Boolean(crmSaving)} onClick={() => void updateCrm(selected.status === 'resolved' ? 'reopen' : 'resolve')}>
                    <Check aria-hidden="true" />{selected.status === 'resolved' ? 'Reopen' : 'Resolve'}
                  </button>
                </div>
              </header>
              <details className="inbox-context">
                <summary><span>Customer context</span><small>{contactTags.length} {contactTags.length === 1 ? 'tag' : 'tags'} · {internalNotes.length} {internalNotes.length === 1 ? 'note' : 'notes'}</small><ChevronDown aria-hidden="true" /></summary>
                <div>
                  <section className="inbox-context__tags" aria-label="Customer tags">
                    <header><Tag aria-hidden="true" /><div><strong>Customer tags</strong><span>Use tags to segment follow-ups and automations.</span></div></header>
                    <div>{contactTags.length ? contactTags.map((tag) => <span key={tag}>{tag}<button type="button" disabled={Boolean(crmSaving)} onClick={() => removeTag(tag)} aria-label={`Remove ${tag} tag`}><X aria-hidden="true" /></button></span>) : <small>No tags yet.</small>}</div>
                    <form onSubmit={addTag}><input value={tagDraft} onChange={(event) => setTagDraft(event.currentTarget.value)} maxLength={32} placeholder="Add a tag" aria-label="New customer tag" /><button type="submit" disabled={!tagDraft.trim() || Boolean(crmSaving) || contactTags.length >= 12}>Add</button></form>
                  </section>
                  <section className="inbox-context__notes" aria-label="Internal notes">
                    <header><StickyNote aria-hidden="true" /><div><strong>Internal notes</strong><span>Private to your team. Never sent to the customer.</span></div></header>
                    {internalNotes.length ? <div className="inbox-note-list">{internalNotes.slice(0, 3).map((note) => <article key={note.id}><p>{note.body}</p><small>{note.authorName} · {note.createdAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Just now'}</small></article>)}</div> : <small>No internal notes yet.</small>}
                    <form onSubmit={addNote}><textarea value={noteDraft} onChange={(event) => setNoteDraft(event.currentTarget.value)} maxLength={2000} rows={2} placeholder="Leave context for your team…" aria-label="New internal note" /><button type="submit" disabled={!noteDraft.trim() || Boolean(crmSaving)}>Save note</button></form>
                  </section>
                </div>
                {crmError && <p className="inbox-crm-error" role="alert">{crmError}</p>}
              </details>
              <div className="inbox-messages">
                {messages.length ? messages.map((message) => (
                  <div key={message.id} className={`is-${message.senderType}`}><span>{message.senderName || (message.senderType === 'customer' ? selected.contactName : 'ORIN AI')}</span><p>{message.body}</p><small>{message.sentAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || ''}</small></div>
                )) : <div className="inbox-message-empty"><MessageSquareText aria-hidden="true" /><p>No message records have arrived for this conversation.</p></div>}
              </div>
              <footer>
                {canReply ? <>
                  <form className="inbox-reply" onSubmit={sendReply}>
                    <textarea aria-label="Reply to customer" value={reply} onChange={(event) => setReply(event.currentTarget.value)} placeholder="Reply as your team…" rows={1} maxLength={1000} onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
                    }} />
                    <button type="submit" disabled={!reply.trim() || sendingReply} aria-label="Send team reply"><Send aria-hidden="true" /></button>
                  </form>
                  <span>{selected.sourceProvider === 'meta'
                    ? `Sent through ${selected.channel}. Meta accepts standard replies only while its messaging window is active.`
                    : selected.sourceProvider === 'whatsapp'
                      ? 'Sent through WhatsApp Business. Free-form replies are available for 24 hours after the customer’s latest message.'
                    : selected.sourceProvider === 'lazada'
                      ? 'Sent through Lazada seller chat. Lazada enforces its customer-session and reply-frequency rules.'
                    : selected.sourceProvider === 'shopee'
                      ? 'Sent through Shopee seller chat. Shopee enforces duplicate-content, distribution, and reply-frequency rules.'
                      : 'Delivered while the visitor keeps this website chat open.'}</span>
                  {['meta', 'whatsapp', 'lazada', 'shopee'].includes(selected.sourceProvider) && selected.status === 'team_active' && <button type="button" className="inbox-resume-ai" disabled={resumingAI} onClick={resumeAI}>{resumingAI ? 'Resuming…' : 'Resume ORIN AI for this conversation'}</button>}
                  {replyError && <small className="inbox-reply-error" role="alert">{replyError}</small>}
                </> : <span>Outbound replies unlock after this channel's messaging approval and delivery test.</span>}
              </footer>
            </> : <div className="inbox-message-empty"><MessageSquareText aria-hidden="true" /><p>Select a conversation.</p></div>}
          </article>
        </section>
      )}
    </div>
  );
}
