import {
  ArrowRight,
  Bot,
  Check,
  Circle,
  Copy,
  ExternalLink,
  Network,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type Timestamp,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';
import { emptyAnalyticsMetrics, formatResponseTime, useWorkspaceAnalytics } from '../services/workspace-analytics';

type FacebookLoginResponse = { authResponse?: { code?: string }; status?: string };
type FacebookSdk = {
  init: (options: { appId: string; cookie: boolean; xfbml: boolean; version: string }) => void;
  login: (callback: (response: FacebookLoginResponse) => void, options: Record<string, unknown>) => void;
};
type WhatsAppSignupResult = { code: string; wabaId: string; phoneNumberId: string };

function facebookSdk() {
  return (window as typeof window & { FB?: FacebookSdk }).FB;
}

async function loadFacebookSdk(appId: string, version: string) {
  const existing = facebookSdk();
  if (existing) {
    existing.init({ appId, cookie: true, xfbml: false, version });
    return existing;
  }
  await new Promise<void>((resolve, reject) => {
    const current = document.getElementById('facebook-jssdk') as HTMLScriptElement | null;
    if (current) {
      current.remove();
    }
    const script = document.createElement('script');
    script.id = 'facebook-jssdk';
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Meta sign-in could not be loaded.'));
    document.head.appendChild(script);
  });
  const sdk = facebookSdk();
  if (!sdk) throw new Error('Meta sign-in did not initialize.');
  sdk.init({ appId, cookie: true, xfbml: false, version });
  return sdk;
}

function runWhatsAppEmbeddedSignup(sdk: FacebookSdk, configId: string) {
  return new Promise<WhatsAppSignupResult>((resolve, reject) => {
    let code = '';
    let wabaId = '';
    let phoneNumberId = '';
    let settled = false;
    let fallbackTimer = 0;
    const finish = () => {
      if (settled || !code) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('message', receiveSession);
      resolve({ code, wabaId, phoneNumberId });
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('message', receiveSession);
      reject(new Error(message));
    };
    const receiveSession = (event: MessageEvent) => {
      if (!['https://www.facebook.com', 'https://web.facebook.com'].includes(event.origin)) return;
      try {
        const payload = (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) as {
          type?: string;
          event?: string;
          data?: { waba_id?: string; phone_number_id?: string };
        };
        if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (payload.event === 'FINISH') {
          wabaId = payload.data?.waba_id || '';
          phoneNumberId = payload.data?.phone_number_id || '';
          finish();
        } else if (payload.event === 'ERROR') {
          fail('Meta could not complete WhatsApp Business setup. Review the account and try again.');
        }
      } catch {
        // Ignore unrelated postMessage traffic from the provider frame.
      }
    };
    window.addEventListener('message', receiveSession);
    const timeout = window.setTimeout(() => fail('WhatsApp signup timed out. Open it again to continue.'), 5 * 60 * 1000);
    sdk.login((response) => {
      code = response.authResponse?.code || '';
      if (!code) {
        fail('WhatsApp authorization was cancelled.');
        return;
      }
      if (wabaId) finish();
      else fallbackTimer = window.setTimeout(finish, 2_500);
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {} },
    });
  });
}

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

type OverviewAgent = {
  id: string;
  name: string;
  readiness: number;
  status: 'active' | 'draft';
  configUpdatedAt?: Timestamp;
  lastTestedAt?: Timestamp;
};

type OverviewConnection = {
  provider: string;
  status: string;
  agentId: string;
};

const customerProviders = new Set(['meta', 'whatsapp', 'shopee', 'lazada', 'airbnb', 'website']);
const providerNames: Record<string, string> = {
  meta: 'Facebook or Instagram',
  whatsapp: 'WhatsApp Business',
  tiktok: 'TikTok',
  shopee: 'Shopee',
  lazada: 'Lazada',
  shopify: 'Shopify',
  airbnb: 'Airbnb',
  website: 'Website chat',
};

