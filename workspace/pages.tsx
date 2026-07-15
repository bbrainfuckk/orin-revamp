import {
  ArrowRight,
  Bot,
  ChartNoAxesCombined,
  Check,
  Circle,
  ContactRound,
  Inbox,
  Network,
  Plus,
  Settings,
  Workflow,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

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
  const { user } = useAuth();
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
          ['Conversations', '—', 'Waiting for a connected channel'],
          ['Resolved by ORIN AI', '—', 'No live conversations yet'],
          ['Escalated to your team', '—', 'No live conversations yet'],
          ['Median first response', '—', 'Measured after launch'],
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

export function InboxPage() {
  return <div className="workspace-page"><PageHeading eyebrow="Inbox" title="Every conversation, in one place." body="Messages will arrive here after a channel is connected and verified." /><EmptySurface icon={Inbox} title="The inbox is ready for a connection" body="Connect a customer channel, then test a conversation before going live." action={<Link className="workspace-secondary-action" to="/app/integrations">View integrations</Link>} /></div>;
}

export function ContactsPage() {
  return <div className="workspace-page"><PageHeading eyebrow="Contacts" title="A continuous customer record." body="Profiles, conversation history, tags, and approved notes stay with the customer." /><EmptySurface icon={ContactRound} title="Contacts appear with real conversations" body="ORIN AI does not create sample customers or pretend activity is live." /></div>;
}

export function AutomationsPage() {
  return <div className="workspace-page"><PageHeading eyebrow="Automations" title="Turn a conversation into the next action." body="Route leads, notify teams, update systems, or call an n8n workflow after a verified event." /><EmptySurface icon={Workflow} title="No automations yet" body="Create an AI and connect a destination before defining an automation." /></div>;
}

const integrations = [
  ['Meta', 'Facebook Pages, Messenger, and Instagram', 'Available to configure'],
  ['TikTok', 'Customer and commerce conversations', 'Available to configure'],
  ['Airbnb', 'Guest questions and stay information', 'Access review required'],
  ['Commerce', 'Shopee, Lazada, and Shopify', 'Available to configure'],
  ['Website', 'ORIN AI chat for your own site', 'Available to configure'],
  ['n8n', 'Webhooks and workflow orchestration', 'Available to configure'],
];

export function IntegrationsPage() {
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Integrations" title="Meet customers where they already are." body="A channel only shows as connected after authorization and a successful health check." />
      <section className="integration-list">
        {integrations.map(([name, body, status]) => (
          <article key={name}>
            <span className="integration-list__icon"><Network aria-hidden="true" /></span>
            <div><strong>{name}</strong><p>{body}</p></div>
            <span className="integration-list__status">{status}</span>
            <button type="button" disabled title="Connector authorization is being prepared">Set up</button>
          </article>
        ))}
      </section>
    </div>
  );
}

export function AnalyticsPage() {
  return (
    <div className="workspace-page">
      <PageHeading eyebrow="Analytics" title="Know what ORIN AI is changing." body="Results are calculated from real workspace events; estimates stay clearly labelled." />
      <section className="analytics-empty">
        <div><ChartNoAxesCombined aria-hidden="true" /><h2>Analytics begin with the first conversation.</h2><p>Connect a channel and publish an AI to measure response time, resolution, escalation, and attributed outcomes.</p></div>
        <dl>
          <div><dt>Conversations</dt><dd>—</dd></div>
          <div><dt>Resolution rate</dt><dd>—</dd></div>
          <div><dt>Leads captured</dt><dd>—</dd></div>
          <div><dt>Attributed value</dt><dd>—</dd></div>
        </dl>
      </section>
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
