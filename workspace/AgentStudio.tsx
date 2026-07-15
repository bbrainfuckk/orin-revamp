import { ArrowLeft, Check, ChevronRight, MessageSquareText, RotateCcw, Save, Send, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { useAuth } from '../contexts/AuthContext';
import { db } from '../services/firebase';

type StudioDraft = {
  name: string;
  businessName: string;
  purpose: string;
  outcome: string;
  channels: string[];
  knowledge: string[];
  knowledgeNotes: string;
  capabilities: string[];
  tone: string;
  languages: string[];
  voiceNotes: string;
  escalation: string[];
  operatingRules: string;
};

type StudioTestMessage = {
  id: string;
  role: 'customer' | 'agent';
  body: string;
  handoff?: boolean;
  reason?: string;
};

type StudioTestResponse = {
  ok?: boolean;
  reply?: string;
  handoff?: boolean;
  reason?: string;
  error?: string;
};

const studioKey = 'orin-workspace-agent-draft-v1';
const pendingAgentIdKey = 'orin-workspace-pending-agent-id-v1';
const publicBriefKey = 'orin-ai-builder-draft-v2';

const steps = ['Purpose', 'Channels', 'Knowledge', 'Capabilities', 'Voice', 'Rules', 'Review'];
const channelOptions = ['Messenger', 'Facebook', 'Instagram', 'WhatsApp', 'TikTok', 'Airbnb', 'Shopee', 'Lazada', 'Shopify', 'Website'];
const knowledgeOptions = ['Website and FAQ pages', 'Products, services, and pricing', 'Catalogs or menus', 'Booking or property guides', 'Policies and procedures', 'Approved documents and answers'];
const capabilityOptions = ['Answer customer questions', 'Recommend products or services', 'Take orders or bookings', 'Share status updates', 'Qualify new inquiries', 'Support customers after hours'];
const toneOptions = ['Warm & conversational', 'Professional & composed', 'Concise & practical', 'Premium & attentive', 'Match our brand voice'];
const languageOptions = ['English', 'Filipino / Tagalog', 'Taglish', 'Cebuano', 'Another language'];
const escalationOptions = ['Customer asks for a team member', 'Answer cannot be verified', 'Complaint, refund, or urgent issue', 'Purchase or booking exceeds a limit', 'Payment or identity review is required', 'A custom rule is triggered'];

const initialDraft = (): StudioDraft => ({
  name: 'My ORIN AI',
  businessName: '',
  purpose: '',
  outcome: '',
  channels: [],
  knowledge: [],
  knowledgeNotes: '',
  capabilities: [],
  tone: '',
  languages: [],
  voiceNotes: '',
  escalation: [],
  operatingRules: '',
});

function readStudioDraft() {
  if (typeof window === 'undefined') return initialDraft();
  try {
    const value = JSON.parse(window.localStorage.getItem(studioKey) || 'null') as Partial<StudioDraft> | null;
    return value ? { ...initialDraft(), ...value } : initialDraft();
  } catch {
    return initialDraft();
  }
}

function initialCloudDraftMarker(routeAgentId?: string) {
  if (routeAgentId) return '';
  if (typeof window !== 'undefined' && window.localStorage.getItem(studioKey)) return '';
  return JSON.stringify(readStudioDraft());
}

function readPendingAgentIdentity() {
  if (typeof window === 'undefined') return { id: 'new-agent', isNew: true };
  const existing = window.localStorage.getItem(pendingAgentIdKey);
  if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) return { id: existing, isNew: true };
  const id = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  window.localStorage.setItem(pendingAgentIdKey, id);
  return { id, isNew: true };
}

