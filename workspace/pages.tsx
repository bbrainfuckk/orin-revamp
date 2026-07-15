import {
  ArrowRight,
  Bot,
  ChartNoAxesCombined,
  Check,
  Circle,
  Network,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  type Timestamp,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';
import { formatResponseTime, useWorkspaceEvents } from '../services/workspace-events';

function PageHeading({ eyebrow, title, body, action }: { eyebrow: string; title: string; body: string; action?: React.ReactNode }) {
  return (
    <header className="workspace-page-heading">
      <div><span>{eyebrow}</span><h1>{title}</h1><p>{body}</p></div>
      {action}
    </header>
  );
}

function EmptySurface({ icon: Icon, title, body, action }: { icon: typeof Bot; title: string; body: string; action?: React.ReactNode }) {
  return (
    <section className="workspace-empty">
      <span><Icon aria-hidden="true" /></span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}

export function OverviewPage() {
  const { user, workspace } = useAuth();
  const { loading, metrics } = useWorkspaceEvents(workspace?.id);
  const firstName = user?.displayName?.split(' ')[0] || 'there';

  return (
    <div className="workspace-page">
      <PageHeading
        eyebrow="Overview"
        title={`Good to have you here, ${firstName}.`}
        body="Build the front desk, connect the places customers reach you, then publish when every answer is ready."
        action={<Link className="workspace-primary-action" to="/app/agents/new"><Plus aria-hidden="true" /> Create ORIN AI</Link>}
      />

      <section className="workspace-onboarding">
        <div className="workspace-onboarding__copy">
          <span>Start here</span>
          <h2>Take ORIN AI from a brief to a working front desk.</h2>
          <p>Nothing goes live until you review its knowledge, voice, rules, and connected channels.</p>
          <Link to="/app/agents/new">Build your first AI <ArrowRight aria-hidden="true" /></Link>
        </div>
        <ol className="workspace-steps">
          <li><span><Circle aria-hidden="true" /></span><div><strong>Define the AI</strong><small>Purpose, knowledge, voice, and rules</small></div></li>
          <li><span><Circle aria-hidden="true" /></span><div><strong>Connect a channel</strong><small>Messenger, Instagram, TikTok, web, and more</small></div></li>
          <li><span><Circle aria-hidden="true" /></span><div><strong>Test real questions</strong><small>Review answers before customers see them</small></div></li>
          <li><span><Circle aria-hidden="true" /></span><div><strong>Publish</strong><small>Turn on only the channels you approve</small></div></li>
        </ol>
      </section>

      <section className="workspace-metric-grid" aria-label="Workspace activity">
        {[
          ['Conversations', loading ? '—' : metrics.conversations.toLocaleString('en-PH'), metrics.conversations ? 'Recorded workspace conversations' : 'Waiting for a connected channel'],
          ['Resolved by ORIN AI', loading ? '—' : `${metrics.resolutionRate}%`, metrics.conversations ? `${metrics.resolved.toLocaleString('en-PH')} resolved conversations` : 'No live conversations yet'],
          ['Escalated to your team', loading ? '—' : `${metrics.escalationRate}%`, metrics.conversations ? `${metrics.escalated.toLocaleString('en-PH')} escalated conversations` : 'No live conversations yet'],
          ['Median first response', loading ? '—' : formatResponseTime(metrics.medianFirstResponseMs), metrics.medianFirstResponseMs === null ? 'Measured after launch' : 'Across recorded first responses'],
        ].map(([label, value, note]) => (
          <article key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
        ))}
      </section>
    </div>
  );
}

export function AgentsPage() {
  const { workspace } = useAuth();
  const [agents, setAgents] = useState<Array<{ id: string; name: string; purpose: string; readiness: number; updatedAt?: Timestamp }>>([]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'agents'), (snapshot) => {
      setAgents(snapshot.docs
        .map((agent) => ({
          id: agent.id,
          name: typeof agent.data().name === 'string' ? agent.data().name : 'Untitled ORIN AI',
          purpose: typeof agent.data().purpose === 'string' ? agent.data().purpose : '',
          readiness: typeof agent.data().readiness === 'number' ? agent.data().readiness : 0,
          updatedAt: agent.data().updatedAt as Timestamp | undefined,
        }))
        .sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0)));
    });
  }, [workspace]);

  return (
    <div className="workspace-page">
      <PageHeading eyebrow="AI agents" title="Your customer-facing team." body="Each AI has its own knowledge, voice, responsibilities, rules, and channel access." action={<Link className="workspace-primary-action" to="/app/agents/new"><Plus aria-hidden="true" /> Create AI</Link>} />
      {agents.length ? (
        <section className="agent-list" aria-label="Saved AI agents">
          {agents.map((agent) => (
            <article key={agent.id}>
              <span className="agent-list__mark"><Bot aria-hidden="true" /></span>
              <div><strong>{agent.name}</strong><p>{agent.purpose || 'Continue the setup to define its primary role.'}</p></div>
              <span className="agent-list__readiness">{agent.readiness}/6 decisions</span>
              <Link to="/app/agents/new">Continue setup <ArrowRight aria-hidden="true" /></Link>
            </article>
          ))}
        </section>
      ) : <EmptySurface icon={Bot} title="Create your first ORIN AI" body="Start from your saved website brief or build the configuration step by step." action={<Link className="workspace-secondary-action" to="/app/agents/new">Open the AI studio</Link>} />}
    </div>
  );
}

