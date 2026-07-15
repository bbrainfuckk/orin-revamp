import {
  ArrowRight,
  Bot,
  ChartNoAxesCombined,
  Check,
  Circle,
  Copy,
  ExternalLink,
  Network,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
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
  const [agents, setAgents] = useState<Array<{ id: string; name: string; purpose: string; readiness: number; status: 'active' | 'draft'; updatedAt?: Timestamp }>>([]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'agents'), (snapshot) => {
      setAgents(snapshot.docs
        .map((agent) => ({
          id: agent.id,
          name: typeof agent.data().name === 'string' ? agent.data().name : 'Untitled ORIN AI',
          purpose: typeof agent.data().purpose === 'string' ? agent.data().purpose : '',
          readiness: typeof agent.data().readiness === 'number' ? agent.data().readiness : 0,
          status: agent.data().status === 'active' ? 'active' as const : 'draft' as const,
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
              <span className="agent-list__readiness">{agent.status === 'active' ? 'Live' : 'Draft'} · {agent.readiness}/6 decisions</span>
              <Link to={`/app/agents/${encodeURIComponent(agent.id)}`}>Edit AI <ArrowRight aria-hidden="true" /></Link>
            </article>
          ))}
        </section>
      ) : <EmptySurface icon={Bot} title="Create your first ORIN AI" body="Start from your saved website brief or build the configuration step by step." action={<Link className="workspace-secondary-action" to="/app/agents/new">Open the AI studio</Link>} />}
    </div>
  );
}

type IntegrationStatus = 'authorization_required' | 'configuration_required' | 'access_review' | 'connected' | 'attention_required';

type IntegrationCatalogItem = {
  id: 'meta' | 'tiktok' | 'shopee' | 'lazada' | 'shopify' | 'airbnb' | 'website' | 'n8n';
  name: string;
  body: string;
  setupLabel: string;
  options: string[];
  initialStatus: IntegrationStatus;
};

type ProviderCapability = {
  authorizationReady: boolean;
  partnerAccessRequired?: boolean;
  selfHostedReady?: boolean;
  webhookReady?: boolean;
};

type WorkspaceConnection = {
  id: string;
  provider: IntegrationCatalogItem['id'];
  displayName: string;
  status: IntegrationStatus;
  desiredChannels: string[];
  authorizationStatus: string;
  health: string;
  publicWidgetKey?: string;
  agentId?: string;
  allowedOrigins?: string[];
  shopDomain?: string;
  updatedAt?: Timestamp;
};

type WebsiteAgent = { id: string; name: string; businessName: string; readiness: number; channels: string[] };