export function OverviewPage() {
  const { user, workspace } = useAuth();
  const { error, loading, summary } = useWorkspaceAnalytics(user, workspace?.id, 30);
  const [overviewAgents, setOverviewAgents] = useState<OverviewAgent[]>([]);
  const [overviewConnections, setOverviewConnections] = useState<OverviewConnection[]>([]);
  const metrics = summary?.current.metrics || emptyAnalyticsMetrics;
  const firstName = user?.displayName?.split(' ')[0] || 'there';

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'agents'), (snapshot) => {
      setOverviewAgents(snapshot.docs.map((agent) => ({
        id: agent.id,
        name: typeof agent.data().name === 'string' ? agent.data().name : 'Untitled ORIN AI',
        readiness: typeof agent.data().readiness === 'number' ? agent.data().readiness : 0,
        status: agent.data().status === 'active' ? 'active' as const : 'draft' as const,
        configUpdatedAt: agent.data().configUpdatedAt as Timestamp | undefined,
        lastTestedAt: agent.data().lastTestedAt as Timestamp | undefined,
      })).sort((left, right) => right.readiness - left.readiness));
    }, () => setOverviewAgents([]));
  }, [workspace]);

  useEffect(() => {
    if (!db || !workspace) return undefined;
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      setOverviewConnections(snapshot.docs.map((connection) => ({
        provider: typeof connection.data().provider === 'string' ? connection.data().provider : connection.id,
        status: typeof connection.data().status === 'string' ? connection.data().status : '',
        agentId: typeof connection.data().agentId === 'string' ? connection.data().agentId : '',
      })));
    }, () => setOverviewConnections([]));
  }, [workspace]);

  const readyAgent = overviewAgents.find((agent) => agent.readiness >= 6);
  const draftAgent = readyAgent || overviewAgents[0];
  const testedAgent = overviewAgents.find((agent) => agent.readiness >= 6
    && agent.lastTestedAt
    && (!agent.configUpdatedAt || agent.lastTestedAt.toMillis() >= agent.configUpdatedAt.toMillis()));
  const staleTestAgent = overviewAgents.find((agent) => agent.readiness >= 6 && agent.lastTestedAt && agent !== testedAgent);
  const connectedChannel = overviewConnections.find((connection) => customerProviders.has(connection.provider) && connection.status === 'connected');
  const liveAgent = connectedChannel
    ? overviewAgents.find((agent) => agent.status === 'active' && (!connectedChannel.agentId || connectedChannel.agentId === agent.id))
    : undefined;
  const testHref = readyAgent ? `/app/agents/${encodeURIComponent(readyAgent.id)}?step=test` : draftAgent ? `/app/agents/${encodeURIComponent(draftAgent.id)}` : '/app/agents/new';
  const onboardingSteps = [
    {
      id: 'define',
      title: 'Define the AI',
      detail: readyAgent ? `${readyAgent.name} has all six decisions.` : draftAgent ? `${draftAgent.name} has ${draftAgent.readiness} of 6 decisions.` : 'Purpose, knowledge, voice, and rules.',
      complete: Boolean(readyAgent),
      href: draftAgent ? `/app/agents/${encodeURIComponent(draftAgent.id)}` : '/app/agents/new',
      action: draftAgent ? 'Continue the AI' : 'Create the AI',
    },
    {
      id: 'connect',
      title: 'Connect one customer channel',
      detail: connectedChannel ? `${providerNames[connectedChannel.provider] || connectedChannel.provider} is ready.` : 'Choose where the first customer conversation will arrive.',
      complete: Boolean(connectedChannel),
      href: '/app/integrations',
      action: 'Choose a channel',
    },
    {
      id: 'test',
      title: 'Test a customer question',
      detail: testedAgent?.lastTestedAt ? `${testedAgent.name} was tested ${testedAgent.lastTestedAt.toDate().toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}.` : staleTestAgent ? `${staleTestAgent.name} changed after its last test. Test it again.` : 'Ask a real question and review the answer or handoff.',
      complete: Boolean(testedAgent),
      href: testHref,
      action: readyAgent ? 'Test the AI' : 'Finish the AI first',
    },
    {
      id: 'publish',
      title: 'Go live',
      detail: liveAgent ? `${liveAgent.name} is serving an approved channel.` : 'Publish only after the AI and its first channel are ready.',
      complete: Boolean(liveAgent),
      href: '/app/integrations',
      action: 'Review and publish',
    },
  ];
  const completedSteps = onboardingSteps.filter((step) => step.complete).length;
  const nextStep = onboardingSteps.find((step) => !step.complete);

  return (
    <div className="workspace-page">
      <PageHeading
        eyebrow="Overview"
        title={`Good to have you here, ${firstName}.`}
        body="Build the front desk, connect the places customers reach you, then publish when every answer is ready."
      />
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}

      <section className="workspace-onboarding">
        <div className="workspace-onboarding__copy">
          <span>{completedSteps} of 4 complete</span>
          <h2>{nextStep ? `Next: ${nextStep.title}.` : 'Your AI front desk is live.'}</h2>
          <p>{nextStep ? nextStep.detail : 'Open the inbox to see every conversation, handoff, and customer follow-up in one place.'}</p>
          <Link to={nextStep?.href || '/app/inbox'}>{nextStep?.action || 'Open the inbox'} <ArrowRight aria-hidden="true" /></Link>
        </div>
        <ol className="workspace-steps">
          {onboardingSteps.map((onboardingStep) => <li key={onboardingStep.id} className={`${onboardingStep.complete ? 'is-complete' : ''}${nextStep?.id === onboardingStep.id ? ' is-current' : ''}`}>
            <span>{onboardingStep.complete ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}</span>
            <Link to={onboardingStep.href} aria-current={nextStep?.id === onboardingStep.id ? 'step' : undefined}><strong>{onboardingStep.title}</strong><small>{onboardingStep.detail}</small></Link>
          </li>)}
        </ol>
      </section>

      <section className="workspace-metric-grid" aria-label="Workspace activity">
        {[
          ['Conversations · 30 days', loading ? '—' : metrics.conversations.toLocaleString('en-PH'), metrics.conversations ? 'Started across connected channels' : 'Waiting for a connected channel'],
          ['Handled by ORIN AI', loading ? '—' : `${metrics.aiHandledRate}%`, metrics.conversations ? `${metrics.aiHandled.toLocaleString('en-PH')} answered without escalation` : 'No live conversations yet'],
          ['Escalated to your team', loading ? '—' : `${metrics.escalationRate}%`, metrics.conversations ? `${metrics.escalated.toLocaleString('en-PH')} escalated conversations` : 'No live conversations yet'],
          ['Median first response', loading ? '—' : formatResponseTime(metrics.medianFirstResponseMs), metrics.medianFirstResponseMs === null ? 'Measured after launch' : 'Successful automatic replies · 30 days'],
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
  id: 'meta' | 'whatsapp' | 'tiktok' | 'shopee' | 'lazada' | 'shopify' | 'airbnb' | 'website' | 'n8n' | 'webhook';
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
  messagingReady?: boolean;
  shopReady?: boolean;
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
  outcomeConfigured?: boolean;
  outcomeTokenHint?: string;
  webhookConfigured?: boolean;
  testedEndpointHost?: string;
  advancedConfigured?: boolean;
  n8nInstanceHost?: string;
  n8nEditorUrl?: string;
  byokNames?: string[];
  importedWorkflowId?: string;
  importedWorkflowName?: string;
  importedNodeCount?: number;
  updatedAt?: Timestamp;
};

type WebsiteAgent = { id: string; name: string; businessName: string; readiness: number; channels: string[] };
type N8nByokRow = { id: string; name: string; value: string };

const createN8nByokRow = (): N8nByokRow => ({ id: crypto.randomUUID(), name: '', value: '' });

const integrations: IntegrationCatalogItem[] = [
  { id: 'meta', name: 'Meta', body: 'Facebook Pages, Messenger, and Instagram', setupLabel: 'Page or account name', options: ['Facebook Pages', 'Messenger', 'Instagram'], initialStatus: 'authorization_required' },
  { id: 'whatsapp', name: 'WhatsApp Business', body: 'Business messages and phone numbers from one Meta sign-in', setupLabel: 'WhatsApp Business account', options: ['WhatsApp messages'], initialStatus: 'authorization_required' },
  { id: 'tiktok', name: 'TikTok', body: 'Secure account sync; messaging and Shop follow provider approval', setupLabel: 'TikTok account', options: ['TikTok account identity'], initialStatus: 'authorization_required' },
  { id: 'shopee', name: 'Shopee', body: 'Seller chat and every authorized shop from one secure sign-in', setupLabel: 'Shopee seller account', options: ['Customer messages'], initialStatus: 'authorization_required' },
  { id: 'lazada', name: 'Lazada', body: 'Seller chat and connected shops from one secure sign-in', setupLabel: 'Lazada seller account', options: ['Customer messages'], initialStatus: 'authorization_required' },
  { id: 'shopify', name: 'Shopify', body: 'Store, customer, and order events', setupLabel: 'Shopify store name', options: ['Orders', 'Customers', 'Store events'], initialStatus: 'authorization_required' },
  { id: 'airbnb', name: 'Airbnb', body: 'Guest messages before, during, and after a stay', setupLabel: 'Hosting team or portfolio name', options: ['Guest messages', 'Check-in and stay questions', 'Routine request triage'], initialStatus: 'access_review' },
  { id: 'website', name: 'Website', body: 'ORIN AI chat for your own site', setupLabel: 'Website name', options: ['Website chat', 'Lead capture', 'Knowledge answers'], initialStatus: 'configuration_required' },
  { id: 'n8n', name: 'n8n', body: 'Link n8n Cloud workflows to ORIN AI events', setupLabel: 'Workflow name', options: ['New conversation', 'Lead captured', 'Human escalation', 'Order or booking attributed'], initialStatus: 'configuration_required' },
  { id: 'webhook', name: 'Verified webhook', body: 'Send signed automation events to your HTTPS endpoint', setupLabel: 'Destination name', options: [], initialStatus: 'configuration_required' },
];

const statusCopy: Record<IntegrationStatus, string> = {
  authorization_required: 'Authorization required',
  configuration_required: 'Configuration required',
  access_review: 'Access review required',
  connected: 'Connected',
  attention_required: 'Needs attention',
};

const n8nOutcomeEndpoint = 'https://www.orin.work/api/integrations/n8n/outcomes';
const n8nOutcomeExample = `{
  "type": "order",
  "externalId": "{{ $json.id }}",
  "amount": {{ $json.total }},
  "currency": "PHP",
  "occurredAt": "{{ $json.created_at }}"
}`;

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
  const [whatsappAgentId, setWhatsappAgentId] = useState('');
  const [lazadaAgentId, setLazadaAgentId] = useState('');
  const [shopeeAgentId, setShopeeAgentId] = useState('');
  const [airbnbAgentId, setAirbnbAgentId] = useState('');
  const [websiteOrigins, setWebsiteOrigins] = useState('');
  const [websiteEmbed, setWebsiteEmbed] = useState('');
  const [websiteState, setWebsiteState] = useState<'idle' | 'publishing' | 'success' | 'error'>('idle');
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [shopDomain, setShopDomain] = useState('');
  const [n8nOutcomeToken, setN8nOutcomeToken] = useState('');
  const [n8nOutcomeUrl, setN8nOutcomeUrl] = useState('');
  const [n8nOutcomeState, setN8nOutcomeState] = useState<'idle' | 'rotating' | 'ready' | 'error'>('idle');
  const [n8nOutcomeCopy, setN8nOutcomeCopy] = useState<'idle' | 'url' | 'token' | 'example'>('idle');
  const [n8nInstanceUrl, setN8nInstanceUrl] = useState('');
  const [n8nApiKey, setN8nApiKey] = useState('');
  const [n8nWorkflow, setN8nWorkflow] = useState<Record<string, unknown> | null>(null);
  const [n8nWorkflowPreview, setN8nWorkflowPreview] = useState<{ fileName: string; name: string; nodeCount: number } | null>(null);
  const [n8nByokRows, setN8nByokRows] = useState<N8nByokRow[]>(() => [createN8nByokRow()]);
  const [n8nAdvancedState, setN8nAdvancedState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [n8nAdvancedMessage, setN8nAdvancedMessage] = useState('');
  const [n8nImportedWorkflowUrl, setN8nImportedWorkflowUrl] = useState('');
  const [webhookSigningSecret, setWebhookSigningSecret] = useState('');
  const [webhookCopy, setWebhookCopy] = useState<'idle' | 'secret'>('idle');

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
        outcomeConfigured: connection.data().outcomeConfigured === true,
        outcomeTokenHint: typeof connection.data().outcomeTokenHint === 'string' ? connection.data().outcomeTokenHint : undefined,
        webhookConfigured: connection.data().webhookConfigured === true,
        testedEndpointHost: typeof connection.data().testedEndpointHost === 'string' ? connection.data().testedEndpointHost : undefined,
        advancedConfigured: connection.data().advancedConfigured === true,
        n8nInstanceHost: typeof connection.data().n8nInstanceHost === 'string' ? connection.data().n8nInstanceHost : undefined,
        n8nEditorUrl: typeof connection.data().n8nEditorUrl === 'string' ? connection.data().n8nEditorUrl : undefined,
        byokNames: Array.isArray(connection.data().byokNames) ? connection.data().byokNames.filter((item): item is string => typeof item === 'string') : undefined,
        importedWorkflowId: typeof connection.data().importedWorkflowId === 'string' ? connection.data().importedWorkflowId : undefined,
        importedWorkflowName: typeof connection.data().importedWorkflowName === 'string' ? connection.data().importedWorkflowName : undefined,
        importedNodeCount: typeof connection.data().importedNodeCount === 'number' ? connection.data().importedNodeCount : undefined,
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
  const verifiedWebhookReady = vaultHealth === 'ready';
  const canEditConnections = ['owner', 'admin', 'editor'].includes(workspace?.role || '');
  const canRemoveConnections = ['owner', 'admin'].includes(workspace?.role || '');

  const openSetup = (integration: IntegrationCatalogItem) => {
    const existing = connections.find((connection) => connection.provider === integration.id);
    setSelected(integration);
    setDisplayName(existing?.displayName || '');
    setDesiredChannels(existing?.desiredChannels || []);
    setWebhookUrl('');
    const linkedN8n = integration.id === 'n8n'
      && existing?.status === 'connected'
      && existing.health === 'healthy'
      && (existing.webhookConfigured === true || Boolean(existing.testedEndpointHost));
    const linkedWebhook = integration.id === 'webhook' && existing?.status === 'connected' && existing.health === 'healthy';
    setTestState(linkedN8n || linkedWebhook ? 'success' : 'idle');
    setTestMessage(linkedN8n ? 'Workflow linked. ORIN AI can send events to n8n and accept verified business outcomes.' : linkedWebhook ? 'Endpoint verified. Active webhook automations can deliver signed events.' : '');
    setProviderAction('idle');
    setWebsiteAgentId(existing?.agentId || '');
    setMetaAgentId(existing?.agentId || '');
    setWhatsappAgentId(existing?.agentId || '');
    setLazadaAgentId(existing?.agentId || '');
    setShopeeAgentId(existing?.agentId || '');
    setAirbnbAgentId(existing?.agentId || '');
    setWebsiteOrigins(existing?.allowedOrigins?.join('\n') || '');
    setWebsiteEmbed(existing?.publicWidgetKey ? `<script src="https://www.orin.work/orin-widget.js" data-orin-widget="${existing.publicWidgetKey}" async></script>` : '');
    setWebsiteState(existing?.publicWidgetKey ? 'success' : 'idle');
    setCopyState('idle');
    setShopDomain(existing?.shopDomain || '');
    setN8nOutcomeToken('');
    setN8nOutcomeUrl(linkedN8n ? n8nOutcomeEndpoint : '');
    setN8nOutcomeState(linkedN8n ? 'ready' : 'idle');
    setN8nOutcomeCopy('idle');
    setN8nInstanceUrl(existing?.n8nEditorUrl || (existing?.n8nInstanceHost ? `https://${existing.n8nInstanceHost}` : ''));
    setN8nApiKey('');
    setN8nWorkflow(null);
    setN8nWorkflowPreview(null);
    setN8nByokRows([createN8nByokRow()]);
    setN8nAdvancedState('idle');
    setN8nAdvancedMessage(existing?.advancedConfigured ? `API access is connected to ${existing.n8nInstanceHost || 'n8n Cloud'}.` : '');
    setN8nImportedWorkflowUrl('');
    setWebhookSigningSecret('');
    setWebhookCopy('idle');
    setError('');
  };

  const toggleDesiredChannel = (value: string) => {
    setDesiredChannels((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const saveSetup = async () => {
    if (!db || !workspace || !user || !selected || !displayName.trim() || !desiredChannels.length) return;
    if (['n8n', 'webhook', 'website', 'shopify', 'lazada', 'shopee', 'whatsapp'].includes(selected.id)) return;
    if (selected.id === 'airbnb' && !airbnbAgentId) return;
    setSaving(true);
    setError('');
    try {
      const existing = connections.find((connection) => connection.provider === selected.id);
      await setDoc(doc(db, 'workspaces', workspace.id, 'connections', existing?.id || selected.id), {
        provider: selected.id,
        displayName: displayName.trim(),
        status: selected.initialStatus,
        desiredChannels,
        agentId: selected.id === 'airbnb' ? airbnbAgentId : existing?.agentId || '',
        credentialState: 'not_supplied',
        health: 'not_tested',
        createdBy: user.uid,
        ...(existing ? {} : { createdAt: serverTimestamp() }),
        updatedAt: serverTimestamp(),
      }, { merge: true });
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
      const result = await response.json().catch(() => ({})) as { outcome?: { url?: string; token?: string }; error?: string };
      if (!response.ok || !result.outcome?.url || !result.outcome.token) throw new Error(result.error || 'The n8n Cloud workflow could not be linked.');
      setN8nOutcomeUrl(result.outcome.url);
      setN8nOutcomeToken(result.outcome.token);
      setN8nOutcomeState('ready');
      setTestState('success');
      setTestMessage('Connected. Finish the verified outcome step below so completed orders and bookings appear in Analytics.');
    } catch (cause) {
      setTestState('error');
      setTestMessage(cause instanceof Error ? cause.message : 'The n8n Cloud workflow could not be linked.');
    }
  };

  const loadN8nWorkflowFile = async (file?: File) => {
    setN8nWorkflow(null);
    setN8nWorkflowPreview(null);
    setN8nAdvancedState('idle');
    setN8nAdvancedMessage('');
    if (!file) return;
    if (file.size > 1_000_000) {
      setN8nAdvancedState('error');
      setN8nAdvancedMessage('Choose a workflow JSON file smaller than 1 MB.');
      return;
    }
    try {
      const workflow = JSON.parse(await file.text()) as Record<string, unknown>;
      const name = typeof workflow?.name === 'string' ? workflow.name.trim() : '';
      const nodeCount = Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0;
      const connections = workflow?.connections;
      if (!name || !nodeCount || !connections || typeof connections !== 'object' || Array.isArray(connections)) throw new Error('INVALID_WORKFLOW');
      setN8nWorkflow(workflow);
      setN8nWorkflowPreview({ fileName: file.name, name, nodeCount });
      setN8nAdvancedMessage(`${name} is ready to import. ORIN AI will create it as a new, inactive workflow.`);
    } catch {
      setN8nAdvancedState('error');
      setN8nAdvancedMessage('That file is not a valid n8n workflow export. It needs a name, nodes, and connections.');
    }
  };

  const updateN8nByokRow = (index: number, field: 'name' | 'value', value: string) => {
    setN8nByokRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
    setN8nAdvancedState('idle');
  };

  const saveN8nAdvanced = async () => {
    if (!user || !workspace || !n8nInstanceUrl.trim()) return;
    const activeConnection = connections.find((connection) => connection.provider === 'n8n');
    const enteredByok = n8nByokRows.filter((row) => row.name.trim() || row.value.trim());
    if (enteredByok.some((row) => !row.name.trim() || !row.value.trim())) {
      setN8nAdvancedState('error');
      setN8nAdvancedMessage('Complete both fields for each BYOK entry, or remove the unfinished row.');
      return;
    }
    if (!n8nApiKey.trim() && !activeConnection?.advancedConfigured) {
      setN8nAdvancedState('error');
      setN8nAdvancedMessage('Enter an n8n API key for the first connection.');
      return;
    }
    setN8nAdvancedState('saving');
    setN8nAdvancedMessage(n8nWorkflow ? 'Importing the workflow into n8n Cloud…' : 'Verifying n8n Cloud API access…');
    setN8nImportedWorkflowUrl('');
    try {
      const response = await fetch('/api/integrations/n8n/connect?action=advanced', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
        body: JSON.stringify({
          workspaceId: workspace.id,
          instanceUrl: n8nInstanceUrl.trim(),
          ...(n8nApiKey.trim() ? { apiKey: n8nApiKey.trim() } : {}),
          ...(n8nWorkflow ? { workflow: n8nWorkflow } : {}),
          ...(enteredByok.length ? { byok: enteredByok.map((row) => ({ name: row.name.trim(), value: row.value.trim() })) } : {}),
        }),
      });
      const result = await response.json().catch(() => ({})) as {
        advanced?: { instanceHost?: string; workflowName?: string; workflowUrl?: string; byokNames?: string[] };
        error?: string;
      };
      if (!response.ok || !result.advanced?.instanceHost) throw new Error(result.error || 'The advanced n8n setup could not be saved.');
      const importedName = result.advanced.workflowName || '';
      setN8nAdvancedState('success');
      setN8nAdvancedMessage(importedName
        ? `${importedName} was imported. Open it in n8n, review its credentials, then activate it.`
        : `API access is connected to ${result.advanced.instanceHost}.`);
      setN8nImportedWorkflowUrl(result.advanced.workflowUrl || '');
      setN8nApiKey('');
      setN8nByokRows([createN8nByokRow()]);
    } catch (cause) {
      setN8nAdvancedState('error');
      setN8nAdvancedMessage(cause instanceof Error ? cause.message : 'The advanced n8n setup could not be saved.');
    }
  };

  const connectVerifiedWebhook = async () => {
    if (!user || !workspace || !selected || !displayName.trim() || !webhookUrl.trim()) return;
    setTestState('testing');
    setTestMessage('');
    setWebhookSigningSecret('');
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
        body: JSON.stringify({ mode: 'team_access', action: 'connect_webhook', workspaceId: workspace.id, displayName: displayName.trim(), webhookUrl: webhookUrl.trim() }),
      });
      const result = await response.json().catch(() => ({})) as { signingSecret?: string; endpointHost?: string; error?: string };
      if (!response.ok || !result.signingSecret) throw new Error(result.error || 'The webhook could not be verified.');
      setWebhookSigningSecret(result.signingSecret);
      setTestState('success');
      setTestMessage(`Verified ${result.endpointHost || 'endpoint'}. Save the signing secret now; it will not be shown again.`);
    } catch (cause) {
      setTestState('error');
      setTestMessage(cause instanceof Error ? cause.message : 'The webhook could not be verified.');
    }
  };

  const copyWebhookSecret = async () => {
    if (!webhookSigningSecret) return;
    try {
      await navigator.clipboard.writeText(webhookSigningSecret);
      setWebhookCopy('secret');
      window.setTimeout(() => setWebhookCopy('idle'), 1_500);
    } catch {
      setError('Copy was blocked by the browser. Select the signing secret and copy it manually.');
    }
  };

  const rotateN8nOutcomeToken = async () => {
    if (!user || !workspace) return;
    setN8nOutcomeState('rotating');
    setN8nOutcomeCopy('idle');
    setError('');
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/integrations/n8n/outcome-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      const result = await response.json().catch(() => ({})) as { outcome?: { url?: string; token?: string }; error?: string };
      if (!response.ok || !result.outcome?.url || !result.outcome.token) throw new Error(result.error || 'A new outcome token could not be created.');
      setN8nOutcomeUrl(result.outcome.url);
      setN8nOutcomeToken(result.outcome.token);
      setN8nOutcomeState('ready');
      setTestMessage('New token created. The previous outcome token stopped working immediately.');
    } catch (cause) {
      setN8nOutcomeState('error');
      setError(cause instanceof Error ? cause.message : 'A new outcome token could not be created.');
    }
  };

  const copyN8nOutcomeValue = async (value: string, target: 'url' | 'token' | 'example') => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setN8nOutcomeCopy(target);
      window.setTimeout(() => setN8nOutcomeCopy('idle'), 1_500);
    } catch {
      setError('Copy was blocked by the browser. Select the value and copy it manually.');
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

  const beginWhatsAppAuthorization = async () => {
    if (!user || !workspace || !capabilities.whatsapp?.authorizationReady || !whatsappAgentId) return;
    setProviderAction('opening');
    setError('');
    setTestState('idle');
    setTestMessage('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id, agentId: whatsappAgentId });
      const response = await fetch(`/api/integrations/whatsapp/start?${query.toString()}`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as {
        embeddedSignup?: { appId?: string; configId?: string; graphVersion?: string; state?: string };
        error?: string;
      };
      const setup = payload.embeddedSignup;
      if (!response.ok || !setup?.appId || !setup.configId || !setup.graphVersion || !setup.state) {
        throw new Error(payload.error || 'WhatsApp authorization could not be started.');
      }
      const sdk = await loadFacebookSdk(setup.appId, setup.graphVersion);
      const signup = await runWhatsAppEmbeddedSignup(sdk, setup.configId);
      const freshToken = await user.getIdToken();
      const complete = await fetch('/api/integrations/whatsapp/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({
          code: signup.code,
          state: setup.state,
          wabaId: signup.wabaId,
          phoneNumberId: signup.phoneNumberId,
        }),
      });
      const result = await complete.json().catch(() => ({})) as { error?: string; accountCount?: number; phoneCount?: number };
      if (!complete.ok) throw new Error(result.error || 'WhatsApp authorization could not be completed.');
      setTestState('success');
      setTestMessage(`Connected ${result.phoneCount || 1} WhatsApp Business number${result.phoneCount === 1 ? '' : 's'}. ORIN AI discovered the account, subscribed messages, and stored access securely.`);
    } catch (cause) {
      setTestState('error');
      setTestMessage(cause instanceof Error ? cause.message : 'WhatsApp authorization could not be completed.');
    } finally {
      setProviderAction('idle');
    }
  };

  const beginTikTokAuthorization = async () => {
    if (!user || !workspace || !capabilities.tiktok?.authorizationReady) return;
    setProviderAction('opening');
    setError('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id });
      const response = await fetch(`/api/integrations/tiktok/start?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || 'TikTok authorization could not be started.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setProviderAction('idle');
      setError(cause instanceof Error ? cause.message : 'TikTok authorization could not be started.');
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

  const beginLazadaAuthorization = async () => {
    if (!user || !workspace || !capabilities.lazada?.authorizationReady || !lazadaAgentId) return;
    setProviderAction('opening');
    setError('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id, agentId: lazadaAgentId });
      const response = await fetch(`/api/integrations/lazada/start?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || 'Lazada authorization could not be started.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setProviderAction('idle');
      setError(cause instanceof Error ? cause.message : 'Lazada authorization could not be started.');
    }
  };

  const beginShopeeAuthorization = async () => {
    if (!user || !workspace || !capabilities.shopee?.authorizationReady || !shopeeAgentId) return;
    setProviderAction('opening');
    setError('');
    try {
      const token = await user.getIdToken();
      const query = new URLSearchParams({ workspaceId: workspace.id, agentId: shopeeAgentId });
      const response = await fetch(`/api/integrations/shopee/start?${query.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({})) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error || 'Shopee authorization could not be started.');
      window.location.assign(payload.authorizationUrl);
    } catch (cause) {
      setProviderAction('idle');
      setError(cause instanceof Error ? cause.message : 'Shopee authorization could not be started.');
    }
  };

  const availabilityCopy = (integration: IntegrationCatalogItem) => {
    const saved = connections.find((connection) => connection.provider === integration.id);
    if (saved?.status === 'connected' && saved.health === 'healthy') return 'Connected';
    if (saved?.authorizationStatus === 'authorized') {
      if (saved.health === 'identity_verified') return 'Account synced · messaging review';
      if (saved.health === 'awaiting_first_event') return 'Connected · awaiting first message';
      if (saved.health === 'subscription_partial') return 'Some accounts need attention';
      if (saved.health === 'webhook_not_configured') return 'Webhook setup required';
      return saved.health === 'healthy' ? 'Connected' : 'Connection needs attention';
    }
    if (integration.id === 'n8n') return n8nReady ? 'Ready to link' : vaultHealth === 'checking' ? 'Checking secure storage' : 'Secure storage required';
    if (integration.id === 'webhook') return verifiedWebhookReady ? 'Ready to verify' : vaultHealth === 'checking' ? 'Checking secure storage' : 'Secure storage required';
    if (integration.id === 'website') return websiteReady ? 'Ready to publish' : vaultHealth === 'checking' ? 'Checking secure storage' : 'Publishing backend required';
    const capability = capabilities[integration.id];
    if (capability?.authorizationReady) return 'Ready to authorize';
    if (capability?.partnerAccessRequired) return 'Partner access required';
    return 'App credentials required';
  };

  const activeN8nConnection = connections.find((connection) => connection.provider === 'n8n' && connection.status === 'connected' && connection.health === 'healthy');
  const n8nAdvancedReady = Boolean(
    n8nInstanceUrl.trim()
    && (n8nApiKey.trim() || activeN8nConnection?.advancedConfigured)
    && n8nByokRows.every((row) => (!row.name.trim() && !row.value.trim()) || (row.name.trim() && row.value.trim())),
  );
  const n8nEditorHref = (() => {
    const candidate = n8nImportedWorkflowUrl || activeN8nConnection?.n8nEditorUrl || n8nInstanceUrl;
    try {
      const url = new URL(candidate);
      return url.protocol === 'https:' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.app\.n8n\.cloud$/.test(url.hostname.toLowerCase())
        ? url.toString()
        : 'https://app.n8n.cloud/';
    } catch {
      return 'https://app.n8n.cloud/';
    }
  })();

  const removeDraft = async (connection: WorkspaceConnection) => {
    if (!db || !workspace || !user) return;
    setError('');
    try {
      const serverManaged = ['meta', 'whatsapp', 'tiktok', 'lazada', 'shopee'].includes(connection.provider) && connection.authorizationStatus === 'authorized';
      if (connection.provider === 'webhook') {
        const response = await fetch('/api/widget/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await user.getIdToken()}` },
          body: JSON.stringify({ mode: 'team_access', action: 'disconnect_webhook', workspaceId: workspace.id }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(result.error || 'The webhook connection could not be removed.');
      } else if (connection.provider === 'n8n' || connection.provider === 'website' || connection.provider === 'shopify' || serverManaged) {
        const token = await user.getIdToken();
        const endpoint = ['meta', 'whatsapp', 'tiktok'].includes(connection.provider)
          ? `/api/integrations/${connection.provider}/start`
          : `/api/integrations/${connection.provider}/connect`;
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
      {['meta', 'shopify', 'tiktok', 'lazada', 'shopee'].includes(oauthProvider || '') && oauthStatus && (
        <section className={`integration-result is-${oauthStatus === 'authorized' ? 'success' : 'attention'}`} role="status">
          <strong>{oauthStatus === 'authorized' ? `${oauthProvider === 'shopify' ? 'Shopify' : oauthProvider === 'tiktok' ? 'TikTok' : oauthProvider === 'lazada' ? 'Lazada' : oauthProvider === 'shopee' ? 'Shopee' : 'Meta'} account synced.` : oauthStatus === 'cancelled' ? 'Authorization was cancelled.' : 'The connection needs another step.'}</strong>
          <span>{oauthStatus === 'authorized'
            ? oauthProvider === 'shopify'
              ? 'ORIN AI stored the store token in its encrypted vault. The connection becomes live after the first verified webhook.'
              : oauthProvider === 'tiktok'
                ? 'ORIN AI verified the TikTok account and stored its refreshable access in the encrypted vault. Customer messaging and TikTok Shop remain locked until TikTok approves those partner products.'
                : oauthProvider === 'lazada'
                  ? 'ORIN AI discovered every eligible shop and encrypted its access. Seller chat becomes healthy after Lazada delivers the first signed message push.'
                : oauthProvider === 'shopee'
                  ? 'ORIN AI discovered every shop approved in Shopee, encrypted each renewable credential, and prepared one inbox. Seller chat becomes healthy after the first signed Webchat Push.'
                : 'ORIN AI discovered the eligible Pages and linked Instagram accounts, stored access securely, subscribed every account Meta accepted, and assigned your selected AI.'
            : oauthStatus === 'no_pages'
              ? 'This Facebook account does not manage an eligible Page. Check its Page access, then try again.'
              : oauthStatus === 'agent_not_ready'
                ? oauthProvider === 'lazada'
                  ? 'Complete all six AI decisions and include Lazada, then connect again.'
                  : oauthProvider === 'shopee'
                    ? 'Complete all six AI decisions and include Shopee, then connect again.'
                    : 'Complete all six AI decisions and include Messenger or Instagram, then connect again.'
                : oauthStatus === 'scope_missing'
                  ? 'TikTok did not grant the basic account permission. Review the consent screen and try again.'
                  : 'No channel was marked connected. You can safely try again.'}</span>
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
                <div><strong>{connection.displayName}</strong><p>{catalogItem?.name || connection.provider}{connection.desiredChannels.length ? ` · ${connection.desiredChannels.join(', ')}` : ''}{connection.agentId ? ` · ${websiteAgents.find((agent) => agent.id === connection.agentId)?.name || 'Assigned ORIN AI'}` : ''}</p></div>
                <span className={`connection-status is-${connection.status}`}>{connection.authorizationStatus === 'authorized'
                  ? connection.health === 'healthy' ? 'Connected'
                    : connection.health === 'identity_verified' ? 'Account synced · access review'
                    : connection.health === 'awaiting_first_event' ? 'Connected · awaiting first message'
                      : connection.health === 'subscription_partial' ? 'Some accounts need attention'
                        : 'Webhook setup required'
                  : statusCopy[connection.status] || 'Setup required'}</span>
                {canRemoveConnections ? <button type="button" onClick={() => removeDraft(connection)}>Remove</button> : <span />}
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
            <button type="button" disabled={!canEditConnections} title={!canEditConnections ? 'Ask a workspace editor or admin to change integrations.' : undefined} onClick={() => openSetup(integration)}>{canEditConnections ? integration.id === 'n8n' ? 'Link Cloud' : integration.id === 'webhook' ? 'Verify' : capabilities[integration.id]?.authorizationReady && integration.id !== 'website' ? 'Connect' : 'Set up' : 'View only'}</button>
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
              <p>{selected.id === 'webhook' ? 'Verify the endpoint once. ORIN AI encrypts the destination and signs every automation delivery.' : 'Connect the account once. ORIN AI keeps provider credentials private and completes every setup step the provider allows.'}</p>
              {selected.id === 'meta' && (
                <>
                  <label><span>ORIN AI for automatic replies</span><select value={metaAgentId} onChange={(event) => setMetaAgentId(event.currentTarget.value)}><option value="">Choose a Messenger or Instagram-ready AI</option>{websiteAgents.map((agent) => {
                    const metaReady = agent.readiness >= 6 && agent.channels.some((channel) => ['Messenger', 'Instagram'].includes(channel));
                    return <option key={agent.id} value={agent.id} disabled={!metaReady}>{agent.name} · {agent.readiness}/6{metaReady ? '' : ' · add Messenger or Instagram'}</option>;
                  })}</select><small>This AI will be published for the Meta channels selected in its brief. Your team can take over from the inbox.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.some((channel) => ['Messenger', 'Instagram'].includes(channel))) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Messenger or Instagram.</p>}
                  <div className={`provider-authorization ${capabilities.meta?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                    <div><strong>{capabilities.meta?.authorizationReady ? 'Connect Facebook and Instagram in one step.' : capabilities.meta?.partnerAccessRequired ? 'Meta App Review is in progress.' : 'Meta app credentials are required.'}</strong><span>{capabilities.meta?.authorizationReady ? 'Continue with Facebook. ORIN AI will find the Pages you manage, link professional Instagram accounts, subscribe messages, and store access securely.' : capabilities.meta?.partnerAccessRequired ? 'The production sign-in remains locked until Meta approves ORIN AI for live client data.' : 'ORIN AI will enable Meta sign-in only after the app ID, secret, encrypted vault, callback, and webhook are configured.'}</span></div>
                    <button type="button" disabled={!capabilities.meta?.authorizationReady || !metaAgentId || providerAction === 'opening'} onClick={beginMetaAuthorization}>{providerAction === 'opening' ? 'Opening Meta…' : capabilities.meta?.authorizationReady ? 'Continue with Facebook' : 'Not available yet'}</button>
                  </div>
                </>
              )}
              {selected.id === 'whatsapp' && (
                <>
                  <label><span>ORIN AI for WhatsApp replies</span><select value={whatsappAgentId} onChange={(event) => setWhatsappAgentId(event.currentTarget.value)}><option value="">Choose a WhatsApp-ready AI</option>{websiteAgents.map((agent) => {
                    const whatsappReady = agent.readiness >= 6 && agent.channels.includes('WhatsApp');
                    return <option key={agent.id} value={agent.id} disabled={!whatsappReady}>{agent.name} · {agent.readiness}/6{whatsappReady ? '' : ' · add WhatsApp'}</option>;
                  })}</select><small>This AI answers new WhatsApp customer messages. Your team can take over at any time from the shared inbox.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.includes('WhatsApp')) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include WhatsApp.</p>}
                  <div className={`provider-authorization ${capabilities.whatsapp?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                    <div>
                      <strong>{capabilities.whatsapp?.authorizationReady ? 'Connect WhatsApp Business in one guided sign-in.' : 'WhatsApp Embedded Signup is required.'}</strong>
                      <span>{capabilities.whatsapp?.authorizationReady
                        ? 'Continue with Meta. Choose or create the business account and phone number; ORIN AI discovers the eligible numbers, subscribes messages, and prepares the inbox automatically.'
                        : 'The button unlocks after ORIN AI’s Meta app is approved for WhatsApp Embedded Signup and its production configuration is installed.'}</span>
                      <small>No business IDs, phone-number IDs, tokens, or webhook secrets are requested from you.</small>
                    </div>
                    <button type="button" disabled={!capabilities.whatsapp?.authorizationReady || !whatsappAgentId || providerAction === 'opening'} onClick={beginWhatsAppAuthorization}>{providerAction === 'opening' ? 'Opening WhatsApp…' : capabilities.whatsapp?.authorizationReady ? 'Continue with WhatsApp' : 'Not available yet'}</button>
                  </div>
                  {testMessage && <p className={`integration-connection-result is-${testState}`} role="status">{testMessage}</p>}
                </>
              )}
              {selected.id === 'tiktok' && (
                <div className={`provider-authorization ${capabilities.tiktok?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                  <div>
                    <strong>{capabilities.tiktok?.authorizationReady ? 'Connect your TikTok account in one step.' : 'TikTok app approval and credentials are required.'}</strong>
                    <span>{capabilities.tiktok?.authorizationReady
                      ? 'Continue with TikTok. ORIN AI verifies the account, stores refreshable access in the encrypted vault, and handles future deauthorization automatically.'
                      : 'The sign-in button unlocks after TikTok approves ORIN AI Login Kit and the production callback is configured.'}</span>
                    <small>TikTok customer messages and TikTok Shop use separate partner products. They will remain clearly locked until TikTok grants that access.</small>
                  </div>
                  <button type="button" disabled={!capabilities.tiktok?.authorizationReady || providerAction === 'opening'} onClick={beginTikTokAuthorization}>{providerAction === 'opening' ? 'Opening TikTok…' : capabilities.tiktok?.authorizationReady ? 'Continue with TikTok' : 'Not available yet'}</button>
                </div>
              )}
              {selected.id === 'shopee' && (
                <>
                  <label><span>ORIN AI for seller chat</span><select value={shopeeAgentId} onChange={(event) => setShopeeAgentId(event.currentTarget.value)}><option value="">Choose a Shopee-ready AI</option>{websiteAgents.map((agent) => {
                    const shopeeReady = agent.readiness >= 6 && agent.channels.includes('Shopee');
                    return <option key={agent.id} value={agent.id} disabled={!shopeeReady}>{agent.name} · {agent.readiness}/6{shopeeReady ? '' : ' · add Shopee'}</option>;
                  })}</select><small>This approved voice and knowledge will serve every Shopee shop selected during sign-in. Your team can take over in the shared inbox.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.includes('Shopee')) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Shopee.</p>}
                  <div className={`provider-authorization ${capabilities.shopee?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                    <div>
                      <strong>{capabilities.shopee?.authorizationReady ? 'Connect every authorized Shopee shop in one sign-in.' : 'Shopee Customer Service partner approval is required.'}</strong>
                      <span>{capabilities.shopee?.authorizationReady
                        ? 'Continue with Shopee. Choose the shops once; ORIN AI discovers them, stores renewable access in its encrypted vault, and prepares one seller-chat inbox automatically.'
                        : 'Shopee closed new third-party Customer Service App applications in November 2024. This button unlocks only when Shopee approves ORIN AI and issues production Partner credentials.'}</span>
                      <small>No shop IDs, access tokens, refresh tokens, partner keys, or webhook secrets are requested from the seller.</small>
                    </div>
                    <button type="button" disabled={!capabilities.shopee?.authorizationReady || !shopeeAgentId || providerAction === 'opening'} onClick={beginShopeeAuthorization}>{providerAction === 'opening' ? 'Opening Shopee…' : capabilities.shopee?.authorizationReady ? 'Continue with Shopee' : 'Partner approval required'}</button>
                  </div>
                </>
              )}
              {selected.id === 'lazada' && (
                <>
                  <label><span>ORIN AI for seller chat</span><select value={lazadaAgentId} onChange={(event) => setLazadaAgentId(event.currentTarget.value)}><option value="">Choose a Lazada-ready AI</option>{websiteAgents.map((agent) => {
                    const lazadaReady = agent.readiness >= 6 && agent.channels.includes('Lazada');
                    return <option key={agent.id} value={agent.id} disabled={!lazadaReady}>{agent.name} · {agent.readiness}/6{lazadaReady ? '' : ' · add Lazada'}</option>;
                  })}</select><small>ORIN AI assigns this approved voice and knowledge to every eligible shop discovered during sign-in.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.includes('Lazada')) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Lazada.</p>}
                  <div className={`provider-authorization ${capabilities.lazada?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                    <div>
                      <strong>{capabilities.lazada?.authorizationReady ? 'Connect every eligible Lazada shop in one step.' : capabilities.lazada?.partnerAccessRequired ? 'Lazada partner approval is required.' : 'Lazada partner credentials are required.'}</strong>
                      <span>{capabilities.lazada?.authorizationReady
                        ? 'Continue with Lazada. The seller approves access once; ORIN AI discovers the connected shops, encrypts their credentials, and prepares one inbox automatically.'
                        : 'The sign-in button unlocks after Lazada approves ORIN AI and the production callback is configured.'}</span>
                      <small>Seller chat requires Lazada IM permission and a signed push URL. ORIN AI reports that health honestly after authorization.</small>
                    </div>
                    <button type="button" disabled={!capabilities.lazada?.authorizationReady || !lazadaAgentId || providerAction === 'opening'} onClick={beginLazadaAuthorization}>{providerAction === 'opening' ? 'Opening Lazada…' : capabilities.lazada?.authorizationReady ? 'Continue with Lazada' : 'Not available yet'}</button>
                  </div>
                </>
              )}
              {selected.id === 'shopify' && (
                <div className={`provider-authorization ${capabilities.shopify?.authorizationReady ? 'is-ready' : 'is-waiting'}`}>
                  <div><strong>{capabilities.shopify?.authorizationReady ? 'Shopify authorization is ready.' : capabilities.shopify?.partnerAccessRequired ? 'Shopify production distribution is not approved yet.' : 'Shopify app credentials are required.'}</strong><span>{capabilities.shopify?.authorizationReady ? 'Enter the permanent myshopify.com domain. Shopify will show the permissions before anything is connected.' : capabilities.shopify?.partnerAccessRequired ? 'The connection remains locked until ORIN AI has an approved production distribution path.' : 'The Shopify button unlocks only after the app client, secret, encrypted vault, and callback are configured.'}</span></div>
                </div>
              )}
              {selected.id === 'airbnb' && (
                <>
                  <label><span>ORIN AI for guest messages</span><select value={airbnbAgentId} onChange={(event) => setAirbnbAgentId(event.currentTarget.value)}><option value="">Choose an Airbnb-ready AI</option>{websiteAgents.map((agent) => {
                    const airbnbReady = agent.readiness >= 6 && agent.channels.includes('Airbnb');
                    return <option key={agent.id} value={agent.id} disabled={!airbnbReady}>{agent.name} · {agent.readiness}/6{airbnbReady ? '' : ' · add Airbnb'}</option>;
                  })}</select><small>This approved voice and knowledge will serve eligible listings after Airbnb grants ORIN AI software-partner access.</small></label>
                  {!websiteAgents.some((agent) => agent.readiness >= 6 && agent.channels.includes('Airbnb')) && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Airbnb.</p>}
                  <div className="provider-authorization is-waiting">
                    <div><strong>Airbnb software-partner approval is required.</strong><span>Save the hosting team and assigned AI now. When access is granted, one Airbnb authorization will discover eligible listings and bring supported guest threads into the shared inbox.</span><small>No password, browser session, or private token is requested. ORIN AI will never scrape an Airbnb account.</small></div>
                  </div>
                </>
              )}
              {!['meta', 'whatsapp', 'tiktok', 'shopee', 'lazada', 'shopify', 'airbnb', 'n8n', 'webhook', 'website'].includes(selected.id) && !capabilities[selected.id]?.authorizationReady && (
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
              ) : !['meta', 'whatsapp', 'tiktok', 'shopee', 'lazada'].includes(selected.id) && <label><span>{selected.setupLabel}</span><input value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} placeholder={`Example: ${selected.name} main account`} /></label>}
              {!['shopify', 'meta', 'whatsapp', 'tiktok', 'shopee', 'lazada', 'webhook'].includes(selected.id) && <fieldset>
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
                  {testState !== 'success' ? (
                    <div className="integration-webhook-test">
                      <ol><li>Open n8n Cloud and create a Webhook trigger.</li><li>Use its production URL, then activate the workflow.</li><li>Paste the URL below and link it to ORIN AI.</li></ol>
                      <label><span>Production webhook URL</span><input type="url" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.currentTarget.value); setTestState('idle'); setTestMessage(''); }} placeholder="https://your-workspace.app.n8n.cloud/webhook/..." /></label>
                      <a href="https://app.n8n.cloud/" target="_blank" rel="noopener noreferrer">Open n8n Cloud <ExternalLink aria-hidden="true" /></a>
                      {testMessage && <p className={`is-${testState}`} role="status">{testMessage}</p>}
                    </div>
                  ) : (
                    <div className="n8n-outcome-setup">
                      <header>
                        <div><strong>Send verified revenue back to ORIN AI</strong><span>Add one HTTP Request node after a completed order or booking. Analytics counts each unique result once.</span></div>
                        <span className="n8n-outcome-setup__status"><Check aria-hidden="true" /> Ready</span>
                      </header>
                      {testMessage && <p className="n8n-outcome-setup__message" role="status">{testMessage}</p>}
                      <ol>
                        <li><strong>Method and URL</strong><span>Choose POST, then use the endpoint below.</span></li>
                        <li><strong>Authentication</strong><span>Choose Generic Credential Type → Bearer Auth, then paste the one-time token.</span></li>
                        <li><strong>Headers</strong><span>Add Idempotency-Key with a stable order or booking ID, such as <code>{'{{ $json.id }}'}</code>.</span></li>
                        <li><strong>JSON body</strong><span>Turn on Send Body, choose JSON, and map the example fields to your workflow.</span></li>
                      </ol>
                      <div className="n8n-outcome-setup__field">
                        <span>Outcome endpoint</span>
                        <div><input readOnly value={n8nOutcomeUrl || n8nOutcomeEndpoint} aria-label="ORIN AI outcome endpoint" /><button type="button" onClick={() => copyN8nOutcomeValue(n8nOutcomeUrl || n8nOutcomeEndpoint, 'url')}><Copy aria-hidden="true" /> {n8nOutcomeCopy === 'url' ? 'Copied' : 'Copy'}</button></div>
                      </div>
                      <div className="n8n-outcome-setup__field">
                        <span>Bearer token</span>
                        {n8nOutcomeToken ? (
                          <><div><input readOnly value={n8nOutcomeToken} aria-label="One-time ORIN AI outcome token" /><button type="button" onClick={() => copyN8nOutcomeValue(n8nOutcomeToken, 'token')}><Copy aria-hidden="true" /> {n8nOutcomeCopy === 'token' ? 'Copied' : 'Copy'}</button></div><small>Shown once. ORIN AI does not save the raw token in this browser or database.</small></>
                        ) : (
                          <><div className="is-masked"><input readOnly value={activeN8nConnection?.outcomeTokenHint ? `••••••••••${activeN8nConnection.outcomeTokenHint}` : 'Token hidden after setup'} aria-label="Stored outcome token is hidden" /><button type="button" disabled>Hidden</button></div><small>Create a new token if you did not save the original. The old token will stop working.</small></>
                        )}
                      </div>
                      <div className="n8n-outcome-setup__example">
                        <div><span>JSON body example</span><button type="button" onClick={() => copyN8nOutcomeValue(n8nOutcomeExample, 'example')}><Copy aria-hidden="true" /> {n8nOutcomeCopy === 'example' ? 'Copied' : 'Copy JSON'}</button></div>
                        <pre><code>{n8nOutcomeExample}</code></pre>
                      </div>
                      <div className="n8n-outcome-setup__actions"><a href="https://app.n8n.cloud/" target="_blank" rel="noopener noreferrer">Open n8n Cloud <ExternalLink aria-hidden="true" /></a><button type="button" disabled={n8nOutcomeState === 'rotating'} onClick={rotateN8nOutcomeToken}>{n8nOutcomeState === 'rotating' ? 'Creating…' : n8nOutcomeToken ? 'Replace token' : activeN8nConnection?.outcomeConfigured ? 'Create new token' : 'Create outcome token'}</button></div>
                    </div>
                  )}
                  <details className="n8n-advanced-setup">
                    <summary>
                      <div><strong>Advanced n8n setup</strong><span>Connect the n8n API, import workflow JSON, and keep private provider keys in ORIN AI.</span></div>
                      <span>Advanced</span>
                    </summary>
                    <div className="n8n-advanced-setup__body">
                      <p>The visual editor opens in your real n8n Cloud workspace. ORIN AI imports the workflow as inactive so you can review credentials before activation.</p>
                      <div className="n8n-advanced-setup__grid">
                        <label>
                          <span>n8n Cloud workspace URL</span>
                          <input type="url" value={n8nInstanceUrl} onChange={(event) => { setN8nInstanceUrl(event.currentTarget.value); setN8nAdvancedState('idle'); }} placeholder="https://your-workspace.app.n8n.cloud" autoCapitalize="none" autoCorrect="off" />
                          <small>Paste your workspace URL. ORIN AI accepts n8n Cloud only; self-hosted servers are coming next.</small>
                        </label>
                        <label>
                          <span>n8n API key</span>
                          <input type="password" value={n8nApiKey} onChange={(event) => { setN8nApiKey(event.currentTarget.value); setN8nAdvancedState('idle'); }} placeholder={activeN8nConnection?.advancedConfigured ? 'Stored securely · enter only to replace' : 'Paste API key'} autoComplete="new-password" />
                          <small>Create this in n8n under Settings → n8n API. The raw key never returns to the browser.</small>
                        </label>
                      </div>
                      <section className="n8n-workflow-import">
                        <header><div><strong>Workflow JSON</strong><span>Optional. Export a workflow from n8n, then load the JSON here.</span></div>{activeN8nConnection?.importedWorkflowName && <small>{activeN8nConnection.importedWorkflowName} · {activeN8nConnection.importedNodeCount || 0} nodes</small>}</header>
                        <label className="n8n-workflow-import__picker">
                          <Plus aria-hidden="true" />
                          <span>{n8nWorkflowPreview ? 'Choose another workflow' : 'Choose workflow JSON'}</span>
                          <input type="file" accept=".json,application/json" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; void loadN8nWorkflowFile(file); }} />
                        </label>
                        {n8nWorkflowPreview && <div className="n8n-workflow-import__preview"><Check aria-hidden="true" /><div><strong>{n8nWorkflowPreview.name}</strong><span>{n8nWorkflowPreview.fileName} · {n8nWorkflowPreview.nodeCount} nodes</span></div><button type="button" onClick={() => { setN8nWorkflow(null); setN8nWorkflowPreview(null); setN8nAdvancedMessage(''); }}>Remove</button></div>}
                      </section>
                      <section className="n8n-byok-vault">
                        <header><div><strong>ORIN AI BYOK vault</strong><span>Add keys used by ORIN AI’s direct providers. n8n credentials stay managed inside n8n.</span></div>{Boolean(activeN8nConnection?.byokNames?.length) && <small>{activeN8nConnection?.byokNames?.join(' · ')}</small>}</header>
                        <div className="n8n-byok-vault__rows">
                          {n8nByokRows.map((row, index) => (
                            <div className="n8n-byok-vault__row" key={row.id}>
                              <input value={row.name} onChange={(event) => updateN8nByokRow(index, 'name', event.currentTarget.value)} placeholder="Provider name · e.g. ElevenLabs" aria-label={`BYOK provider ${index + 1}`} />
                              <input type="password" value={row.value} onChange={(event) => updateN8nByokRow(index, 'value', event.currentTarget.value)} placeholder="Secret API key" autoComplete="new-password" aria-label={`BYOK secret ${index + 1}`} />
                              <button type="button" aria-label={`Remove BYOK row ${index + 1}`} onClick={() => setN8nByokRows((current) => current.length === 1 ? [createN8nByokRow()] : current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 aria-hidden="true" /></button>
                            </div>
                          ))}
                        </div>
                        <button type="button" className="n8n-byok-vault__add" disabled={n8nByokRows.length >= 10} onClick={() => setN8nByokRows((current) => [...current, createN8nByokRow()])}><Plus aria-hidden="true" /> Add another key</button>
                      </section>
                      {n8nAdvancedMessage && <p className={`n8n-advanced-setup__message is-${n8nAdvancedState}`} role="status">{n8nAdvancedMessage}</p>}
                      <div className="n8n-advanced-setup__actions">
                        <a href={n8nEditorHref} target="_blank" rel="noopener noreferrer">{n8nImportedWorkflowUrl ? 'Open imported workflow' : 'Open n8n Cloud'} <ExternalLink aria-hidden="true" /></a>
                        <button type="button" disabled={!n8nAdvancedReady || n8nAdvancedState === 'saving'} onClick={saveN8nAdvanced}>{n8nAdvancedState === 'saving' ? (n8nWorkflow ? 'Importing…' : 'Verifying…') : n8nWorkflow ? 'Import workflow & save' : activeN8nConnection?.advancedConfigured ? 'Verify & update' : 'Verify & save'}</button>
                      </div>
                    </div>
                  </details>
                </>
              )}
              {selected.id === 'webhook' && (
                <div className="integration-webhook-test verified-webhook-setup">
                  {!verifiedWebhookReady && <div className="provider-authorization is-waiting"><div><strong>Secure connector storage is required.</strong><span>Verification unlocks after ORIN AI confirms its encrypted server vault.</span></div></div>}
                  <ol><li>Make a public HTTPS endpoint that accepts POST requests.</li><li>When <code>type</code> is <code>endpoint.verification</code>, return <code>{'{ "challenge": "the received challenge" }'}</code> as JSON.</li><li>Paste the endpoint below. ORIN AI blocks redirects and private network addresses.</li></ol>
                  <label><span>Public HTTPS webhook URL</span><input type="url" value={webhookUrl} onChange={(event) => { setWebhookUrl(event.currentTarget.value); setTestState('idle'); setTestMessage(''); setWebhookSigningSecret(''); }} placeholder="https://api.example.com/orin/events" autoCapitalize="none" autoCorrect="off" /></label>
                  {testMessage && <p className={`is-${testState}`} role="status">{testMessage}</p>}
                  {webhookSigningSecret && <div className="n8n-outcome-setup__field"><span>HMAC signing secret · shown once</span><div><input readOnly value={webhookSigningSecret} aria-label="One-time webhook signing secret" /><button type="button" onClick={() => void copyWebhookSecret()}><Copy aria-hidden="true" /> {webhookCopy === 'secret' ? 'Copied' : 'Copy'}</button></div><small>Verify each delivery with the <code>X-ORIN-Signature-256</code> header before processing it.</small></div>}
                </div>
              )}
              {selected.id === 'website' && (
                <div className="website-integration-setup">
                  <label><span>Published AI</span><select value={websiteAgentId} onChange={(event) => { setWebsiteAgentId(event.currentTarget.value); setWebsiteState('idle'); setWebsiteEmbed(''); }}><option value="">Choose a Website-ready AI</option>{websiteAgents.map((agent) => <option key={agent.id} value={agent.id} disabled={agent.readiness < 6 || !agent.channels.includes('Website')}>{agent.name} · {agent.readiness}/6{agent.channels.includes('Website') ? '' : ' · Website not selected'}</option>)}</select></label>
                  {!websiteAgents.length && <p className="website-integration-setup__empty">Create an AI first, complete all six decisions, and include Website as a channel.</p>}
                  <label><span>Allowed website origins</span><textarea value={websiteOrigins} onChange={(event) => { setWebsiteOrigins(event.currentTarget.value); setWebsiteState('idle'); }} placeholder={'https://shop.example.com\nhttps://www.example.com'} rows={3} /><small>Enter exact origins only—no paths or wildcards. Up to five.</small></label>
                  {websiteEmbed && <div className="website-embed-result"><div><strong>Widget published</strong><span>Paste this once before your website's closing body tag.</span></div><pre><code>{websiteEmbed}</code></pre><button type="button" onClick={copyWebsiteEmbed}><Copy aria-hidden="true" /> {copyState === 'copied' ? 'Copied' : 'Copy embed code'}</button></div>}
                </div>
              )}
              <div className="integration-dialog__trust"><Settings aria-hidden="true" /><p>{selected.id === 'n8n' ? <><strong>Every credential has one narrow purpose.</strong> ORIN AI encrypts webhook, n8n API, and BYOK secrets separately from the visible workspace record. The revocable outcome token can report completed orders and bookings only; it cannot read your workspace.</> : selected.id === 'webhook' ? <><strong>The destination is verified before it can receive events.</strong> ORIN AI validates public DNS, pins each secure connection to the approved address, rejects internal destinations and redirects, encrypts the URL and secret, then signs every delivery.</> : selected.id === 'shopify' ? <><strong>Your Shopify token stays server-side.</strong> Shopify shows the requested access first; ORIN AI encrypts the resulting store token and never sends it to the browser.</> : selected.id === 'meta' ? <><strong>Your Meta access stays server-side.</strong> Facebook shows the permissions first; ORIN AI encrypts the resulting account access and never sends it to the browser.</> : selected.id === 'whatsapp' ? <><strong>Your WhatsApp access stays server-side.</strong> Meta shows the account and permissions first; ORIN AI encrypts the token and keeps raw account and phone IDs out of the browser.</> : selected.id === 'tiktok' ? <><strong>Your TikTok access stays server-side.</strong> TikTok shows the requested permission first; ORIN AI encrypts both access and refresh tokens, and revokes them when you disconnect.</> : selected.id === 'shopee' ? <><strong>Your Shopee access stays server-side.</strong> Shopee shows the shops and authorization period first; ORIN AI encrypts each renewable credential and keeps raw shop IDs out of the browser.</> : selected.id === 'lazada' ? <><strong>Your Lazada access stays server-side.</strong> Lazada shows the permissions first; ORIN AI encrypts the seller tokens and keeps raw shop IDs out of the browser.</> : selected.id === 'airbnb' ? <><strong>Your Airbnb account stays untouched.</strong> This saves only your rollout plan and assigned ORIN AI. Account authorization will open only through Airbnb's approved software connection.</> : <><strong>No access token is requested here.</strong> This saves a private setup record so you can resume. Provider authorization opens only when the corresponding backend credentials are ready.</>}</p></div>
            </div>
            <footer>
              <button type="button" onClick={() => setSelected(null)}>{['n8n', 'webhook'].includes(selected.id) && testState === 'success' ? 'Done' : 'Cancel'}</button>
              {selected.id === 'meta' || selected.id === 'whatsapp' || selected.id === 'tiktok' || selected.id === 'shopee' || selected.id === 'lazada' ? null : selected.id === 'n8n' ? (
                <button type="button" className="is-primary" disabled={testState === 'testing' || testState === 'success' || !n8nReady || !displayName.trim() || !desiredChannels.length || !webhookUrl.trim()} onClick={connectN8nCloud}>{testState === 'testing' ? 'Verifying…' : testState === 'success' ? 'Linked' : 'Verify & link workflow'}</button>
              ) : selected.id === 'website' ? (
                <button type="button" className="is-primary" disabled={websiteState === 'publishing' || !websiteReady || !displayName.trim() || !desiredChannels.length || !websiteAgentId || !websiteOrigins.trim()} onClick={connectWebsite}>{websiteState === 'publishing' ? 'Publishing…' : websiteState === 'success' ? 'Update widget' : 'Publish website widget'}</button>
              ) : selected.id === 'shopify' ? (
                <button type="button" className="is-primary" disabled={providerAction === 'opening' || !capabilities.shopify?.authorizationReady || !shopDomain.trim()} onClick={beginShopifyAuthorization}>{providerAction === 'opening' ? 'Opening Shopify…' : capabilities.shopify?.authorizationReady ? 'Continue with Shopify' : 'Not available yet'}</button>
              ) : selected.id === 'webhook' ? (
                <button type="button" className="is-primary" disabled={testState === 'testing' || testState === 'success' || !verifiedWebhookReady || !displayName.trim() || !webhookUrl.trim()} onClick={connectVerifiedWebhook}>{testState === 'testing' ? 'Verifying…' : testState === 'success' ? 'Verified' : 'Verify & connect'}</button>
              ) : (
                <button type="button" className="is-primary" disabled={saving || !displayName.trim() || !desiredChannels.length || (selected.id === 'airbnb' && !airbnbAgentId)} onClick={saveSetup}>{saving ? 'Saving…' : selected.id === 'airbnb' ? 'Save access plan' : 'Save setup'}</button>
              )}
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { user, workspace } = useAuth();
  const [members, setMembers] = useState<Array<{ userId: string; role: 'owner' | 'admin' | 'editor' | 'viewer'; displayName: string; email: string; photoURL: string; isOwner: boolean }>>([]);
  const [invitations, setInvitations] = useState<Array<{ id: string; email: string; role: 'admin' | 'editor' | 'viewer'; invitedAt: string; expiresAt: string }>>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'editor' | 'viewer'>('editor');
  const [teamLoading, setTeamLoading] = useState(true);
  const [teamSaving, setTeamSaving] = useState('');
  const [teamError, setTeamError] = useState('');
  const [teamNotice, setTeamNotice] = useState('');
  const canAdmin = workspace?.role === 'owner' || workspace?.role === 'admin';

  const teamRequest = useCallback(async (action: string, values: Record<string, unknown> = {}) => {
    if (!user || !workspace) throw new Error('Sign in again to manage this workspace.');
    const response = await fetch('/api/widget/message', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'team_access', action, workspaceId: workspace.id, ...values }),
    });
    const payload = await response.json().catch(() => ({})) as { error?: string; members?: typeof members; invitations?: typeof invitations };
    if (!response.ok) throw new Error(payload.error || 'The team could not be updated.');
    return payload;
  }, [user, workspace]);

  const loadTeam = useCallback(async () => {
    if (!user || !workspace) return;
    setTeamLoading(true);
    setTeamError('');
    try {
      const payload = await teamRequest('list_members');
      setMembers(Array.isArray(payload.members) ? payload.members : []);
      setInvitations(Array.isArray(payload.invitations) ? payload.invitations : []);
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : 'The team could not be loaded.');
    } finally {
      setTeamLoading(false);
    }
  }, [teamRequest, user, workspace]);

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const mutationId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

  const inviteMember = async () => {
    if (!inviteEmail.trim() || !canAdmin) return;
    setTeamSaving('invite');
    setTeamError('');
    setTeamNotice('');
    try {
      await teamRequest('invite_member', { email: inviteEmail.trim(), role: inviteRole, requestId: mutationId() });
      setInviteEmail('');
      setTeamNotice('Invitation saved. Ask them to sign in to ORIN AI with that Google account.');
      await loadTeam();
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : 'The invitation could not be saved.');
    } finally {
      setTeamSaving('');
    }
  };

  const updateMemberRole = async (member: typeof members[number], role: 'admin' | 'editor' | 'viewer') => {
    setTeamSaving(member.userId);
    setTeamError('');
    try {
      await teamRequest('update_member', { targetUserId: member.userId, role, requestId: mutationId() });
      await loadTeam();
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : 'The member role could not be changed.');
    } finally {
      setTeamSaving('');
    }
  };

  const removeMember = async (member: typeof members[number]) => {
    if (!window.confirm(`Remove ${member.displayName || member.email || 'this member'} from ${workspace?.name || 'this workspace'}?`)) return;
    setTeamSaving(member.userId);
    setTeamError('');
    try {
      await teamRequest('remove_member', { targetUserId: member.userId, requestId: mutationId() });
      await loadTeam();
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : 'The member could not be removed.');
    } finally {
      setTeamSaving('');
    }
  };

  const cancelInvitation = async (invitationId: string) => {
    setTeamSaving(invitationId);
    setTeamError('');
    try {
      await teamRequest('cancel_invitation', { invitationId, requestId: mutationId() });
      await loadTeam();
    } catch (cause) {
      setTeamError(cause instanceof Error ? cause.message : 'The invitation could not be cancelled.');
    } finally {
      setTeamSaving('');
    }
  };

  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Settings" title="Build the team around your customers." body="Invite people, assign clear access, and keep every workspace private by default." />
      <section className="settings-panel">
        <div><span><Settings aria-hidden="true" /></span><div><strong>Account</strong><p>{user?.email}</p></div><span className="settings-panel__verified"><Check aria-hidden="true" /> Google verified</span></div>
        <div><span><Network aria-hidden="true" /></span><div><strong>Workspace</strong><p>{workspace?.name || 'My workspace'} · {workspace?.role || 'member'}</p></div><span className="settings-panel__verified"><ShieldCheck aria-hidden="true" /> Private</span></div>
      </section>

      <section className="team-settings" aria-labelledby="team-settings-title">
        <header><div><Users aria-hidden="true" /></div><div><small>Workspace access</small><h2 id="team-settings-title">Team members</h2><p>Everyone signs in with their own Google account. No shared passwords.</p></div><strong>{members.length} {members.length === 1 ? 'member' : 'members'}</strong></header>
        {canAdmin && <div className="team-invite-form">
          <div><UserPlus aria-hidden="true" /><span><strong>Invite someone</strong><small>Access appears automatically when this Google account signs in.</small></span></div>
          <label><span>Google account email</span><input type="email" value={inviteEmail} maxLength={254} onChange={(event) => setInviteEmail(event.currentTarget.value)} placeholder="teammate@company.com" /></label>
          <label><span>Role</span><select value={inviteRole} onChange={(event) => setInviteRole(event.currentTarget.value as typeof inviteRole)}><option value="editor">Editor</option><option value="viewer">Viewer</option>{workspace?.role === 'owner' && <option value="admin">Admin</option>}</select></label>
          <button type="button" disabled={!inviteEmail.trim() || teamSaving === 'invite'} onClick={() => void inviteMember()}>{teamSaving === 'invite' ? 'Saving…' : 'Save invitation'}</button>
        </div>}
        {teamError && <p className="workspace-inline-error" role="alert">{teamError}</p>}
        {teamNotice && <p className="team-settings__notice" role="status"><Check aria-hidden="true" /> {teamNotice}</p>}
        {teamLoading ? <div className="team-settings__loading">Loading team access…</div> : <div className="team-member-list">
          {members.map((member) => {
            const editable = canAdmin && !member.isOwner && member.userId !== user?.uid && !(workspace?.role === 'admin' && member.role === 'admin');
            return <article key={member.userId}>
              {member.photoURL ? <img src={member.photoURL} alt="" referrerPolicy="no-referrer" /> : <span>{(member.displayName || member.email || 'T').charAt(0).toUpperCase()}</span>}
              <div><strong>{member.displayName || 'Team member'}{member.userId === user?.uid ? ' (you)' : ''}</strong><small>{member.email || (member.isOwner ? 'Workspace owner' : 'Google account')}</small></div>
              {editable ? <select aria-label={`Role for ${member.displayName || member.email}`} value={member.role} disabled={teamSaving === member.userId} onChange={(event) => void updateMemberRole(member, event.currentTarget.value as 'admin' | 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option>{workspace?.role === 'owner' && <option value="admin">Admin</option>}</select> : <em>{member.role}</em>}
              {editable ? <button type="button" aria-label={`Remove ${member.displayName || member.email}`} disabled={teamSaving === member.userId} onClick={() => void removeMember(member)}><Trash2 aria-hidden="true" /></button> : <span />}
            </article>;
          })}
        </div>}
        {canAdmin && invitations.length > 0 && <div className="team-invitations"><header><span>Pending invitations</span><small>Expire after 14 days</small></header>{invitations.map((invitation) => <article key={invitation.id}><span><strong>{invitation.email}</strong><small>{invitation.role} · waiting for Google sign-in</small></span><button type="button" disabled={teamSaving === invitation.id} onClick={() => void cancelInvitation(invitation.id)}>{teamSaving === invitation.id ? 'Cancelling…' : 'Cancel'}</button></article>)}</div>}
      </section>
    </div>
  );
}