type IntegrationStatus = 'authorization_required' | 'configuration_required' | 'access_review' | 'connected' | 'attention_required';

type IntegrationCatalogItem = {
  id: 'meta' | 'tiktok' | 'airbnb' | 'commerce' | 'website' | 'n8n';
  name: string;
  body: string;
  setupLabel: string;
  options: string[];
  initialStatus: IntegrationStatus;
};

type WorkspaceConnection = {
  id: string;
  provider: IntegrationCatalogItem['id'];
  displayName: string;
  status: IntegrationStatus;
  desiredChannels: string[];
  updatedAt?: Timestamp;
};

const integrations: IntegrationCatalogItem[] = [
  { id: 'meta', name: 'Meta', body: 'Facebook Pages, Messenger, and Instagram', setupLabel: 'Page or account name', options: ['Facebook Pages', 'Messenger', 'Instagram'], initialStatus: 'authorization_required' },
  { id: 'tiktok', name: 'TikTok', body: 'Customer and commerce conversations', setupLabel: 'TikTok account name', options: ['TikTok messages', 'TikTok Shop inquiries', 'Lead capture'], initialStatus: 'authorization_required' },
  { id: 'airbnb', name: 'Airbnb', body: 'Guest questions and stay information', setupLabel: 'Listing or host account', options: ['Pre-arrival questions', 'Stay information', 'Routine guest requests'], initialStatus: 'access_review' },
  { id: 'commerce', name: 'Commerce', body: 'Shopee, Lazada, and Shopify', setupLabel: 'Store name', options: ['Shopee', 'Lazada', 'Shopify'], initialStatus: 'authorization_required' },
  { id: 'website', name: 'Website', body: 'ORIN AI chat for your own site', setupLabel: 'Website name', options: ['Website chat', 'Lead capture', 'Knowledge answers'], initialStatus: 'configuration_required' },
  { id: 'n8n', name: 'n8n Cloud', body: 'Cloud webhooks and workflow orchestration', setupLabel: 'Workflow name', options: ['New conversation', 'Lead captured', 'Human escalation', 'Order or booking attributed'], initialStatus: 'configuration_required' },
];

const statusCopy: Record<IntegrationStatus, string> = {
  authorization_required: 'Authorization required',
  configuration_required: 'Configuration required',
  access_review: 'Access review required',
  connected: 'Connected',
  attention_required: 'Needs attention',
};

