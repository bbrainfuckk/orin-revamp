import { addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, type Timestamp } from 'firebase/firestore';
import { Check, Plus, Workflow, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type Automation = { id: string; name: string; trigger: string; action: string; status: 'draft' | 'active' | 'paused'; updatedAt?: Timestamp };

const triggerOptions = ['New conversation', 'Lead captured', 'Human escalation requested', 'Conversation resolved', 'Attributed order or booking'];
const actionOptions = ['Send to n8n', 'Notify a team member', 'Add a contact tag', 'Call a verified webhook', 'Create a follow-up task'];

export function AutomationsPage() {
  const { user, workspace } = useAuth();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');
  const [action, setAction] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'automations'), (snapshot) => {
      setAutomations(snapshot.docs.map((automation) => ({
        id: automation.id,
        name: typeof automation.data().name === 'string' ? automation.data().name : 'Untitled automation',
        trigger: typeof automation.data().trigger === 'string' ? automation.data().trigger : '',
        action: typeof automation.data().action === 'string' ? automation.data().action : '',
        status: ['draft', 'active', 'paused'].includes(automation.data().status) ? automation.data().status : 'draft',
        updatedAt: automation.data().updatedAt as Timestamp | undefined,
      })).sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0)));
      setError('');
    }, (cause) => setError(cause.message));
  }, [workspace]);

  const saveAutomation = async () => {
    if (!db || !workspace || !user || !name.trim() || !trigger || !action) return;
    setSaving(true);
    setError('');
    try {
      await addDoc(collection(db, 'workspaces', workspace.id, 'automations'), {
        name: name.trim(), trigger, action, status: 'draft', createdBy: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      setOpen(false); setName(''); setTrigger(''); setAction('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The automation draft could not be saved.');
    } finally { setSaving(false); }
  };

  const removeAutomation = async (automationId: string) => {
    if (!db || !workspace) return;
    setError('');
    try {
      await deleteDoc(doc(db, 'workspaces', workspace.id, 'automations', automationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The automation draft could not be removed.');
    }
  };

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading"><div><span>Automations</span><h1>Turn a conversation into the next action.</h1><p>Route leads, notify teams, update systems, or call an n8n workflow after a verified event.</p></div><button type="button" className="workspace-primary-action" onClick={() => setOpen(true)}><Plus aria-hidden="true" /> New automation</button></header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      {automations.length ? <section className="automation-list">{automations.map((automation) => <article key={automation.id}><span><Workflow aria-hidden="true" /></span><div><strong>{automation.name}</strong><p><b>When</b> {automation.trigger} <i>→</i> <b>Then</b> {automation.action}</p></div><div className="automation-list__actions"><small className={`is-${automation.status}`}>{automation.status}</small><button type="button" onClick={() => removeAutomation(automation.id)}>Remove</button></div></article>)}</section> : <section className="workspace-empty"><span><Workflow aria-hidden="true" /></span><h2>No automations yet</h2><p>Create an AI and connect a destination before activating an automation.</p><button type="button" className="workspace-secondary-action" onClick={() => setOpen(true)}>Create an automation draft</button></section>}
      {open && <div className="automation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-title"><header><div><span>New automation</span><h2 id="automation-title">Define one clear handoff.</h2></div><button type="button" aria-label="Close automation builder" onClick={() => setOpen(false)}><X aria-hidden="true" /></button></header><div className="automation-dialog__body"><label><span>Automation name</span><input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Example: Send qualified leads to sales" /></label><fieldset><legend>When this happens</legend>{triggerOptions.map((option) => <button key={option} type="button" className={trigger === option ? 'is-selected' : ''} onClick={() => setTrigger(option)}><span>{option}</span>{trigger === option && <Check aria-hidden="true" />}</button>)}</fieldset><fieldset><legend>Do this next</legend>{actionOptions.map((option) => <button key={option} type="button" className={action === option ? 'is-selected' : ''} onClick={() => setAction(option)}><span>{option}</span>{action === option && <Check aria-hidden="true" />}</button>)}</fieldset><p>This saves a draft. Activation stays unavailable until the destination connection and event delivery both pass verification.</p></div><footer><button type="button" onClick={() => setOpen(false)}>Cancel</button><button type="button" className="is-primary" disabled={saving || !name.trim() || !trigger || !action} onClick={saveAutomation}>{saving ? 'Saving…' : 'Save draft'}</button></footer></section></div>}
    </div>
  );
}
