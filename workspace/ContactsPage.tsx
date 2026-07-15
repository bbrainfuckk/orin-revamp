import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { ContactRound, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type Contact = {
  id: string;
  name: string;
  handle: string;
  channels: string[];
  tags: string[];
  lastSeenAt?: Timestamp;
};

export function ContactsPage() {
  const { workspace } = useAuth();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'contacts'), (snapshot) => {
      setContacts(snapshot.docs.map((contact) => ({
        id: contact.id,
        name: typeof contact.data().name === 'string' ? contact.data().name : 'Unnamed contact',
        handle: typeof contact.data().handle === 'string' ? contact.data().handle : '',
        channels: Array.isArray(contact.data().channels) ? contact.data().channels : [],
        tags: Array.isArray(contact.data().tags) ? contact.data().tags : [],
        lastSeenAt: contact.data().lastSeenAt as Timestamp | undefined,
      })).sort((a, b) => (b.lastSeenAt?.toMillis() || 0) - (a.lastSeenAt?.toMillis() || 0)));
      setLoading(false);
      setError('');
    }, (cause) => {
      setError(cause.message);
      setLoading(false);
    });
  }, [workspace]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter((contact) => [contact.name, contact.handle, ...contact.channels, ...contact.tags].join(' ').toLowerCase().includes(query));
  }, [contacts, search]);

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading"><div><span>Contacts</span><h1>A continuous customer record.</h1><p>Profiles, conversation history, tags, and approved notes stay with the customer.</p></div></header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      {!loading && !contacts.length ? (
        <section className="workspace-empty"><span><ContactRound aria-hidden="true" /></span><h2>Contacts appear with real conversations</h2><p>ORIN AI does not create sample customers or pretend activity is live.</p></section>
      ) : (
        <section className="contacts-panel">
          <header><label><Search aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="Search contacts, channels, or tags" /></label><span>{loading ? 'Loading…' : `${filtered.length} contacts`}</span></header>
          <div className="contacts-table" role="table" aria-label="Workspace contacts">
            <div role="row" className="contacts-table__heading"><span role="columnheader">Contact</span><span role="columnheader">Channels</span><span role="columnheader">Tags</span><span role="columnheader">Last seen</span></div>
            {filtered.map((contact) => (
              <article role="row" key={contact.id}>
                <span role="cell"><b>{contact.name.charAt(0).toUpperCase()}</b><span><strong>{contact.name}</strong><small>{contact.handle || 'No public handle'}</small></span></span>
                <span role="cell">{contact.channels.join(', ') || '—'}</span>
                <span role="cell">{contact.tags.length ? contact.tags.map((tag) => <i key={tag}>{tag}</i>) : '—'}</span>
                <span role="cell">{contact.lastSeenAt?.toDate().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) || '—'}</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