function testMessageId(prefix: string) {
  return typeof crypto.randomUUID === 'function'
    ? `${prefix}_${crypto.randomUUID()}`
    : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeStoredDraft(value: unknown, documentData: Record<string, unknown>) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (key: keyof StudioDraft, fallback = '') => typeof source[key] === 'string' ? source[key] as string : fallback;
  return {
    ...initialDraft(),
    name: text('name', typeof documentData.name === 'string' ? documentData.name : 'My ORIN AI'),
    businessName: text('businessName', typeof documentData.businessName === 'string' ? documentData.businessName : ''),
    purpose: text('purpose', typeof documentData.purpose === 'string' ? documentData.purpose : ''),
    outcome: text('outcome'),
    channels: stringArray(source.channels),
    knowledge: stringArray(source.knowledge),
    knowledgeNotes: text('knowledgeNotes'),
    capabilities: stringArray(source.capabilities),
    tone: text('tone'),
    languages: stringArray(source.languages),
    voiceNotes: text('voiceNotes'),
    escalation: stringArray(source.escalation),
    operatingRules: text('operatingRules'),
  } satisfies StudioDraft;
}

function draftReadiness(draft: StudioDraft) {
  return [
    Boolean(draft.name.trim() && draft.businessName.trim() && draft.purpose.trim()),
    draft.channels.length > 0,
    draft.knowledge.length > 0,
    draft.capabilities.length > 0,
    Boolean(draft.tone && draft.languages.length),
    draft.escalation.length > 0,
  ].filter(Boolean).length;
}

function readPublicBrief(): StudioDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(publicBriefKey) || 'null') as { draft?: Record<string, unknown> } | null;
    const source = saved?.draft;
    if (!source) return null;
    return {
      ...initialDraft(),
      businessName: typeof source.businessName === 'string' ? source.businessName : '',
      purpose: typeof source.useCase === 'string' ? source.useCase : '',
      outcome: typeof source.roleNotes === 'string' ? source.roleNotes : '',
      channels: Array.isArray(source.channels) ? source.channels.filter((item): item is string => typeof item === 'string') : [],
      knowledge: Array.isArray(source.knowledgeSources) ? source.knowledgeSources.filter((item): item is string => typeof item === 'string') : [],
      knowledgeNotes: typeof source.knowledgeNotes === 'string' ? source.knowledgeNotes : '',
      capabilities: Array.isArray(source.responsibilities) ? source.responsibilities.filter((item): item is string => typeof item === 'string') : [],
      tone: typeof source.tone === 'string' ? source.tone : '',
      languages: Array.isArray(source.languages) ? source.languages.filter((item): item is string => typeof item === 'string') : [],
      voiceNotes: typeof source.toneNotes === 'string' ? source.toneNotes : '',
      escalation: Array.isArray(source.handoffRules) ? source.handoffRules.filter((item): item is string => typeof item === 'string') : [],
      operatingRules: typeof source.operatingRules === 'string' ? source.operatingRules : '',
    };
  } catch {
    return null;
  }
}

