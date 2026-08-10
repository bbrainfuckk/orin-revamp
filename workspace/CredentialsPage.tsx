import { Check, KeyRound, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { reauthenticateWithPopup } from 'firebase/auth';
import { collection, onSnapshot, type Timestamp } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { db, googleProvider } from '../services/firebase';
import { ApiAccessPanel } from './ApiAccessPanel';

type Connection = {
  id: string;
  provider: string;
  displayName: string;
  status: string;
  health: string;
  keyHint: string;
  credentialState: string;
  updatedAt?: Timestamp;
};

const labels: Record<string, string> = {
  meta: 'Meta · Facebook & Instagram', whatsapp: 'WhatsApp Business', tiktok: 'TikTok', n8n: 'n8n Cloud',
  paymongo: 'PayMongo', comms_elevenlabs: 'ElevenLabs', website: 'Website chat', shopify: 'Shopify',
  shopee: 'Shopee', lazada: 'Lazada', airbnb: 'Airbnb', ai_openai: 'OpenAI', ai_anthropic: 'Anthropic',
  ai_google: 'Google AI', ai_xai: 'xAI', ai_openrouter: 'OpenRouter', ai_agentrouter: 'AgentRouter',
  ai_qwen: 'Alibaba Cloud · Qwen', ai_groq: 'Groq', ai_cerebras: 'Cerebras', ai_mistral: 'Mistral', ai_deepseek: 'DeepSeek', ai_mimo: 'Xiaomi MiMo',
};

function manageHref(connection: Connection) {
  if (connection.id.startsWith('ai_')) return '/app/agents';
  if (connection.id === 'paymongo') return '/app/commerce';
  if (connection.id.startsWith('comms_')) return '/app/communications';
  return '/app/integrations';
}

export default function CredentialsPage() {
  const { user, workspace } = useAuth();
  const [unlocked, setUnlocked] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isOwner = workspace?.role === 'owner';

  useEffect(() => {
    if (!unlocked || !db || !workspace || !isOwner) {
      setConnections([]);
      return undefined;
    }
    return onSnapshot(collection(db, 'workspaces', workspace.id, 'connections'), (snapshot) => {
      setConnections(snapshot.docs.map((item) => ({
        id: item.id,
        provider: String(item.data().provider || item.id),
        displayName: String(item.data().displayName || ''),
        status: String(item.data().status || 'not connected'),
        health: String(item.data().health || 'not tested'),
        keyHint: String(item.data().keyHint || ''),
        credentialState: String(item.data().credentialState || ''),
        updatedAt: item.data().updatedAt as Timestamp | undefined,
      })).sort((left, right) => (labels[left.id] || left.displayName || left.id).localeCompare(labels[right.id] || right.displayName || right.id)));
    }, () => setError('Credential status could not be loaded.'));
  }, [isOwner, unlocked, workspace]);

  useEffect(() => {
    if (!unlocked) return undefined;
    const timer = window.setTimeout(() => setUnlocked(false), 5 * 60_000);
    return () => window.clearTimeout(timer);
  }, [unlocked]);

  const unlock = async () => {
    if (!user || !isOwner) return;
    setBusy(true);
    setError('');
    try {
      await reauthenticateWithPopup(user, googleProvider);
      setUnlocked(true);
    } catch {
      setError('Google verification was cancelled or could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  if (!isOwner) return <div className="workspace-page"><header className="workspace-page-heading"><div><span>Security</span><h1>Credentials are owner-only.</h1><p>Ask the workspace owner to manage provider and API access.</p></div></header></div>;

  return (
    <div className="workspace-page credentials-page">
      <header className="workspace-page-heading"><div><span>Security</span><h1>Credentials</h1><p>One protected view for connected providers, BYOK models, automation access, and ORIN API keys.</p></div></header>
      {!unlocked ? <section className="credentials-lock">
        <span><LockKeyhole aria-hidden="true" /></span>
        <div><small>Owner verification</small><h2>Confirm it’s you.</h2><p>ORIN uses your Google account again instead of creating a weaker second password.</p></div>
        <button type="button" disabled={busy} onClick={() => void unlock()}><ShieldCheck aria-hidden="true" /> {busy ? 'Verifying…' : 'Verify with Google'}</button>
      </section> : <>
        <section className="credentials-summary"><div><Check aria-hidden="true" /><span><strong>Credential view unlocked</strong><small>Automatically locks after five minutes.</small></span></div><button type="button" onClick={() => setUnlocked(false)}><LockKeyhole aria-hidden="true" /> Lock now</button></section>
        {error && <p className="workspace-inline-error" role="alert">{error}</p>}
        <section className="credentials-vault" aria-labelledby="credentials-vault-title">
          <header><div><KeyRound aria-hidden="true" /></div><div><small>Encrypted provider vault</small><h2 id="credentials-vault-title">Connected accounts</h2><p>Full secrets never return to the browser. Replace or remove them from their owning module.</p></div><strong>{connections.filter((item) => item.status === 'connected').length} connected</strong></header>
          <div className="credentials-list">{connections.length ? connections.map((connection) => <article key={connection.id}>
            <span><KeyRound aria-hidden="true" /></span>
            <div><strong>{labels[connection.id] || connection.displayName || connection.provider}</strong><small>{connection.keyHint || (connection.credentialState === 'stored_server_side' ? 'Stored server-side' : 'OAuth connection')}</small></div>
            <div><em className={connection.health === 'healthy' ? 'is-healthy' : ''}>{connection.status.replaceAll('_', ' ')}</em><small>{connection.updatedAt?.toDate().toLocaleString('en-PH') || 'Connected previously'}</small></div>
            <Link to={manageHref(connection)}>Manage</Link>
          </article>) : <p>No provider credentials are stored in this workspace.</p>}</div>
        </section>
        <ApiAccessPanel />
      </>}
      {unlocked && <button type="button" className="credentials-refresh" onClick={() => setUnlocked(false)}><RefreshCw aria-hidden="true" /> Re-verify account</button>}
    </div>
  );
}