export function IntegrationsPage() {
  const { user, workspace } = useAuth();
  const [connections, setConnections] = useState<WorkspaceConnection[]>([]);
  const [selected, setSelected] = useState<IntegrationCatalogItem | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [desiredChannels, setDesiredChannels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      setConnections(snapshot.docs.map((connection) => ({
        id: connection.id,
        provider: connection.data().provider as WorkspaceConnection['provider'],
        displayName: typeof connection.data().displayName === 'string' ? connection.data().displayName : 'Untitled connection',
        status: connection.data().status as IntegrationStatus,
        desiredChannels: Array.isArray(connection.data().desiredChannels) ? connection.data().desiredChannels : [],
        updatedAt: connection.data().updatedAt as Timestamp | undefined,
      })).sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0)));
    }, (cause) => setError(cause.message));
  }, [workspace]);

  const openSetup = (integration: IntegrationCatalogItem) => {
    setSelected(integration);
    setDisplayName('');
    setDesiredChannels([]);
    setWebhookUrl('');
    setTestState('idle');
    setTestMessage('');
    setError('');
  };

  const toggleDesiredChannel = (value: string) => {
    setDesiredChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const saveSetup = async () => {
    if (!db || !workspace || !user || !selected || !displayName.trim() || !desiredChannels.length) return;
    setSaving(true);
    setError('');
    try {
      await addDoc(collection(db, 'workspaces', workspace.id, 'connections'), {
        provider: selected.id,
        displayName: displayName.trim(),
        status: selected.initialStatus,
        desiredChannels,
        credentialState: 'not_supplied',
        health: 'not_tested',
        ...(selected.id === 'n8n' && testState === 'success' ? {
          health: 'test_passed',
          deployment: 'n8n_cloud',
          testedEndpointHost: new URL(webhookUrl).hostname,
          lastTestAt: serverTimestamp(),
        } : {}),
        createdBy: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connection setup could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const testN8nWebhook = async () => {
    if (!user || !workspace || !webhookUrl.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/integrations/n8n/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId: workspace.id, webhookUrl: webhookUrl.trim() }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'The n8n webhook test failed.');
      setTestState('success');
      setTestMessage('Test event delivered. Save this setup to record the successful check.');
    } catch (cause) {
      setTestState('error');
      setTestMessage(cause instanceof Error ? cause.message : 'The n8n webhook test failed.');
    }
  };

  const removeDraft = async (connectionId: string) => {
    if (!db || !workspace) return;
    setError('');
    try {
      await deleteDoc(doc(db, 'workspaces', workspace.id, 'connections', connectionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connection draft could not be removed.');
    }
  };

  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Integrations" title="Meet customers where they already are." body="A channel only shows as connected after authorization and a successful health check." />
      {connections.length > 0 && (
        <section className="connection-list" aria-labelledby="saved-connections-title">
          <header><div><span>Workspace connections</span><h2 id="saved-connections-title">Setup in progress</h2></div><small>{connections.length} saved</small></header>
          {connections.map((connection) => {
            const catalogItem = integrations.find((item) => item.id === connection.provider);
            return (
              <article key={connection.id}>
                <span className="connection-list__mark"><Network aria-hidden="true" /></span>
                <div><strong>{connection.displayName}</strong><p>{catalogItem?.name || connection.provider} · {connection.desiredChannels.join(', ')}</p></div>
                <span className={`connection-status is-${connection.status}`}>{statusCopy[connection.status] || 'Setup required'}</span>
                <button type="button" onClick={() => removeDraft(connection.id)}>Remove</button>
              </article>
            );
          })}
        </section>
      )}
      <section className="integration-list">
        {integrations.map((integration) => (
          <article key={integration.id}>
            <span className="integration-list__icon"><Network aria-hidden="true" /></span>
            <div><strong>{integration.name}</strong><p>{integration.body}</p></div>
            <span className="integration-list__status">{statusCopy[integration.initialStatus]}</span>
            <button type="button" onClick={() => openSetup(integration)}>Set up</button>
          </article>
        ))}
      </section>
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}

      {selected && (
        <div className="integration-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelected(null);
        }}>
          <section className="integration-dialog" role="dialog" aria-modal="true" aria-labelledby="integration-dialog-title">
            <header>
              <div><span>{selected.name}</span><h2 id="integration-dialog-title">Prepare the connection.</h2></div>
              <button type="button" aria-label="Close connection setup" onClick={() => setSelected(null)}><X aria-hidden="true" /></button>
            </header>
            <div className="integration-dialog__body">
              <p>Tell ORIN AI what you intend to connect. Authorization and credentials stay separate, and this connection will not appear live until its health check passes.</p>
              <label><span>{selected.setupLabel}</span><input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} placeholder={`Example: ${selected.name} main account`} /></label>
              <fieldset>
                <legend>What should this connection handle?</legend>
                {selected.options.map((option) => (
                  <button key={option} type="button" className={desiredChannels.includes(option) ? 'is-selected' : ''} aria-pressed={desiredChannels.includes(option)} onClick={() => toggleDesiredChannel(option)}>
                    <span>{option}</span>{desiredChannels.includes(option) && <Check aria-hidden="true" />}
                  </button>
                ))}
              </fieldset>
              {selected.id === 'n8n' && (
                <>
                  <div className="integration-deployment-options" aria-label="n8n deployment type">
                    <button type="button" className="is-selected" aria-pressed="true"><span><strong>n8n Cloud</strong><small>Connect a hosted n8n workflow</small></span><Check aria-hidden="true" /></button>
                    <button type="button" disabled><span><strong>Self-hosted server</strong><small>Coming soon</small></span></button>
                  </div>
                  <div className="integration-webhook-test">
                    <label><span>n8n Cloud test webhook URL</span><input type="url" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.currentTarget.value); setTestState('idle'); setTestMessage(''); }} placeholder="https://your-workspace.app.n8n.cloud/webhook/..." /></label>
                    <button type="button" disabled={testState === 'testing' || !webhookUrl.trim()} onClick={testN8nWebhook}>{testState === 'testing' ? 'Sending test…' : 'Send test event'}</button>
                    {testMessage && <p className={`is-${testState}`} role="status">{testMessage}</p>}
                  </div>
                </>
              )}
              <div className="integration-dialog__trust"><Settings aria-hidden="true" /><p><strong>No access token is requested here.</strong> This saves a private setup record so you can resume. Provider authorization opens only when the corresponding backend credentials are ready.</p></div>
            </div>
            <footer><button type="button" onClick={() => setSelected(null)}>Cancel</button><button type="button" className="is-primary" disabled={saving || !displayName.trim() || !desiredChannels.length} onClick={saveSetup}>{saving ? 'Saving…' : 'Save setup'}</button></footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function AnalyticsPage() {
  const { workspace } = useAuth();
  const { channels, error, events, loading, metrics } = useWorkspaceEvents(workspace?.id);
  const currency = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
  const largestChannel = channels[0]?.count || 0;

  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Analytics" title="Know what ORIN AI is changing." body="Results are calculated from real workspace events; estimates stay clearly labelled." />
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}
      <section className="analytics-summary" aria-label="Workspace analytics summary">
        <article><span>Conversations</span><strong>{loading ? '—' : metrics.conversations.toLocaleString('en-PH')}</strong><small>Started across connected channels</small></article>
        <article><span>Resolution rate</span><strong>{loading ? '—' : `${metrics.resolutionRate}%`}</strong><small>{metrics.resolved.toLocaleString('en-PH')} resolved by ORIN AI</small></article>
        <article><span>Leads captured</span><strong>{loading ? '—' : metrics.leads.toLocaleString('en-PH')}</strong><small>Recorded lead events</small></article>
        <article><span>Attributed value</span><strong>{loading ? '—' : currency.format(metrics.attributedValue)}</strong><small>Only verified value events</small></article>
      </section>

      {events.length ? (
        <section className="analytics-detail-grid">
          <article className="analytics-channel-card">
            <header><span>Channel mix</span><strong>Conversation starts</strong></header>
            <div>{channels.map((channel) => (
              <div key={channel.name}><span>{channel.name}</span><i><b style={{ width: `${largestChannel ? (channel.count / largestChannel) * 100 : 0}%` }} /></i><strong>{channel.count.toLocaleString('en-PH')}</strong></div>
            ))}</div>
          </article>
          <article className="analytics-operations-card">
            <header><span>Operating quality</span><strong>Customer response</strong></header>
            <dl>
              <div><dt>Median first response</dt><dd>{formatResponseTime(metrics.medianFirstResponseMs)}</dd></div>
              <div><dt>Human escalation</dt><dd>{metrics.escalationRate}%</dd></div>
              <div><dt>Events recorded</dt><dd>{events.length.toLocaleString('en-PH')}</dd></div>
            </dl>
          </article>
        </section>
      ) : (
        <section className="analytics-empty">
          <div><ChartNoAxesCombined aria-hidden="true" /><h2>Analytics begin with the first conversation.</h2><p>Connect a channel and publish an AI to measure response time, resolution, escalation, and attributed outcomes.</p></div>
          <dl>
            <div><dt>Conversations</dt><dd>0</dd></div>
            <div><dt>Resolution rate</dt><dd>0%</dd></div>
            <div><dt>Leads captured</dt><dd>0</dd></div>
            <div><dt>Attributed value</dt><dd>₱0</dd></div>
          </dl>
        </section>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { user } = useAuth();
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Settings" title="Workspace settings." body="Manage the workspace identity, account, members, and security." />
      <section className="settings-panel">
        <div><span><Settings aria-hidden="true" /></span><div><strong>Account</strong><p>{user?.email}</p></div><span className="settings-panel__verified"><Check aria-hidden="true" /> Google verified</span></div>
        <div><span><Network aria-hidden="true" /></span><div><strong>Workspace</strong><p>My workspace</p></div><button type="button" disabled>Edit</button></div>
      </section>
    </div>
  );
}