const integrations: IntegrationCatalogItem[] = [
  { id: 'meta', name: 'Meta', body: 'Facebook Pages, Messenger, and Instagram', setupLabel: 'Page or account name', options: ['Facebook Pages', 'Messenger', 'Instagram'], initialStatus: 'authorization_required' },
  { id: 'tiktok', name: 'TikTok', body: 'Customer and commerce conversations', setupLabel: 'TikTok account name', options: ['TikTok messages', 'TikTok Shop inquiries', 'Lead capture'], initialStatus: 'authorization_required' },
  { id: 'shopee', name: 'Shopee', body: 'Store events, orders, and customer service', setupLabel: 'Shopee store name', options: ['Orders and fulfilment', 'Customer service events', 'Product questions'], initialStatus: 'access_review' },
  { id: 'lazada', name: 'Lazada', body: 'Store events, orders, and customer service', setupLabel: 'Lazada store name', options: ['Orders and fulfilment', 'Customer service events', 'Product questions'], initialStatus: 'access_review' },
  { id: 'shopify', name: 'Shopify', body: 'Store, customer, and order events', setupLabel: 'Shopify store name', options: ['Orders', 'Customers', 'Store events'], initialStatus: 'authorization_required' },
  { id: 'airbnb', name: 'Airbnb', body: 'Guest questions and stay information', setupLabel: 'Listing or host account', options: ['Pre-arrival questions', 'Stay information', 'Routine guest requests'], initialStatus: 'access_review' },
  { id: 'website', name: 'Website', body: 'ORIN AI chat for your own site', setupLabel: 'Website name', options: ['Website chat', 'Lead capture', 'Knowledge answers'], initialStatus: 'configuration_required' },
  { id: 'n8n', name: 'n8n', body: 'Link n8n Cloud workflows to ORIN AI events', setupLabel: 'Workflow name', options: ['New conversation', 'Lead captured', 'Human escalation', 'Order or booking attributed'], initialStatus: 'configuration_required' },
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
  const [searchParams] = useSearchParams();
  const [connections, setConnections] = useState<WorkspaceConnection[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ProviderCapability>>({
    n8n: { authorizationReady: false, selfHostedReady: false },
    website: { authorizationReady: false },
  });
  const [selected, setSelected] = useState<IntegrationCatalogItem | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [desiredChannels, setDesiredChannels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [providerAction, setProviderAction] = useState<'idle' | 'opening'>('idle');
  const [vaultHealth, setVaultHealth] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [websiteAgents, setWebsiteAgents] = useState<WebsiteAgent[]>([]);
  const [websiteAgentId, setWebsiteAgentId] = useState('');
  const [metaAgentId, setMetaAgentId] = useState('');
  const [websiteOrigins, setWebsiteOrigins] = useState('');
  const [websiteEmbed, setWebsiteEmbed] = useState('');
  const [websiteState, setWebsiteState] = useState<'idle' | 'publishing' | 'success' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [shopDomain, setShopDomain] = useState('');

  const oauthProvider = searchParams.get('provider');
  const oauthStatus = searchParams.get('status');

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      setConnections(snapshot.docs.map((connection) => ({
        id: connection.id,
        provider: connection.data().provider as WorkspaceConnection['provider'],
        displayName: typeof connection.data().displayName === 'string' ? connection.data().displayName : 'Untitled connection',
        status: connection.data().status as IntegrationStatus,
        desiredChannels: Array.isArray(connection.data().desiredChannels) ? connection.data().desiredChannels : [],
        authorizationStatus: typeof connection.data().authorizationStatus === 'string' ? connection.data().authorizationStatus : '',
        health: typeof connection.data().health === 'string' ? connection.data().health : '',
        publicWidgetKey: typeof connection.data().publicWidgetKey === 'string' ? connection.data().publicWidgetKey : undefined,
        agentId: typeof connection.data().agentId === 'string' ? connection.data().agentId : undefined,
        allowedOrigins: Array.isArray(connection.data().allowedOrigins) ? connection.data().allowedOrigins : undefined,
        shopDomain: typeof connection.data().shopDomain === 'string' ? connection.data().shopDomain : undefined,
        updatedAt: connection.data().updatedAt as Timestamp | undefined,
      })).sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0)));
    }, (cause) => setError(cause.message));
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'agents'), (snapshot) => {
      setWebsiteAgents(snapshot.docs.map((agent) => {
        const config = agent.data().config as { channels?: unknown } | undefined;
        return {
          id: agent.id,
          name: typeof agent.data().name === 'string' ? agent.data().name : 'Untitled ORIN AI',
          businessName: typeof agent.data().businessName === 'string' ? agent.data().businessName : '',
          readiness: typeof agent.data().readiness === 'number' ? agent.data().readiness : 0,
          channels: Array.isArray(config?.channels) ? config.channels.filter((item): item is string => typeof item === 'string') : [],
        };
      }).sort((a, b) => b.readiness - a.readiness));
    }, (cause) => setError(cause.message));
  }, [workspace]);

  useEffect(() => {
    let active = true;
    fetch('/api/integrations/capabilities', { headers: { Accept: 'application/json' } })
      .then(async (response) => {
        const payload = await response.json() as { providers?: Record<string, ProviderCapability> };
        if (active && response.ok && payload.providers) setCapabilities(payload.providers);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user || !workspace) return undefined;
    let active = true;
    setVaultHealth('checking');
    user.getIdToken()
      .then((token) => fetch(`/api/integrations/vault/health?workspaceId=${encodeURIComponent(workspace.id)}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      }))
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { ready?: boolean };
        if (active) setVaultHealth(response.ok && payload.ready ? 'ready' : 'unavailable');
      })
      .catch(() => { if (active) setVaultHealth('unavailable'); });
    return () => { active = false; };
  }, [user, workspace]);

  const n8nReady = Boolean(capabilities.n8n?.authorizationReady && vaultHealth === 'ready');
  const websiteReady = Boolean(capabilities.website?.authorizationReady && vaultHealth === 'ready');

  const openSetup = (integration: IntegrationCatalogItem) => {
    const existing = connections.find((connection) => connection.provider === integration.id);
    setSelected(integration);
    setDisplayName(existing?.displayName || '');
    setDesiredChannels(existing?.desiredChannels || []);
    setWebhookUrl('');
    setTestState('idle');
    setTestMessage('');
    setProviderAction('idle');
    setWebsiteAgentId(existing?.agentId || '');
    setMetaAgentId(existing?.agentId || '');
    setWebsiteOrigins(existing?.allowedOrigins?.join('\n') || '');
    setWebsiteEmbed(existing?.publicWidgetKey ? `<script src="https://www.orin.work/orin-widget.js" data-orin-widget="${existing.publicWidgetKey}" async></script>` : '');
    setWebsiteState(existing?.publicWidgetKey ? 'success' : 'idle');
    setCopyState('idle');
    setShopDomain(existing?.shopDomain || '');
    setError('');
  };

  const toggleDesiredChannel = (value: string) => {
    setDesiredChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const saveSetup = async () => {
    if (!db || !workspace || !user || !selected || !displayName.trim() || !desiredChannels.length) return;
    if (['n8n', 'website', 'shopify'].includes(selected.id)) return;
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

  const connectN8nCloud = async () => {
    if (!user || !workspace || !selected || !displayName.trim() || !desiredChannels.length || !webhookUrl.trim()) return;
    setTestState('testing');
    setTestMessage('');
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/integrations/n8n/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId: workspace.id,
          webhookUrl: webhookUrl.trim(),
          displayName: displayName.trim(),
          desiredChannels,
        }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'The n8n Cloud workflow could not be linked.');
      setTestState('success');
      setTestMessage('Connected. ORIN AI verified the active workflow and stored its URL in the encrypted connector vault.');
    } catch (cause) {
      setTestState('error');
      setTestMessage(cause instanceof Error ? cause.message : 'The n8n Cloud workflow could not be linked.');
    }
  };

  const connectWebsite = async () => {
    if (!user || !workspace || !displayName.trim() || !websiteAgentId || !desiredChannels.length || !websiteOrigins.trim()) return;
    setWebsiteState('publishing');
    setError('');
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/integrations/website/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          workspaceId: workspace.id,
          displayName: displayName.trim(),
          agentId: websiteAgentId,
          allowedOrigins: websiteOrigins.split(/[\n,]+/).map((origin) => origin.trim()).filter(Boolean),
          desiredChannels,
        }),
      });
      const result = await response.json().catch(() => ({})) as { embedCode?: string; error?: string };
      if (!response.ok || !result.embedCode) throw new Error(result.error || 'The website widget could not be published.');
      setWebsiteEmbed(result.embedCode);
      setWebsiteState('success');
    } catch (cause) {
      setWebsiteState('error');
      setError(cause instanceof Error ? cause.message : 'The website widget could not be published.');
    }
  };

  const copyWebsiteEmbed = async () => {
    if (!websiteEmbed) return;
    try {
      await navigator.clipboard.writeText(websiteEmbed);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1_500);
    } catch {
      setError('Copy was blocked by the browser. Select the embed code and copy it manually.');
    }
  };

  const beginMetaAuthorization = async () => {
    if (!user || !workspace || !capabilities.meta?.authorizationReady || !metaAgentId) return;
    setProviderAction('opening');
    setError('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id, agentId: metaAgentId });
      const response = await fetch(`/api/integrations/meta/start?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || 'Meta authorization could not be started.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setProviderAction('idle');
      setError(cause instanceof Error ? cause.message : 'Meta authorization could not be started.');
    }
  };

  const beginShopifyAuthorization = async () => {
    if (!user || !workspace || !capabilities.shopify?.authorizationReady || !shopDomain.trim()) return;
    setProviderAction('opening');
    setError('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id, shop: shopDomain.trim() });
      const response = await fetch(`/api/integrations/shopify/start?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || 'Shopify authorization could not be started.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setProviderAction('idle');
      setError(cause instanceof Error ? cause.message : 'Shopify authorization could not be started.');
    }
  };

  const availabilityCopy = (integration: IntegrationCatalogItem) => {
    const saved = connections.find((connection) => connection.provider === integration.id);
    if (saved?.status === 'connected' && saved.health === 'healthy') return 'Connected';
    if (saved?.authorizationStatus === 'authorized') {
      if (saved.health === 'awaiting_first_event') return 'Connected · awaiting first message';
      if (saved.health === 'subscription_partial') return 'Some accounts need attention';
      if (saved.health === 'webhook_not_configured') return 'Webhook setup required';
      return saved.health === 'healthy' ? 'Connected' : 'Connection needs attention';
    }
    if (integration.id === 'n8n') return n8nReady ? 'Ready to link' : vaultHealth === 'checking' ? 'Checking secure storage' : 'Secure storage required';
    if (integration.id === 'website') return websiteReady ? 'Ready to publish' : vaultHealth === 'checking' ? 'Checking secure storage' : 'Publishing backend required';
    const capability = capabilities[integration.id];
    if (capability?.authorizationReady) return 'Ready to authorize';
    if (capability?.partnerAccessRequired) return 'Partner access required';
    return 'App credentials required';
  };

  const removeDraft = async (connection: WorkspaceConnection) => {
    if (!db || !workspace || !user) return;
    setError('');
    try {
      if (connection.provider === 'n8n' || connection.provider === 'website' || connection.provider === 'shopify' || connection.provider === 'meta') {
        const token = await user.getIdToken();
        const endpoint = connection.provider === 'meta' ? '/api/integrations/meta/start' : `/api/integrations/${connection.provider}/connect`;
        const response = await fetch(endpoint, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ workspaceId: workspace.id }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(result.error || `The ${connection.provider} connection could not be removed.`);
      } else {
        await deleteDoc(doc(db, 'workspaces', workspace.id, 'connections', connection.id));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The connection draft could not be removed.');
    }
  };

  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Integrations" title="Sign in. Sync. Start serving customers." body="ORIN AI securely discovers eligible accounts and completes the channel setup behind the scenes." />
      {['meta', 'shopify'].includes(oauthProvider || '') && oauthStatus && (
        <section className={`integration-result is-${oauthStatus === 'authorized' ? 'success' : 'attention'}`} role="status">
          <strong>{oauthStatus === 'authorized' ? `${oauthProvider === 'shopify' ? 'Shopify' : 'Meta'} account synced.` : oauthStatus === 'cancelled' ? 'Authorization was cancelled.' : 'The connection needs another step.'}</strong>
          <span>{oauthStatus === 'authorized' ? (oauthProvider === 'shopify' ? 'ORIN AI stored the store token in its encrypted vault. The connection becomes live after the first verified webhook.' : 'ORIN AI discovered the eligible Pages and linked Instagram accounts, stored access securely, subscribed every account Meta accepted, and assigned your selected AI.') : oauthStatus === 'no_pages' ? 'This Facebook account does not manage an eligible Page. Check its Page access, then try again.' : oauthStatus === 'agent_not_ready' ? 'Complete all six AI decisions and include Messenger or Instagram, then connect again.' : 'No channel was marked connected. You can safely try again.'}</span>
        </section>
      )}
      {connections.length > 0 && (
        <section className="connection-list" aria-labelledby="saved-connections-title">
          <header><div><span>Workspace connections</span><h2 id="saved-connections-title">Setup in progress</h2></div><small>{connections.length} saved</small></header>
          {connections.map((connection) => {
            const catalogItem = integrations.find((item) => item.id === connection.provider);
            return (
              <article key={connection.id}>
                <span className="connection-list__mark"><Network aria-hidden="true" /></span>
                <div><strong>{connection.displayName}</strong><p>{catalogItem?.name || connection.provider} · {connection.desiredChannels.join(', ')}{connection.agentId ? ` · ${websiteAgents.find((agent) => agent.id === connection.agentId)?.name || 'Assigned ORIN AI'}` : ''}</p></div>
                <span className={`connection-status is-${connection.status}`}>{connection.authorizationStatus === 'authorized'
                  ? connection.health === 'healthy' ? 'Connected'
                    : connection.health === 'awaiting_first_event' ? 'Connected · awaiting first message'
                      : connection.health === 'subscription_partial' ? 'Some accounts need attention'
                        : 'Webhook setup required'
                  : statusCopy[connection.status] || 'Setup required'}</span>
                <button type="button" onClick={() => removeDraft(connection)}>Remove</button>
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
            <span className="integration-list__status">{availabilityCopy(integration)}</span>
            <button type="button" onClick={() => openSetup(integration)}>{integration.id === 'n8n' ? 'Link Cloud' : capabilities[integration.id]?.authorizationReady && integration.id !== 'website' ? 'Connect' : 'Set up'}</button>
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
              <p>Connect the account once. ORIN AI keeps provider credentials private and completes every setup step the provider allows.</p>
              {selected.id === 'meta' && (
                <>
                  <label><span>ORIN AI for automatic replies</span><select value={metaAgentId} onChange={(event) => setMetaAgentId(event.currentTarget.value)}><option value="">Choose a Messenger or Instagram-ready AI</option>{websiteAgents.map((agent) => {
                    const metaReady = agent.readiness >= 6 && agent.channels.some((channel) => ['Messenger', 'Instagram'].includes(channel));
                    return <option key={agent.id} value={agent.id} disabled={!metaReady}>{agent.name} · {agent.readiness}/6{metaReady ? '' : ' · add Messenger or Instagram'}</option>;
                  })}</select><small>This AI will be published for the Meta channels selected in its brief. Your team can take over from the inbox.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.some((channel) => ['Messenger', 'Instagram'].includes(channel))) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Messenger or Instagram.</p>}
                  <div className={`provider-authorization ${capabilities.meta?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                    <div><strong>{capabilities.meta?.authorizationReady ? 'Connect Facebook and Instagram in one step.' : 'Meta app credentials are required.'}</strong><span>{capabilities.meta?.authorizationReady ? 'Continue with Facebook. ORIN AI will find the Pages you manage, link professional Instagram accounts, subscribe messages, and store access securely.' : 'ORIN AI will enable Meta sign-in only after the app ID, secret, encrypted vault, callback, and webhook are configured.'}</span></div>
                    <button type="button" disabled={!capabilities.meta?.authorizationReady || !metaAgentId || providerAction === 'opening'} onClick={beginMetaAuthorization}>{providerAction === 'opening' ? 'Opening Meta…' : capabilities.meta?.authorizationReady ? 'Continue with Facebook' : 'Not available yet'}</button>
                  </div>
                </>
              )}
              {selected.id === 'shopify' && (
                <div className={`provider-authorization ${capabilities.shopify?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                  <div><strong>{capabilities.shopify?.authorizationReady ? 'Shopify authorization is ready.' : 'Shopify app credentials are required.'}</strong><span>{capabilities.shopify?.authorizationReady ? 'Enter the permanent myshopify.com domain. Shopify will show the permissions before anything is connected.' : 'The Shopify button unlocks only after the app client, secret, encrypted vault, and callback are configured.'}</span></div>
                </div>
              )}
              {!['meta', 'shopify', 'n8n', 'website'].includes(selected.id) && !capabilities[selected.id]?.authorizationReady && (
                <div className="provider-authorization is-waiting">
                  <div><strong>{capabilities[selected.id]?.partnerAccessRequired ? `${selected.name} partner access is required.` : `${selected.name} app credentials are required.`}</strong><span>You can save the intended setup now. ORIN AI will not request credentials or claim this channel is connected before the provider grants production access.</span></div>
                </div>
              )}
              {selected.id === 'website' && !websiteReady && (
                <div className="provider-authorization is-waiting">
                  <div><strong>Website publishing is not ready.</strong><span>The widget unlocks only after secure storage, session signing, and the response service pass configuration checks.</span></div>
                </div>
              )}
              {selected.id === 'shopify' ? (
                <label><span>Permanent Shopify store domain</span><input value={shopDomain} onChange={(event) => setShopDomain(event.currentTarget.value)} placeholder="your-store.myshopify.com" autoCapitalize="none" autoCorrect="off" /><small>Use the myshopify.com domain, not a custom storefront domain.</small></label>
              ) : selected.id !== 'meta' && <label><span>{selected.setupLabel}</span><input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} placeholder={`Example: ${selected.name} main account`} /></label>}
              {!['shopify', 'meta'].includes(selected.id) && <fieldset>
                <legend>What should this connection handle?</legend>
                {selected.options.map((option) => (
                  <button key={option} type="button" className={desiredChannels.includes(option) ? 'is-selected' : ''} aria-pressed={desiredChannels.includes(option)} onClick={() => toggleDesiredChannel(option)}>
                    <span>{option}</span>{desiredChannels.includes(option) && <Check aria-hidden="true" />}
                  </button>
                ))}
              </fieldset>}
              {selected.id === 'n8n' && (
                <>
                  {!n8nReady && (
                    <div className="provider-authorization is-waiting">
                      <div><strong>Secure connector storage is being prepared.</strong><span>You can open n8n Cloud now. Linking will unlock after ORIN AI's encrypted server vault is available.</span></div>
                    </div>
                  )}
                  <div className="integration-deployment-options" aria-label="n8n deployment type">
                    <button type="button" className="is-selected" aria-pressed="true"><span><strong>n8n Cloud</strong><small>Available now</small></span><Check aria-hidden="true" /></button>
                    <button type="button" disabled aria-label="Self-hosted n8n server, coming soon"><span><strong>Self-hosted server</strong><small>Coming soon</small></span></button>
                  </div>
                  <div className="integration-webhook-test">
                    <ol><li>Open n8n Cloud and create a Webhook trigger.</li><li>Use its production URL, then activate the workflow.</li><li>Paste the URL below and link it to ORIN AI.</li></ol>
                    <label><span>Production webhook URL</span><input type="url" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.currentTarget.value); setTestState('idle'); setTestMessage(''); }} placeholder="https://your-workspace.app.n8n.cloud/webhook/..." /></label>
                    <a href="https://app.n8n.cloud/" target="_blank" rel="noopener noreferrer">Open n8n Cloud <ExternalLink aria-hidden="true" /></a>
                    {testMessage && <p className={`is-${testState}`} role="status">{testMessage}</p>}
                  </div>
                </>
              )}
              {selected.id === 'website' && (
                <div className="website-integration-setup">
                  <label><span>Published AI</span><select value={websiteAgentId} onChange={(event) => { setWebsiteAgentId(event.currentTarget.value); setWebsiteState('idle'); setWebsiteEmbed(''); }}><option value="">Choose a Website-ready AI</option>{websiteAgents.map((agent) => <option key={agent.id} value={agent.id} disabled={agent.readiness < 6 || !agent.channels.includes('Website')}>{agent.name} · {agent.readiness}/6{agent.channels.includes('Website') ? '' : ' · Website not selected'}</option>)}</select></label>
                  {!websiteAgents.length && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Website as a channel.</p>}
                  <label><span>Allowed website origins</span><textarea value={websiteOrigins} onChange={(event) => { setWebsiteOrigins(event.currentTarget.value); setWebsiteState('idle'); }} placeholder={'https://shop.example.com\nhttps://www.example.com'} rows={3} /><small>Enter exact origins only—no paths or wildcards. Up to five.</small></label>
                  {websiteEmbed && <div className="website-embed-result"><div><strong>Widget published</strong><span>Paste this once before your website's closing body tag.</span></div><pre><code>{websiteEmbed}</code></pre><button type="button" onClick={copyWebsiteEmbed}><Copy aria-hidden="true" /> {copyState === 'copied' ? 'Copied' : 'Copy embed code'}</button></div>}
                </div>
              )}
              <div className="integration-dialog__trust"><Settings aria-hidden="true" /><p>{selected.id === 'n8n' ? <><strong>Your webhook URL stays private.</strong> ORIN AI verifies it first, then stores it only in the encrypted server vault.</> : selected.id === 'shopify' ? <><strong>Your Shopify token stays server-side.</strong> Shopify shows the requested access first; ORIN AI encrypts the resulting store token and never sends it to the browser.</> : selected.id === 'meta' ? <><strong>Your Meta access stays server-side.</strong> Facebook shows the permissions first; ORIN AI encrypts the resulting account access and never sends it to the browser.</> : <><strong>No access token is requested here.</strong> This saves a private setup record so you can resume. Provider authorization opens only when the corresponding backend credentials are ready.</>}</p></div>
            </div>
            <footer>
              <button type="button" onClick={() => setSelected(null)}>{selected.id === 'n8n' && testState === 'success' ? 'Done' : 'Cancel'}</button>
              {selected.id === 'meta' ? null : selected.id === 'n8n' ? (
                <button type="button" className="is-primary" disabled={testState === 'testing' || testState === 'success' || !n8nReady || !displayName.trim() || !desiredChannels.length || !webhookUrl.trim()} onClick={connectN8nCloud}>{testState === 'testing' ? 'Verifying…' : testState === 'success' ? 'Linked' : 'Verify & link workflow'}</button>
              ) : selected.id === 'website' ? (
                <button type="button" className="is-primary" disabled={websiteState === 'publishing' || !websiteReady || !displayName.trim() || !desiredChannels.length || !websiteAgentId || !websiteOrigins.trim()} onClick={connectWebsite}>{websiteState === 'publishing' ? 'Publishing…' : websiteState === 'success' ? 'Update widget' : 'Publish website widget'}</button>
              ) : selected.id === 'shopify' ? (
                <button type="button" className="is-primary" disabled={providerAction === 'opening' || !capabilities.shopify?.authorizationReady || !shopDomain.trim()} onClick={beginShopifyAuthorization}>{providerAction === 'opening' ? 'Opening Shopify…' : capabilities.shopify?.authorizationReady ? 'Continue with Shopify' : 'Not available yet'}</button>
              ) : (
                <button type="button" className="is-primary" disabled={saving || !displayName.trim() || !desiredChannels.length} onClick={saveSetup}>{saving ? 'Saving…' : 'Save setup'}</button>
              )}
            </footer>
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
