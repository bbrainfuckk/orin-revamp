import { addDoc, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query, serverTimestamp, updateDoc, type Timestamp } from 'firebase/firestore';
import { Check, CheckCircle2, Clock3, Plus, Tag, Workflow, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type ActionConfig = { tag?: string; taskTitle?: string; delayMinutes?: number };
type Automation = {
  id: string;
  name: string;
  trigger: string;
  action: string;
  actionConfig: ActionConfig;
  status: 'draft' | 'active' | 'paused';
  updatedAt?: Timestamp;
};
type AutomationRun = { id: string; eventType: string; destination: string; status: 'succeeded' | 'failed'; error: string; updatedAt?: Timestamp };
type FollowUpTask = {
  id: string;
  title: string;
  status: 'open' | 'completed';
  contactName: string;
  channel: string;
  conversationId: string;
  dueAt?: Timestamp;
  updatedAt?: Timestamp;
};

const triggerOptions = ['New conversation', 'Lead captured', 'Human escalation', 'Conversation resolved', 'Order or booking attributed'];
const actionOptions = [
  { name: 'Send to n8n', available: true, detail: 'Deliver a signed event to your verified n8n Cloud workflow.' },
  { name: 'Add a contact tag', available: true, detail: 'Update the customer record immediately.' },
  { name: 'Create a follow-up task', available: true, detail: 'Put a due task in your team queue.' },
  { name: 'Notify a team member', available: false, detail: 'Available after team invitations are enabled.' },
  { name: 'Call a verified webhook', available: false, detail: 'Available with the verified webhook connector.' },
];
const followUpOptions = [
  { value: 15, label: '15 minutes later' },
  { value: 60, label: '1 hour later' },
  { value: 240, label: '4 hours later' },
  { value: 1_440, label: '1 day later' },
  { value: 4_320, label: '3 days later' },
  { value: 10_080, label: '7 days later' },
];

function requestId() {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `automation_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function actionSummary(automation: Automation) {
  if (automation.action === 'Add a contact tag') return automation.actionConfig.tag ? `Tag: ${automation.actionConfig.tag}` : 'Tag not configured';
  if (automation.action === 'Create a follow-up task') {
    const delay = followUpOptions.find((option) => option.value === automation.actionConfig.delayMinutes)?.label || 'schedule not configured';
    return `${automation.actionConfig.taskTitle || 'Task not configured'} · ${delay}`;
  }
  return automation.action === 'Send to n8n' ? 'Signed delivery to n8n Cloud' : 'Destination not available yet';
}

export function AutomationsPage() {
  const { user, workspace } = useAuth();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('');
  const [action, setAction] = useState('');
  const [tag, setTag] = useState('');
  const [taskTitle, setTaskTitle] = useState('Follow up with this customer');
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [saving, setSaving] = useState(false);
  const [changingId, setChangingId] = useState('');
  const [changingTaskId, setChangingTaskId] = useState('');
  const [n8nReady, setN8nReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'automations'), (snapshot) => {
      setAutomations(snapshot.docs.map((automation) => {
        const config = automation.data().actionConfig;
        return {
          id: automation.id,
          name: typeof automation.data().name === 'string' ? automation.data().name : 'Untitled automation',
          trigger: typeof automation.data().trigger === 'string' ? automation.data().trigger : '',
          action: typeof automation.data().action === 'string' ? automation.data().action : '',
          actionConfig: config && typeof config === 'object' ? {
            tag: typeof config.tag === 'string' ? config.tag : undefined,
            taskTitle: typeof config.taskTitle === 'string' ? config.taskTitle : undefined,
            delayMinutes: typeof config.delayMinutes === 'number' ? config.delayMinutes : undefined,
          } : {},
          status: ['draft', 'active', 'paused'].includes(automation.data().status) ? automation.data().status : 'draft',
          updatedAt: automation.data().updatedAt as Timestamp | undefined,
        };
      }).sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0)));
      setError('');
    }, (cause) => setError(cause.message));
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(query(collection(db, 'workspaces', workspace.id, 'automationRuns'), orderBy('updatedAt', 'desc'), limit(8)), (snapshot) => {
      setRuns(snapshot.docs.map((run) => ({
        id: run.id,
        eventType: typeof run.data().eventType === 'string' ? run.data().eventType : 'event',
        destination: typeof run.data().destination === 'string' ? run.data().destination : 'destination',
        status: run.data().status === 'succeeded' ? 'succeeded' as const : 'failed' as const,
        error: typeof run.data().error === 'string' ? run.data().error : '',
        updatedAt: run.data().updatedAt as Timestamp | undefined,
      })));
    }, (cause) => setError(cause.message));
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(query(collection(db, 'workspaces', workspace.id, 'tasks'), orderBy('dueAt', 'asc'), limit(50)), (snapshot) => {
      setTasks(snapshot.docs.map((task) => ({
        id: task.id,
        title: typeof task.data().title === 'string' ? task.data().title : 'Follow up',
        status: task.data().status === 'completed' ? 'completed' as const : 'open' as const,
        contactName: typeof task.data().contactName === 'string' ? task.data().contactName : 'Customer',
        channel: typeof task.data().channel === 'string' ? task.data().channel : '',
        conversationId: typeof task.data().conversationId === 'string' ? task.data().conversationId : '',
        dueAt: task.data().dueAt as Timestamp | undefined,
        updatedAt: task.data().updatedAt as Timestamp | undefined,
      })).sort((a, b) => {
        if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
        return (a.dueAt?.toMillis() || Number.MAX_SAFE_INTEGER) - (b.dueAt?.toMillis() || Number.MAX_SAFE_INTEGER);
      }).slice(0, 12));
    }, (cause) => setError(cause.message));
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(doc(db, 'workspaces', workspace.id, 'connections', 'n8n'), (snapshot) => {
      const data = snapshot.data();
      setN8nReady(Boolean(snapshot.exists() && data?.status === 'connected' && data?.health === 'healthy'));
    }, () => setN8nReady(false));
  }, [workspace]);

  const selectedAction = useMemo(() => actionOptions.find((option) => option.name === action), [action]);
  const configurationReady = action === 'Send to n8n'
    ? true
    : action === 'Add a contact tag'
      ? Boolean(tag.trim())
      : action === 'Create a follow-up task'
        ? Boolean(taskTitle.trim() && followUpOptions.some((option) => option.value === delayMinutes))
        : false;

  const resetBuilder = () => {
    setOpen(false);
    setName('');
    setTrigger('');
    setAction('');
    setTag('');
    setTaskTitle('Follow up with this customer');
    setDelayMinutes(60);
  };

  const saveAutomation = async () => {
    if (!db || !workspace || !user || !name.trim() || !trigger || !action || !selectedAction?.available || !configurationReady) return;
    setSaving(true);
    setError('');
    try {
      const actionConfig: ActionConfig = action === 'Add a contact tag'
        ? { tag: tag.trim().replace(/\s+/g, ' ').slice(0, 32) }
        : action === 'Create a follow-up task'
          ? { taskTitle: taskTitle.trim().slice(0, 120), delayMinutes }
          : {};
      await addDoc(collection(db, 'workspaces', workspace.id, 'automations'), {
        name: name.trim().slice(0, 120), trigger, action, actionConfig, status: 'draft', createdBy: user.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      resetBuilder();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The automation draft could not be saved.');
    } finally {
      setSaving(false);
    }
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

  const automationCanRun = (automation: Automation) => {
    if (automation.action === 'Send to n8n') return n8nReady;
    if (automation.action === 'Add a contact tag') return Boolean(automation.actionConfig.tag?.trim());
    if (automation.action === 'Create a follow-up task') return Boolean(automation.actionConfig.taskTitle?.trim() && followUpOptions.some((option) => option.value === automation.actionConfig.delayMinutes));
    return false;
  };

  const changeAutomationStatus = async (automation: Automation) => {
    if (!db || !workspace || (!automationCanRun(automation) && automation.status !== 'active')) return;
    setChangingId(automation.id);
    setError('');
    try {
      await updateDoc(doc(db, 'workspaces', workspace.id, 'automations', automation.id), {
        status: automation.status === 'active' ? 'paused' : 'active',
        updatedAt: serverTimestamp(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The automation status could not be changed.');
    } finally {
      setChangingId('');
    }
  };

  const changeTaskStatus = async (task: FollowUpTask) => {
    if (!user || !workspace || changingTaskId) return;
    setChangingTaskId(task.id);
    setError('');
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'task_update',
          action: task.status === 'completed' ? 'reopen_task' : 'complete_task',
          workspaceId: workspace.id,
          taskId: task.id,
          requestId: requestId(),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The follow-up task could not be updated.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The follow-up task could not be updated.');
    } finally {
      setChangingTaskId('');
    }
  };

  return (
    <div className="workspace-page">
      <header className="workspace-page-heading">
        <div><span>Automations</span><h1>Turn a conversation into the next action.</h1><p>Tag customers, create follow-ups, or send signed events to n8n after a verified trigger.</p></div>
        <button type="button" className="workspace-primary-action" onClick={() => setOpen(true)}><Plus aria-hidden="true" /> New automation</button>
      </header>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}

      {automations.length ? <section className="automation-list">{automations.map((automation) => {
        const canRun = automationCanRun(automation);
        const statusTitle = automation.action === 'Send to n8n' && !n8nReady
          ? 'Connect and verify n8n Cloud before activating this automation.'
          : !canRun ? 'Complete this action configuration before activation.' : '';
        return <article key={automation.id}>
          <span><Workflow aria-hidden="true" /></span>
          <div><strong>{automation.name}</strong><p><b>When</b> {automation.trigger} <i>→</i> <b>Then</b> {automation.action}</p><em>{actionSummary(automation)}</em></div>
          <div className="automation-list__actions">
            <small className={`is-${automation.status}`}>{automation.status}</small>
            {['Send to n8n', 'Add a contact tag', 'Create a follow-up task'].includes(automation.action) && <button type="button" className="is-status" title={statusTitle} disabled={changingId === automation.id || (!canRun && automation.status !== 'active')} onClick={() => void changeAutomationStatus(automation)}>{changingId === automation.id ? 'Saving…' : automation.status === 'active' ? 'Pause' : 'Activate'}</button>}
            <button type="button" onClick={() => void removeAutomation(automation.id)}>Remove</button>
          </div>
        </article>;
      })}</section> : <section className="workspace-empty"><span><Workflow aria-hidden="true" /></span><h2>No automations yet</h2><p>Create an automation now. Connect n8n only if the workflow needs an external system.</p><button type="button" className="workspace-secondary-action" onClick={() => setOpen(true)}>Create an automation</button></section>}

      {tasks.length > 0 && <section className="automation-tasks" aria-labelledby="follow-up-tasks-title">
        <header><div><span>Team queue</span><h2 id="follow-up-tasks-title">Follow-up tasks</h2></div><small>{tasks.filter((task) => task.status === 'open').length} open</small></header>
        {tasks.map((task) => <article key={task.id} className={`is-${task.status}`}>
          <span>{task.status === 'completed' ? <CheckCircle2 aria-hidden="true" /> : <Clock3 aria-hidden="true" />}</span>
          <div><strong>{task.title}</strong><small>{task.contactName}{task.channel ? ` · ${task.channel}` : ''}</small></div>
          <time>{task.dueAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'No due time'}</time>
          {task.conversationId ? <Link to="/app/inbox">Open inbox</Link> : <span />}
          <button type="button" disabled={changingTaskId === task.id} onClick={() => void changeTaskStatus(task)}>{changingTaskId === task.id ? 'Saving…' : task.status === 'completed' ? 'Reopen' : 'Complete'}</button>
        </article>)}
      </section>}

      {runs.length > 0 && <section className="automation-runs" aria-labelledby="automation-runs-title">
        <header><div><span>Execution history</span><h2 id="automation-runs-title">Recent verified runs</h2></div><small>Latest {runs.length}</small></header>
        {runs.map((run) => <article key={run.id}><span className={`is-${run.status}`}>{run.status}</span><div><strong>{run.eventType.replaceAll('.', ' ')}</strong><small>{run.destination}{run.error ? ` · ${run.error}` : ''}</small></div><time>{run.updatedAt?.toDate().toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) || 'Pending timestamp'}</time></article>)}
      </section>}

      {open && <div className="automation-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) resetBuilder(); }}>
        <section className="automation-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-title">
          <header><div><span>New automation</span><h2 id="automation-title">Define one clear next step.</h2></div><button type="button" aria-label="Close automation builder" onClick={resetBuilder}><X aria-hidden="true" /></button></header>
          <div className="automation-dialog__body">
            <label><span>Automation name</span><input value={name} maxLength={120} onChange={(event) => setName(event.currentTarget.value)} placeholder="Example: Tag every new sales inquiry" /></label>
            <fieldset><legend>When this happens</legend>{triggerOptions.map((option) => <button key={option} type="button" className={trigger === option ? 'is-selected' : ''} onClick={() => setTrigger(option)}><span>{option}</span>{trigger === option && <Check aria-hidden="true" />}</button>)}</fieldset>
            <fieldset><legend>Do this next</legend>{actionOptions.map((option) => <button key={option.name} type="button" disabled={!option.available} title={option.detail} className={action === option.name ? 'is-selected' : ''} onClick={() => option.available && setAction(option.name)}><span>{option.name}<small>{option.available ? option.detail : 'Coming next'}</small></span>{action === option.name && <Check aria-hidden="true" />}</button>)}</fieldset>

            {action === 'Add a contact tag' && <section className="automation-action-config"><Tag aria-hidden="true" /><label><span>Tag to add</span><input value={tag} maxLength={32} onChange={(event) => setTag(event.currentTarget.value)} placeholder="Example: Qualified lead" /><small>Existing tags are preserved. Duplicate tags are ignored.</small></label></section>}
            {action === 'Create a follow-up task' && <section className="automation-action-config"><Clock3 aria-hidden="true" /><div><label><span>Task title</span><input value={taskTitle} maxLength={120} onChange={(event) => setTaskTitle(event.currentTarget.value)} /></label><label><span>Due</span><select value={delayMinutes} onChange={(event) => setDelayMinutes(Number(event.currentTarget.value))}>{followUpOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div></section>}
            <p>{action === 'Send to n8n' ? (n8nReady ? 'The event will be signed and sent only after you activate this automation.' : 'Save the draft now, then connect n8n Cloud before activation.') : selectedAction?.detail || 'Choose an action to continue.'}</p>
          </div>
          <footer><button type="button" onClick={resetBuilder}>Cancel</button><button type="button" className="is-primary" disabled={saving || !name.trim() || !trigger || !action || !selectedAction?.available || !configurationReady} onClick={() => void saveAutomation()}>{saving ? 'Saving…' : 'Save draft'}</button></footer>
        </section>
      </div>}
    </div>
  );
}
