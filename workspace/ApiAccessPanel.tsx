import { Check, Copy, KeyRound, Plus, Terminal, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

type ApiKeyRecord = {
  id: string;
  name: string;
  hint: string;
  scopes: string[];
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string;
  usageCount: number;
};

const installCommand = 'npm install -g https://www.orin.work/downloads/orin-cli.tgz';

export function ApiAccessPanel() {
  const { user, workspace } = useAuth();
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [name, setName] = useState('Marvin’s ORIN CLI');
  const [mode, setMode] = useState<'read' | 'automation'>('automation');
  const [revealedKey, setRevealedKey] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const isOwner = workspace?.role === 'owner';

  const request = useCallback(async (method: 'GET' | 'POST' | 'DELETE', body?: Record<string, unknown>) => {
    if (!user || !workspace) throw new Error('Sign in again to manage API access.');
    const response = await fetch(`/api/orin/v1/keys?workspaceId=${encodeURIComponent(workspace.id)}`, {
      method,
      headers: {
        Authorization: `Bearer ${await user.getIdToken()}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify({ workspaceId: workspace.id, ...body }) } : {}),
    });
    const payload = await response.json().catch(() => ({})) as { keys?: ApiKeyRecord[]; key?: ApiKeyRecord & { apiKey: string }; error?: string };
    if (!response.ok) throw new Error(payload.error || 'API access could not be updated.');
    return payload;
  }, [user, workspace]);

  const load = useCallback(async () => {
    if (!isOwner) return;
    try {
      const payload = await request('GET');
      setKeys(Array.isArray(payload.keys) ? payload.keys : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'API keys could not be loaded.');
    }
  }, [isOwner, request]);

  useEffect(() => { void load(); }, [load]);

  const copy = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(''), 1_500);
  };

  const create = async () => {
    if (!name.trim()) return;
    setBusy('create');
    setError('');
    setRevealedKey('');
    try {
      const payload = await request('POST', { name: name.trim(), mode });
      setRevealedKey(payload.key?.apiKey || '');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The API key could not be created.');
    } finally {
      setBusy('');
    }
  };

  const revoke = async (key: ApiKeyRecord) => {
    if (!window.confirm(`Revoke ${key.name}? Anything using this key will stop immediately.`)) return;
    setBusy(key.id);
    setError('');
    try {
      await request('DELETE', { keyId: key.id });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The API key could not be revoked.');
    } finally {
      setBusy('');
    }
  };

  if (!isOwner) return null;

  return (
    <section className="api-access" aria-labelledby="api-access-title">
      <header>
        <div><Terminal aria-hidden="true" /></div>
        <div><small>Developer access</small><h2 id="api-access-title">ORIN CLI, API & MCP</h2><p>Operate this workspace from a terminal, Codex, Claude Code, or any MCP client.</p></div>
        <strong>Owner only</strong>
      </header>

      <div className="api-access__setup">
        <div>
          <span>1</span><div><strong>Install the CLI</strong><code>{installCommand}</code></div>
          <button type="button" aria-label="Copy install command" onClick={() => void copy(installCommand, 'install')}>{copied === 'install' ? <Check /> : <Copy />}</button>
        </div>
        <div>
          <span>2</span><div><strong>Connect it</strong><code>orin setup</code></div>
          <button type="button" aria-label="Copy setup command" onClick={() => void copy('orin setup', 'setup')}>{copied === 'setup' ? <Check /> : <Copy />}</button>
        </div>
        <div>
          <span>3</span><div><strong>Add MCP to Codex or Claude</strong><code>orin mcp install codex</code><code>orin mcp install claude</code></div>
        </div>
      </div>

      <div className="api-access__create">
        <label><span>Key name</span><input value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} /></label>
        <label><span>Access</span><select value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)}><option value="automation">Read + publish</option><option value="read">Read only</option></select></label>
        <button type="button" disabled={busy === 'create' || !name.trim()} onClick={() => void create()}><Plus aria-hidden="true" /> {busy === 'create' ? 'Creating…' : 'Create key'}</button>
      </div>

      {revealedKey && <div className="api-access__secret" role="status">
        <KeyRound aria-hidden="true" />
        <div><strong>Copy this key now. It will not be shown again.</strong><code>{revealedKey}</code></div>
        <button type="button" onClick={() => void copy(revealedKey, 'secret')}>{copied === 'secret' ? <Check /> : <Copy />} {copied === 'secret' ? 'Copied' : 'Copy'}</button>
      </div>}
      {error && <p className="workspace-inline-error" role="alert">{error}</p>}

      <div className="api-access__keys">
        {keys.length === 0 ? <p>No API keys yet.</p> : keys.map((key) => <article key={key.id} className={key.revoked ? 'is-revoked' : ''}>
          <KeyRound aria-hidden="true" />
          <div><strong>{key.name}</strong><code>{key.hint}</code><small>{key.scopes.includes('publishing:write') ? 'Read + publish' : 'Read only'} · {(key.usageCount || 0).toLocaleString('en-PH')} API calls · {key.lastUsedAt ? `last used ${new Date(key.lastUsedAt).toLocaleString('en-PH')}` : `created ${key.createdAt ? new Date(key.createdAt).toLocaleDateString() : 'recently'}`}</small></div>
          <em>{key.revoked ? 'Revoked' : 'Active'}</em>
          {!key.revoked && <button type="button" aria-label={`Revoke ${key.name}`} disabled={busy === key.id} onClick={() => void revoke(key)}><Trash2 aria-hidden="true" /></button>}
        </article>)}
      </div>
    </section>
  );
}