function FieldOptions({ options, values, onToggle }: { options: string[]; values: string[]; onToggle: (value: string) => void }) {
  return (
    <div className="studio-options">
      {options.map((option) => (
        <button key={option} type="button" className={values.includes(option) ? 'is-selected' : ''} aria-pressed={values.includes(option)} onClick={() => onToggle(option)}>
          <span>{option}</span>{values.includes(option) && <Check aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

export function AgentStudio() {
  const { user, workspace } = useAuth();
  const navigate = useNavigate();
  const { agentId: routeAgentId } = useParams();
  const [initialIdentity] = useState(() => routeAgentId
    ? { id: routeAgentId, isNew: false }
    : readPendingAgentIdentity());
  const agentId = routeAgentId || initialIdentity.id;
  const [draft, setDraft] = useState<StudioDraft>(() => routeAgentId ? initialDraft() : readStudioDraft());
  const [step, setStep] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState('');
  const [savingToCloud, setSavingToCloud] = useState(false);
  const [publicBrief, setPublicBrief] = useState<StudioDraft | null>(() => routeAgentId ? null : readPublicBrief());
  const [cloudReady, setCloudReady] = useState(!routeAgentId);
  const [loadingAgent, setLoadingAgent] = useState(Boolean(routeAgentId));
  const [loadError, setLoadError] = useState('');
  const [testMessages, setTestMessages] = useState<StudioTestMessage[]>([]);
  const [testInput, setTestInput] = useState('');
  const [testingReply, setTestingReply] = useState(false);
  const [testError, setTestError] = useState('');
  const firstCloudSave = useRef(initialIdentity.isNew);
  const lastCloudDraft = useRef(initialCloudDraftMarker(routeAgentId));

  useEffect(() => {
    if (!routeAgentId) return;
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(routeAgentId)) {
      setLoadError('This AI link is invalid.');
      setLoadingAgent(false);
      setCloudReady(false);
      return;
    }
    if (!db || !workspace) return;
    let active = true;
    setLoadingAgent(true);
    setCloudReady(false);
    setLoadError('');
    getDoc(doc(db, 'workspaces', workspace.id, 'agents', routeAgentId))
      .then((snapshot) => {
        if (!active) return;
        if (!snapshot.exists()) {
          setLoadError('This ORIN AI could not be found in your workspace.');
          return;
        }
        const nextDraft = normalizeStoredDraft(snapshot.data().config, snapshot.data());
        setDraft(nextDraft);
        lastCloudDraft.current = JSON.stringify(nextDraft);
        firstCloudSave.current = false;
        setPublicBrief(null);
        setCloudReady(true);
        setSavedAt(Date.now());
      })
      .catch((cause) => {
        if (active) setLoadError(cause instanceof Error ? cause.message : 'This ORIN AI could not be opened.');
      })
      .finally(() => {
        if (active) setLoadingAgent(false);
      });
    return () => { active = false; };
  }, [routeAgentId, workspace]);

  useEffect(() => {
    if (!cloudReady || loadError) return undefined;
    const serializedDraft = JSON.stringify(draft);
    window.localStorage.setItem(routeAgentId ? `${studioKey}:${routeAgentId}` : studioKey, serializedDraft);
    if (serializedDraft === lastCloudDraft.current) return undefined;
    const timer = window.setTimeout(() => {
      if (!db || !workspace || !user) {
        setSavedAt(Date.now());
        return;
      }

      setSavingToCloud(true);
      setSaveError('');
      setDoc(doc(db, 'workspaces', workspace.id, 'agents', agentId), {
        name: draft.name.trim() || 'Untitled ORIN AI',
        businessName: draft.businessName.trim(),
        purpose: draft.purpose.trim(),
        readiness: draftReadiness(draft),
        config: draft,
        createdBy: user.uid,
        updatedAt: serverTimestamp(),
        ...(firstCloudSave.current ? { status: 'draft', createdAt: serverTimestamp() } : {}),
      }, { merge: true })
        .then(() => {
          lastCloudDraft.current = serializedDraft;
          firstCloudSave.current = false;
          setSavedAt(Date.now());
          if (!routeAgentId) {
            window.localStorage.removeItem(pendingAgentIdKey);
            window.localStorage.removeItem(studioKey);
            navigate(`/app/agents/${encodeURIComponent(agentId)}`, { replace: true });
          }
        })
        .catch((cause) => {
          setSaveError(cause instanceof Error ? cause.message : 'Cloud save could not be completed.');
        })
        .finally(() => setSavingToCloud(false));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [agentId, cloudReady, draft, loadError, navigate, routeAgentId, user, workspace]);

  const update = <Key extends keyof StudioDraft>(key: Key, value: StudioDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const toggle = (key: 'channels' | 'knowledge' | 'capabilities' | 'languages' | 'escalation', value: string) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value],
    }));
  };

  const complete = [
    Boolean(draft.name.trim() && draft.businessName.trim() && draft.purpose.trim()),
    draft.channels.length > 0,
    draft.knowledge.length > 0,
    draft.capabilities.length > 0,
    Boolean(draft.tone && draft.languages.length),
    draft.escalation.length > 0,
    true,
  ];

  const readiness = useMemo(() => draftReadiness(draft), [draft]);
  const savedLabel = savedAt
    ? `Saved to workspace at ${new Intl.DateTimeFormat('en-PH', { hour: 'numeric', minute: '2-digit' }).format(savedAt)}`
    : savingToCloud ? 'Saving to workspace…' : 'Saving draft…';
  const draftSynced = cloudReady && lastCloudDraft.current === JSON.stringify(draft);

  const testAgent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = testInput.trim();
    if (!message || !user || !workspace || !routeAgentId || !draftSynced || savingToCloud || saveError) return;
    const history = testMessages.slice(-8).map((item) => ({
      role: item.role === 'agent' ? 'assistant' : 'user',
      content: item.body,
    }));
    setTestMessages((current) => [...current, { id: testMessageId('customer'), role: 'customer', body: message }]);
    setTestInput('');
    setTestError('');
    setTestingReply(true);
    try {
      const response = await fetch('/api/widget/message', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await user.getIdToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'studio_test',
          workspaceId: workspace.id,
          agentId: routeAgentId,
          message,
          history,
        }),
      });
      const result = await response.json().catch(() => ({})) as StudioTestResponse;
      if (!response.ok || !result.reply) throw new Error(result.error || 'The test response could not be completed.');
      setTestMessages((current) => [...current, {
        id: testMessageId('agent'),
        role: 'agent',
        body: result.reply!,
        handoff: result.handoff,
        reason: result.reason,
      }]);
    } catch (cause) {
      setTestError(cause instanceof Error ? cause.message : 'The test response could not be completed.');
    } finally {
      setTestingReply(false);
    }
  };

  const renderStep = () => {
    if (step === 0) return (
      <>
        <div className="studio-question"><span>01</span><div><h2>What should this AI become?</h2><p>Give it one clear purpose. More responsibilities can be added after the foundation is working.</p></div></div>
        <div className="studio-form-grid">
          <label><span>AI name</span><input value={draft.name} onChange={(event) => update('name', event.currentTarget.value)} placeholder="My ORIN AI" /></label>
          <label><span>Business name</span><input value={draft.businessName} onChange={(event) => update('businessName', event.currentTarget.value)} placeholder="Your business" /></label>
        </div>
        <label className="studio-field"><span>Primary role</span><input value={draft.purpose} onChange={(event) => update('purpose', event.currentTarget.value)} placeholder="Example: Sales and customer service for our online shop" /></label>
        <label className="studio-field"><span>What should improve? <small>Optional</small></span><textarea value={draft.outcome} onChange={(event) => update('outcome', event.currentTarget.value)} placeholder="Example: Answer product questions quickly and turn qualified inquiries into completed orders." rows={4} /></label>
      </>
    );

    if (step === 1) return <><div className="studio-question"><span>02</span><div><h2>Where will customers meet it?</h2><p>Select the channels you want to prepare. Authorization happens separately.</p></div></div><FieldOptions options={channelOptions} values={draft.channels} onToggle={(value) => toggle('channels', value)} /></>;

    if (step === 2) return <><div className="studio-question"><span>03</span><div><h2>What is it allowed to learn from?</h2><p>Answers should trace back to approved business sources.</p></div></div><FieldOptions options={knowledgeOptions} values={draft.knowledge} onToggle={(value) => toggle('knowledge', value)} /><label className="studio-field studio-field--spaced"><span>Knowledge notes <small>Optional</small></span><textarea value={draft.knowledgeNotes} onChange={(event) => update('knowledgeNotes', event.currentTarget.value)} placeholder="Add source URLs, document names, catalog notes, or ownership details." rows={5} /></label></>;

    if (step === 3) return <><div className="studio-question"><span>04</span><div><h2>What work should it own?</h2><p>Start with the recurring work your team can define and review.</p></div></div><FieldOptions options={capabilityOptions} values={draft.capabilities} onToggle={(value) => toggle('capabilities', value)} /></>;

    if (step === 4) return <><div className="studio-question"><span>05</span><div><h2>How should it sound?</h2><p>The voice must feel recognizably yours across every connected channel.</p></div></div><div className="studio-tone-grid">{toneOptions.map((tone) => <button key={tone} type="button" className={draft.tone === tone ? 'is-selected' : ''} onClick={() => update('tone', tone)}><span>{tone}</span>{draft.tone === tone && <Check aria-hidden="true" />}</button>)}</div><div className="studio-section-label">Languages</div><FieldOptions options={languageOptions} values={draft.languages} onToggle={(value) => toggle('languages', value)} /><label className="studio-field studio-field--spaced"><span>Voice instructions <small>Optional</small></span><textarea value={draft.voiceNotes} onChange={(event) => update('voiceNotes', event.currentTarget.value)} placeholder="Example: Calm, direct, and helpful. Use short Taglish replies. Never use slang or pressure the customer." rows={4} /></label></>;

    if (step === 5) return <><div className="studio-question"><span>06</span><div><h2>Where does its authority end?</h2><p>Define the decisions that stay with your team and the rules every answer must follow.</p></div></div><FieldOptions options={escalationOptions} values={draft.escalation} onToggle={(value) => toggle('escalation', value)} /><label className="studio-field studio-field--spaced"><span>Operating rules <small>Optional</small></span><textarea value={draft.operatingRules} onChange={(event) => update('operatingRules', event.currentTarget.value)} placeholder="Example: Never invent stock. Never approve a refund. Verify the order number before sharing an update." rows={5} /></label></>;

    return (
      <div className="studio-review">
        <div className="studio-question"><span>07</span><div><h2>Review the foundation.</h2><p>Saving keeps the draft editable. Publishing comes after knowledge and connection tests pass.</p></div></div>
        <dl>
          <div><dt>Purpose</dt><dd>{draft.purpose || 'Not defined'}</dd><button type="button" onClick={() => setStep(0)}>Edit</button></div>
          <div><dt>Channels</dt><dd>{draft.channels.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(1)}>Edit</button></div>
          <div><dt>Knowledge</dt><dd>{draft.knowledge.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(2)}>Edit</button></div>
          <div><dt>Capabilities</dt><dd>{draft.capabilities.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(3)}>Edit</button></div>
          <div><dt>Voice</dt><dd>{[draft.tone, ...draft.languages].filter(Boolean).join(' · ') || 'Not defined'}</dd><button type="button" onClick={() => setStep(4)}>Edit</button></div>
          <div><dt>Escalation</dt><dd>{draft.escalation.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(5)}>Edit</button></div>
        </dl>
        <div className="studio-review__notice"><Save aria-hidden="true" /><div><strong>Saved as a private draft.</strong><p>You can close this page and continue from the same ORIN AI workspace. Nothing reaches customers until you review and publish it.</p></div></div>
      </div>
    );
  };

  if (loadingAgent) return <div className="agent-studio__state" aria-live="polite">Opening this ORIN AI…</div>;
  if (loadError) return <div className="agent-studio__state agent-studio__state--error" role="alert"><strong>We couldn't open this ORIN AI.</strong><span>{loadError}</span><Link to="/app/agents"><ArrowLeft aria-hidden="true" /> Return to AI agents</Link></div>;

  return (
    <div className="agent-studio">
      <header className="agent-studio__header">
        <div><Link to="/app/agents"><ArrowLeft aria-hidden="true" /> AI agents</Link><span>{routeAgentId ? draft.name || 'Edit AI' : 'New AI'}</span></div>
        <div className={`agent-studio__save${saveError ? ' is-error' : ''}`} title={saveError || undefined}><Save aria-hidden="true" /><span>{saveError ? 'Saved on this device · cloud retrying' : savedLabel}</span></div>
      </header>

      {publicBrief && (
        <aside className="studio-import">
          <Sparkles aria-hidden="true" />
          <div><strong>Continue the brief you started on orin.work</strong><p>Bring its purpose, channels, knowledge, voice, and rules into this workspace draft.</p></div>
          <button type="button" onClick={() => { setDraft(publicBrief); setPublicBrief(null); setStep(0); }}>Import brief</button>
          <button type="button" className="is-dismiss" onClick={() => setPublicBrief(null)}>Not now</button>
        </aside>
      )}

      <div className="agent-studio__layout">
        <aside className="studio-rail">
          <div className="studio-readiness"><span>Draft readiness</span><strong>{readiness}/6 decisions</strong><i><b style={{ width: `${(readiness / 6) * 100}%` }} /></i></div>
          <ol>{steps.map((label, index) => <li key={label}><button type="button" className={step === index ? 'is-current' : complete[index] ? 'is-complete' : ''} onClick={() => setStep(index)}><span>{complete[index] ? <Check aria-hidden="true" /> : index + 1}</span>{label}</button></li>)}</ol>
        </aside>

        <section className="studio-canvas">
          <div className="studio-canvas__body">{renderStep()}</div>
          <footer>
            <button type="button" className="studio-back" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>Back</button>
            {step < steps.length - 1 ? <button type="button" className="studio-next" disabled={!complete[step]} onClick={() => setStep((current) => Math.min(steps.length - 1, current + 1))}>Continue <ChevronRight aria-hidden="true" /></button> : <Link className="studio-next" to="/app/agents">Keep as draft <ChevronRight aria-hidden="true" /></Link>}
          </footer>
        </section>

        <aside className="studio-preview">
          <div className="studio-preview__heading">
            <MessageSquareText aria-hidden="true" />
            <div><span>Private test</span><strong>{draft.name || 'My ORIN AI'}</strong></div>
            {testMessages.length > 0 && <button type="button" className="studio-preview__reset" onClick={() => { setTestMessages([]); setTestError(''); }}><RotateCcw aria-hidden="true" /> Reset</button>}
          </div>
          <div className="studio-preview__conversation" aria-live="polite">
            {testMessages.length === 0 && <p className="is-empty">Ask a real customer question. The answer uses the latest saved knowledge, voice, languages, and handoff rules.</p>}
            {testMessages.map((message) => (
              <div key={message.id} className={`studio-test-message is-${message.role}`}>
                <p>{message.body}</p>
                {message.handoff && <span>Team handoff{message.reason ? ` · ${message.reason}` : ''}</span>}
              </div>
            ))}
            {testingReply && <p className="is-thinking">ORIN AI is checking the approved information…</p>}
          </div>
          <form className="studio-preview__composer" onSubmit={testAgent}>
            <input aria-label="Test customer message" value={testInput} onChange={(event) => setTestInput(event.currentTarget.value)} placeholder="Ask as a customer…" maxLength={1200} />
            <button type="submit" aria-label="Send test message" disabled={!testInput.trim() || !routeAgentId || !draftSynced || savingToCloud || Boolean(saveError) || testingReply}><Send aria-hidden="true" /></button>
          </form>
          <p className={`studio-preview__test-status${testError ? ' is-error' : ''}`} role={testError ? 'alert' : undefined}>{testError || (!routeAgentId ? 'Save one change to create this draft before testing.' : !draftSynced || savingToCloud ? 'Saving your latest changes before testing…' : 'Private test only · nothing is sent to customers or analytics.')}</p>
          <div className="studio-preview__facts">
            <div><span>Voice</span><strong>{draft.tone || 'Not set'}</strong></div>
            <div><span>Languages</span><strong>{draft.languages.join(', ') || 'Not set'}</strong></div>
            <div><span>Knowledge</span><strong>{draft.knowledge.length ? `${draft.knowledge.length} source types` : 'Not set'}</strong></div>
          </div>
        </aside>
      </div>
    </div>
  );
}
