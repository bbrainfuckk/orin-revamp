import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { Inbox, MessageSquareText } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type Conversation = {
  id: string;
  contactName: string;
  channel: string;
  preview: string;
  status: string;
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

export function InboxPage() {
  const { workspace } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'conversations'), (snapshot) => {
      const next = snapshot.docs.map((conversation) => ({
        id: conversation.id,
        contactName: typeof conversation.data().contactName === 'string' ? conversation.data().contactName : 'Customer',
        channel: typeof conversation.data().channel === 'string' ? conversation.data().channel : 'Unknown channel',
        preview: typeof conversation.data().preview === 'string' ? conversation.data().preview : '',
        status: typeof conversation.data().status === 'string' ? conversation.data().status : 'open',
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
              <header><div><strong>{selected.contactName}</strong><span>{selected.channel} · {selected.status}</span></div><small>Conversation record</small></header>
              <div className="inbox-messages">
                {messages.length ? messages.map((message) => (
                  <div key={message.id} className={`is-${message.senderType}`}><span>{message.senderName || (message.senderType === 'customer' ? selected.contactName : 'ORIN AI')}</span><p>{message.body}</p><small>{message.sentAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || ''}</small></div>
                )) : <div className="inbox-message-empty"><MessageSquareText aria-hidden="true" /><p>No message records have arrived for this conversation.</p></div>}
              </div>
              <footer><span>Replies activate after this channel passes authorization and delivery tests.</span><button type="button" disabled>Reply</button></footer>
            </> : <div className="inbox-message-empty"><MessageSquareText aria-hidden="true" /><p>Select a conversation.</p></div>}
          </article>
        </section>
      )}
    </div>
  );
}
