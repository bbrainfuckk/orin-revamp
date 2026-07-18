import {
  ArrowUpRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Code2,
  Download,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

type DocMode = 'simple' | 'advanced';
type DocSection = {
  id: string;
  category: string;
  title: string;
  summary: string;
  mode: DocMode | 'both';
  bullets: string[];
  links?: Array<{ label: string; href: string }>;
};

const sections: DocSection[] = [
  {
    id: 'launch',
    category: 'Start here',
    title: 'Launch an ORIN AI',
    summary: 'Create the agent, approve its knowledge and tone, connect a channel, then test one real conversation.',
    mode: 'simple',
    bullets: [
      'Create an AI agent and complete all six setup decisions.',
      'Add instructions, files, or approved website sources to its knowledge.',
      'Connect Facebook, Instagram, WhatsApp, website chat, or another available channel.',
      'Send a real test inquiry and confirm the reply, escalation, and analytics event.',
    ],
    links: [{ label: 'Open AI studio', href: '/app/agents/new' }, { label: 'Connect channels', href: '/app/integrations' }],
  },
  {
    id: 'inbox',
    category: 'Customer operations',
    title: 'Unified inbox and CRM',
    summary: 'One customer record, conversation timeline, ownership, priority, tags, notes, response metrics, and human handoff.',
    mode: 'simple',
    bullets: [
      'ORIN AI answers only when the assigned agent and channel are production-ready.',
      'An escalation alerts the team and can show the customer a Messenger handoff action.',
      'A team reply pauses ORIN AI for that conversation until a teammate explicitly resumes it.',
      'Profile details come only from provider-permitted fields. ORIN AI never guesses a customer’s age.',
    ],
    links: [{ label: 'Open inbox', href: '/app/inbox' }, { label: 'Open contacts', href: '/app/contacts' }],
  },
  {
    id: 'publishing',
    category: 'Growth',
    title: 'Publishing and autoposter',
    summary: 'Compose once, tailor by channel, attach media, publish now, schedule once, or run a bounded recurring campaign.',
    mode: 'simple',
    bullets: [
      'Every provider must be connected and healthy before it can be selected.',
      'Scheduled posts stay visible in the pending queue and can be cancelled before dispatch.',
      'Every provider result is recorded separately; partial delivery is never presented as full success.',
      'Direct delivery is live only for adapters that have passed provider approval and delivery tests.',
    ],
    links: [{ label: 'Create a campaign', href: '/app/publishing' }],
  },
  {
    id: 'automations',
    category: 'Operations',
    title: 'Automations and n8n',
    summary: 'Use ORIN’s guided automations for routine work, or connect n8n Cloud for advanced orchestration.',
    mode: 'both',
    bullets: [
      'Simple mode keeps triggers, delays, follow-ups, assignments, tags, and verified webhooks inside ORIN AI.',
      'Advanced mode can import and sync n8n workflows without embedding or impersonating the n8n editor.',
      'BYOK credentials stay encrypted in the connector vault and are never returned to the browser.',
      'Signed outcome events can report completed bookings, orders, and workflow results back to ORIN AI.',
    ],
    links: [{ label: 'Open automations', href: '/app/automations' }, { label: 'Connect n8n', href: '/app/integrations?provider=n8n' }],
  },
  {
    id: 'commerce',
    category: 'Revenue',
    title: 'Messenger commerce and payments',
    summary: 'Show catalog cards, collect variants and quantities, create quotations, and verify supported payment outcomes.',
    mode: 'simple',
    bullets: [
      'Catalog cards and postback actions are deterministic—prices and quantities are not invented by a model.',
      'Native GCash transfer can create a pending order for manual verification.',
      'PayMongo QRPh checkout uses webhooks for automatic paid-state verification.',
      'Orders, customer context, and payment evidence remain attached to the CRM conversation.',
    ],
    links: [{ label: 'Manage commerce', href: '/app/commerce' }],
  },
  {
    id: 'api',
    category: 'Developers',
    title: 'ORIN CLI, MCP and API',
    summary: 'Operate a live ORIN AI workspace from a terminal, Codex, Claude Code, or another MCP client.',
    mode: 'advanced',
    bullets: [
      'Create an owner-only API key in Settings. The raw key is shown once, revocable, scoped, rate-limited, and usage-metered.',
      'Install the CLI, run orin setup, then inspect inbox, analytics, campaigns, agents, and connection health without navigating the UI.',
      'Run orin mcp install codex or orin mcp install claude to register the local stdio MCP server.',
      'Publishing still uses a unique request ID and reports provider-confirmed delivery rather than pretending that a queued post is delivered.',
    ],
    links: [
      { label: 'Download ORIN CLI', href: '/downloads/orin-cli.tgz' },
      { label: 'OpenAPI contract', href: '/orin-openapi.json' },
      { label: 'Download frontier-model skill', href: '/downloads/orin-ai-skill.zip' },
    ],
  },
  {
    id: 'interop',
    category: 'Developers',
    title: 'HighLevel and QuickBooks interoperability',
    summary: 'Keep ORIN AI as the customer layer while approved systems remain the source of truth for their own records.',
    mode: 'advanced',
    bullets: [
      'HighLevel: use OAuth for multi-account/public installations; private tokens are appropriate only for controlled single-subaccount setups.',
      'Sync contacts, conversations, opportunities, appointments, and signed webhook outcomes through n8n or a verified webhook recipe.',
      'QuickBooks Online requires Intuit OAuth, a company realm ID, renewable tokens, and verified webhooks—there is no safe paste-one-key shortcut.',
      'Sync customers, items, invoices, payments, and order references only after the ORIN Intuit app is approved and configured.',
    ],
    links: [
      { label: 'HighLevel API', href: 'https://marketplace.gohighlevel.com/docs/' },
      { label: 'QuickBooks OAuth', href: 'https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0' },
    ],
  },
  {
    id: 'security',
    category: 'Trust',
    title: 'Security and production truth',
    summary: 'Connections stay disabled until credentials, provider approval, subscription, and a real delivery test all pass.',
    mode: 'both',
    bullets: [
      'OAuth and provider tokens are encrypted server-side; readable workspace records contain health metadata only.',
      'Webhook signatures, replay protection, rate limits, role checks, and idempotency are enforced before mutation.',
      'A generated answer is never counted as delivered until the provider confirms it.',
      'Age and other sensitive attributes are not inferred from messages or profile photos.',
    ],
    links: [{ label: 'Review integrations', href: '/app/integrations' }, { label: 'Workspace settings', href: '/app/settings' }],
  },
];

const categories = ['All', ...Array.from(new Set(sections.map((section) => section.category)))];

export function DocumentationPage() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [mode, setMode] = useState<DocMode>('simple');
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return sections.filter((section) => (
      (category === 'All' || section.category === category)
      && (section.mode === 'both' || section.mode === mode)
      && (!needle || [section.title, section.summary, section.category, ...section.bullets].join(' ').toLocaleLowerCase().includes(needle))
    ));
  }, [category, mode, query]);

  return (
    <section className="workspace-page docs-page">
      <header className="workspace-page-heading">
        <div><span>Documentation</span><h1>Build with ORIN AI.</h1><p>Guided operations for teams. Exact contracts and integration truth for developers.</p></div>
        <a className="workspace-secondary-action" href="/downloads/orin-ai-skill.zip" download><Download aria-hidden="true" /> Frontier-model skill</a>
      </header>

      <section className="docs-hero">
        <div><Sparkles aria-hidden="true" /><span>Choose your depth</span><h2>{mode === 'simple' ? 'The shortest path to a working customer journey.' : 'Architecture, API contracts, webhooks, and interoperability.'}</h2></div>
        <div className="docs-mode" role="group" aria-label="Documentation depth">
          <button type="button" className={mode === 'simple' ? 'is-active' : ''} onClick={() => setMode('simple')}><Bot aria-hidden="true" /><span><strong>Simple</strong><small>Operate ORIN AI</small></span></button>
          <button type="button" className={mode === 'advanced' ? 'is-active' : ''} onClick={() => setMode('advanced')}><Code2 aria-hidden="true" /><span><strong>Advanced</strong><small>Integrate ORIN AI</small></span></button>
        </div>
      </section>

      <div className="docs-toolbar">
        <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="Search documentation" aria-label="Search documentation" /></label>
        <nav aria-label="Documentation categories">{categories.map((item) => <button type="button" key={item} className={category === item ? 'is-active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</nav>
      </div>

      <div className="docs-layout">
        <aside>
          <BookOpen aria-hidden="true" />
          <strong>ORIN AI platform</strong>
          <span>Customer conversations</span>
          <span>CRM and human handoff</span>
          <span>Publishing and commerce</span>
          <span>Automations and analytics</span>
          <span>API and provider adapters</span>
          <div><ShieldCheck aria-hidden="true" /><small>Unavailable provider capabilities stay visibly locked until production approval and testing are complete.</small></div>
        </aside>
        <main>
          {visible.length ? visible.map((section) => (
            <article key={section.id} id={`docs-${section.id}`} className="docs-card">
              <header><div><span>{section.category}</span><h2>{section.title}</h2></div>{section.mode !== 'both' && <em>{section.mode}</em>}</header>
              <p>{section.summary}</p>
              <ul>{section.bullets.map((bullet) => <li key={bullet}><CheckCircle2 aria-hidden="true" />{bullet}</li>)}</ul>
              {section.links?.length ? <footer>{section.links.map((link) => link.href.startsWith('/app')
                ? <Link key={link.href} to={link.href}>{link.label}<ArrowUpRight aria-hidden="true" /></Link>
                : <a key={link.href} href={link.href} target={link.href.startsWith('http') ? '_blank' : undefined} rel={link.href.startsWith('http') ? 'noreferrer' : undefined}>{link.label}<ArrowUpRight aria-hidden="true" /></a>)}</footer> : null}
            </article>
          )) : <section className="docs-empty"><Network aria-hidden="true" /><strong>No matching documentation</strong><p>Try a broader search or switch documentation depth.</p></section>}
        </main>
      </div>
    </section>
  );
}
