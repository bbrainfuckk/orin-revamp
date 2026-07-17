import { ArrowLeft, BrainCircuit, Check, ChevronRight, Clock3, KeyRound, MessageSquareText, RotateCcw, Save, Send, ShieldCheck, Sparkles, Unplug } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
  aiMode: 'orin_auto' | 'managed' | 'byok';
  aiProvider: string;
  aiModel: string;
  aiFallbackModels: string[];
  aiAllowManagedFallback: boolean;
  aiTemperature: number;
  aiMaxOutputTokens: number;
  aiDailyTokenLimit: number;
  followUpEnabled: boolean;
  followUpDelayAmount: number;
  followUpDelayUnit: 'minutes' | 'hours' | 'days';
  followUpMessage: string;
  followUpCancelOnReply: boolean;
  followUpQuietHours: boolean;
  followUpMaxMessages: number;
  escalation: string[];
  operatingRules: string;
};

type AiModel = { id: string; name: string; provider: string; contextWindow: number; inputPrice: number; outputPrice: number };
type AiConnection = { provider: string; connected: boolean; health: string; keyHint: string };
type AiStatusResponse = {
  managedReady?: boolean;
  connections?: AiConnection[];
  usage?: { requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; provider: string; model: string } | null;
  error?: string;
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

const steps = ['Purpose', 'Channels', 'Knowledge', 'Capabilities', 'Voice', 'AI model', 'Follow-up', 'Rules', 'Review'];
const channelOptions = ['Messenger', 'Facebook', 'Instagram', 'WhatsApp', 'TikTok', 'Airbnb', 'Shopee', 'Lazada', 'Shopify', 'Website'];
const knowledgeOptions = ['Website and FAQ pages', 'Products, services, and pricing', 'Catalogs or menus', 'Booking or property guides', 'Policies and procedures', 'Approved documents and answers'];
const capabilityOptions = ['Answer customer questions', 'Recommend products or services', 'Take orders or bookings', 'Share status updates', 'Qualify new inquiries', 'Support customers after hours'];
const toneOptions = ['Warm & conversational', 'Professional & composed', 'Concise & practical', 'Premium & attentive', 'Match our brand voice'];
const languageOptions = ['English', 'Filipino / Tagalog', 'Taglish', 'Cebuano', 'Another language'];
const escalationOptions = ['Customer asks for a team member', 'Answer cannot be verified', 'Complaint, refund, or urgent issue', 'Purchase or booking exceeds a limit', 'Payment or identity review is required', 'A custom rule is triggered'];
const aiProviderOptions = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic · Claude' },
  { id: 'google', label: 'Google · Gemini' },
  { id: 'xai', label: 'xAI · Grok' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'groq', label: 'Groq' },
  { id: 'cerebras', label: 'Cerebras' },
  { id: 'mistral', label: 'Mistral' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'mimo', label: 'Xiaomi · MiMo' },
];

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
  aiMode: 'orin_auto',
  aiProvider: 'openai',
  aiModel: '',
  aiFallbackModels: [],
  aiAllowManagedFallback: true,
  aiTemperature: 0.2,
  aiMaxOutputTokens: 260,
  aiDailyTokenLimit: 250000,
  followUpEnabled: false,
  followUpDelayAmount: 2,
  followUpDelayUnit: 'hours',
  followUpMessage: 'Just checking in—would you like help with anything else?',
  followUpCancelOnReply: true,
  followUpQuietHours: true,
  followUpMaxMessages: 1,
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
  const number = (key: keyof StudioDraft, fallback: number, minimum: number, maximum: number) => {
    const candidate = Number(source[key]);
    return Number.isFinite(candidate) ? Math.min(maximum, Math.max(minimum, candidate)) : fallback;
  };
  const boolean = (key: keyof StudioDraft, fallback: boolean) => typeof source[key] === 'boolean' ? source[key] as boolean : fallback;
  const mode = text('aiMode');
  const delayUnit = text('followUpDelayUnit');
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
    aiMode: ['managed', 'byok'].includes(mode) ? mode as StudioDraft['aiMode'] : 'orin_auto',
    aiProvider: text('aiProvider', 'openai'),
    aiModel: text('aiModel'),
    aiFallbackModels: stringArray(source.aiFallbackModels).slice(0, 4),
    aiAllowManagedFallback: boolean('aiAllowManagedFallback', true),
    aiTemperature: number('aiTemperature', 0.2, 0, 1),
    aiMaxOutputTokens: number('aiMaxOutputTokens', 260, 80, 1200),
    aiDailyTokenLimit: number('aiDailyTokenLimit', 250000, 0, 10000000),
    followUpEnabled: boolean('followUpEnabled', false),
    followUpDelayAmount: number('followUpDelayAmount', 2, 1, 30),
    followUpDelayUnit: ['minutes', 'days'].includes(delayUnit) ? delayUnit as StudioDraft['followUpDelayUnit'] : 'hours',
    followUpMessage: text('followUpMessage', 'Just checking in—would you like help with anything else?'),
    followUpCancelOnReply: boolean('followUpCancelOnReply', true),
    followUpQuietHours: boolean('followUpQuietHours', true),
    followUpMaxMessages: number('followUpMaxMessages', 1, 1, 3),
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
  const [searchParams] = useSearchParams();
  const [initialIdentity] = useState(() => routeAgentId
    ? { id: routeAgentId, isNew: false }
    : readPendingAgentIdentity());
  const agentId = routeAgentId || initialIdentity.id;
  const [draft, setDraft] = useState<StudioDraft>(() => routeAgentId ? initialDraft() : readStudioDraft());
  const [step, setStep] = useState(() => searchParams.get('step') === 'test' ? steps.length - 1 : 0);
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
  const [aiConnections, setAiConnections] = useState<AiConnection[]>([]);
  const [managedAiReady, setManagedAiReady] = useState(false);
  const [aiUsage, setAiUsage] = useState<AiStatusResponse['usage']>(null);
  const [modelCatalog, setModelCatalog] = useState<AiModel[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [providerKey, setProviderKey] = useState('');
  const [providerAction, setProviderAction] = useState<'idle' | 'saving' | 'removing'>('idle');
  const [providerMessage, setProviderMessage] = useState('');
  const [providerError, setProviderError] = useState('');
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
    if (!user || !workspace || !agentId) return undefined;
    let active = true;
    user.getIdToken()
      .then((token) => fetch(`/api/agents/ai?action=status&workspaceId=${encodeURIComponent(workspace.id)}&agentId=${encodeURIComponent(agentId)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }))
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as AiStatusResponse;
        if (!response.ok) throw new Error(result.error || 'AI provider status is unavailable.');
        if (!active) return;
        setAiConnections(result.connections || []);
        setManagedAiReady(Boolean(result.managedReady));
        setAiUsage(result.usage || null);
      })
      .catch((cause) => { if (active) setProviderError(cause instanceof Error ? cause.message : 'AI provider status is unavailable.'); });
    return () => { active = false; };
  }, [agentId, user, workspace]);

  useEffect(() => {
    if (!user || !workspace || !draft.aiProvider) return undefined;
    let active = true;
    setModelLoading(true);
    user.getIdToken()
      .then((token) => fetch(`/api/agents/ai?action=models&workspaceId=${encodeURIComponent(workspace.id)}&provider=${encodeURIComponent(draft.aiProvider)}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      }))
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as { models?: AiModel[]; error?: string };
        if (!response.ok) throw new Error(result.error || 'Models could not be loaded.');
        if (active) setModelCatalog(result.models || []);
      })
      .catch((cause) => { if (active) setProviderError(cause instanceof Error ? cause.message : 'Models could not be loaded.'); })
      .finally(() => { if (active) setModelLoading(false); });
    return () => { active = false; };
  }, [draft.aiProvider, user, workspace]);

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
        configUpdatedAt: serverTimestamp(),
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
    draft.aiMode === 'orin_auto' || Boolean(draft.aiProvider && draft.aiModel),
    !draft.followUpEnabled || Boolean(draft.followUpDelayAmount && draft.followUpMessage.trim()),
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

  const activeAiConnection = aiConnections.find((connection) => connection.provider === draft.aiProvider);
  const canEditAi = ['owner', 'admin', 'editor'].includes(workspace?.role || '');
  const followUpDelayMinutes = draft.followUpDelayAmount * (draft.followUpDelayUnit === 'days' ? 1440 : draft.followUpDelayUnit === 'hours' ? 60 : 1);
  const metaFollowUpOutsideWindow = draft.followUpEnabled
    && draft.channels.some((channel) => ['Messenger', 'Instagram'].includes(channel))
    && followUpDelayMinutes >= 1440;

  const connectAiProvider = async () => {
    if (!user || !workspace || !providerKey.trim() || !canEditAi) return;
    setProviderAction('saving');
    setProviderError('');
    setProviderMessage('Verifying the provider key…');
    try {
      const response = await fetch('/api/agents/ai', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'connect', workspaceId: workspace.id, provider: draft.aiProvider, apiKey: providerKey.trim() }),
      });
      const result = await response.json().catch(() => ({})) as { keyHint?: string; error?: string };
      if (!response.ok || !result.keyHint) throw new Error(result.error || 'The provider key could not be connected.');
      setAiConnections((current) => [
        ...current.filter((connection) => connection.provider !== draft.aiProvider),
        { provider: draft.aiProvider, connected: true, health: 'healthy', keyHint: result.keyHint! },
      ]);
      setProviderKey('');
      setProviderMessage(`${aiProviderOptions.find((item) => item.id === draft.aiProvider)?.label || draft.aiProvider} is connected. The key is encrypted and cannot be displayed again.`);
    } catch (cause) {
      setProviderMessage('');
      setProviderError(cause instanceof Error ? cause.message : 'The provider key could not be connected.');
    } finally {
      setProviderAction('idle');
    }
  };

  const disconnectAiProvider = async () => {
    if (!user || !workspace || !activeAiConnection?.connected || !canEditAi) return;
    setProviderAction('removing');
    setProviderError('');
    try {
      const response = await fetch('/api/agents/ai', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await user.getIdToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'disconnect', workspaceId: workspace.id, provider: draft.aiProvider }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || 'The provider key could not be removed.');
      setAiConnections((current) => current.filter((connection) => connection.provider !== draft.aiProvider));
      setProviderMessage('Provider key removed. This AI will use managed fallback until another key is connected.');
    } catch (cause) {
      setProviderError(cause instanceof Error ? cause.message : 'The provider key could not be removed.');
    } finally {
      setProviderAction('idle');
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

    if (step === 5) return (
      <div className="studio-ai-model">
        <div className="studio-question"><span>06</span><div><h2>Choose the intelligence behind it.</h2><p>Use ORIN’s automatic router, lock this AI to a model, or connect your own provider account.</p></div></div>
        <div className="studio-mode-grid">
          {[
            { id: 'orin_auto', title: 'ORIN Auto Router', detail: 'Chooses a fast, cost-efficient model and fails over automatically.' },
            { id: 'managed', title: 'Fixed managed model', detail: 'Use one selected model through ORIN’s managed gateway.' },
            { id: 'byok', title: 'Bring your own key', detail: 'Bill usage directly to your OpenAI, Claude, Grok, or other provider account.' },
          ].map((mode) => <button key={mode.id} type="button" className={draft.aiMode === mode.id ? 'is-selected' : ''} onClick={() => update('aiMode', mode.id as StudioDraft['aiMode'])}><BrainCircuit aria-hidden="true" /><span><strong>{mode.title}</strong><small>{mode.detail}</small></span>{draft.aiMode === mode.id && <Check aria-hidden="true" />}</button>)}
        </div>
        <div className="studio-ai-grid">
          <label><span>{draft.aiMode === 'orin_auto' ? 'Preferred provider' : 'Provider'}</span><select value={draft.aiProvider} onChange={(event) => { update('aiProvider', event.currentTarget.value); update('aiModel', ''); update('aiFallbackModels', []); setProviderMessage(''); setProviderError(''); }}>{aiProviderOptions.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select><small>{draft.aiMode === 'orin_auto' ? 'A preference, not a lock. ORIN can fail over when necessary.' : 'Models are loaded from the live provider catalog.'}</small></label>
          {draft.aiMode !== 'orin_auto' && <label><span>Primary model</span><select value={draft.aiModel} disabled={modelLoading} onChange={(event) => update('aiModel', event.currentTarget.value)}><option value="">{modelLoading ? 'Loading current models…' : 'Choose a model'}</option>{modelCatalog.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><small>Model IDs are discovered live; ORIN does not rely on a stale list.</small></label>}
          {draft.aiMode !== 'orin_auto' && <label><span>Fallback model <small>Optional</small></span><select value={draft.aiFallbackModels[0] || ''} disabled={modelLoading} onChange={(event) => update('aiFallbackModels', event.currentTarget.value ? [event.currentTarget.value] : [])}><option value="">No model fallback</option>{modelCatalog.filter((model) => model.id !== draft.aiModel).map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select><small>Used only when the primary model is unavailable or rate-limited.</small></label>}
          <label><span>Daily token guardrail</span><input type="number" min="0" max="10000000" step="10000" value={draft.aiDailyTokenLimit} onChange={(event) => update('aiDailyTokenLimit', Number(event.currentTarget.value))} /><small>Set 0 for no agent-level limit. Provider billing limits still apply.</small></label>
          <label><span>Maximum reply tokens</span><input type="number" min="80" max="1200" step="20" value={draft.aiMaxOutputTokens} onChange={(event) => update('aiMaxOutputTokens', Number(event.currentTarget.value))} /><small>Customer replies remain capped by ORIN’s response rules.</small></label>
          <label><span>Creativity · {draft.aiTemperature.toFixed(1)}</span><input type="range" min="0" max="1" step="0.1" value={draft.aiTemperature} onChange={(event) => update('aiTemperature', Number(event.currentTarget.value))} /><small>Lower is more consistent; higher is more expressive.</small></label>
        </div>
        {draft.aiMode === 'byok' && <section className={`studio-provider-vault${activeAiConnection?.connected ? ' is-connected' : ''}`}>
          <header><KeyRound aria-hidden="true" /><div><strong>{aiProviderOptions.find((item) => item.id === draft.aiProvider)?.label} API key</strong><span>{activeAiConnection?.connected ? `Connected · ${activeAiConnection.keyHint}` : 'Encrypted at rest and never returned to the browser.'}</span></div>{activeAiConnection?.connected && <ShieldCheck aria-label="Connected" />}</header>
          {activeAiConnection?.connected ? <button type="button" className="is-remove" disabled={providerAction !== 'idle' || !canEditAi} onClick={() => void disconnectAiProvider()}><Unplug aria-hidden="true" /> {providerAction === 'removing' ? 'Removing…' : 'Remove key'}</button> : <div><input type="password" autoComplete="off" aria-label={`${draft.aiProvider} API key`} value={providerKey} onChange={(event) => setProviderKey(event.currentTarget.value)} placeholder="Paste provider API key" /><button type="button" disabled={!providerKey.trim() || providerAction !== 'idle' || !canEditAi} onClick={() => void connectAiProvider()}>{providerAction === 'saving' ? 'Verifying…' : 'Verify and connect'}</button></div>}
          <label className="studio-check"><input type="checkbox" checked={draft.aiAllowManagedFallback} onChange={(event) => update('aiAllowManagedFallback', event.currentTarget.checked)} /><span>Use ORIN managed fallback if this provider is unavailable.</span></label>
          {(providerMessage || providerError) && <p className={providerError ? 'is-error' : ''} role={providerError ? 'alert' : 'status'}>{providerError || providerMessage}</p>}
        </section>}
        <section className="studio-usage-card"><div><span>Today</span><strong>{(aiUsage?.inputTokens || 0) + (aiUsage?.outputTokens || 0)} tokens</strong></div><div><span>Requests</span><strong>{aiUsage?.requests || 0}</strong></div><div><span>Estimated model cost</span><strong>${(aiUsage?.estimatedCostUsd || 0).toFixed(4)}</strong></div><small>{managedAiReady ? 'Managed routing available' : 'Connect a provider key to run this AI'}{aiUsage?.model ? ` · Last used ${aiUsage.model}` : ''}</small></section>
      </div>
    );

    if (step === 6) return (
      <div className="studio-followup">
        <div className="studio-question"><span>07</span><div><h2>Follow up without becoming noise.</h2><p>ORIN waits, checks that the customer has not replied, and stops immediately when your team takes over.</p></div></div>
        <label className="studio-feature-toggle"><input type="checkbox" checked={draft.followUpEnabled} onChange={(event) => update('followUpEnabled', event.currentTarget.checked)} /><Clock3 aria-hidden="true" /><span><strong>Automatic customer follow-up</strong><small>Off by default until you approve the timing and message.</small></span></label>
        {draft.followUpEnabled && <>
          <div className="studio-followup-grid">
            <label><span>Wait</span><input type="number" min="1" max="30" value={draft.followUpDelayAmount} onChange={(event) => update('followUpDelayAmount', Number(event.currentTarget.value))} /></label>
            <label><span>Unit</span><select value={draft.followUpDelayUnit} onChange={(event) => update('followUpDelayUnit', event.currentTarget.value as StudioDraft['followUpDelayUnit'])}><option value="minutes">Minutes</option><option value="hours">Hours</option><option value="days">Days</option></select></label>
            <label><span>Maximum follow-ups</span><select value={draft.followUpMaxMessages} onChange={(event) => update('followUpMaxMessages', Number(event.currentTarget.value))}><option value="1">One</option><option value="2">Two</option><option value="3">Three</option></select></label>
          </div>
          <label className="studio-field studio-field--spaced"><span>Follow-up message</span><textarea value={draft.followUpMessage} onChange={(event) => update('followUpMessage', event.currentTarget.value)} rows={4} maxLength={900} /></label>
          <div className="studio-followup-checks">
            <label className="studio-check"><input type="checkbox" checked={draft.followUpCancelOnReply} onChange={(event) => update('followUpCancelOnReply', event.currentTarget.checked)} /><span>Cancel when the customer replies.</span></label>
            <label className="studio-check"><input type="checkbox" checked={draft.followUpQuietHours} onChange={(event) => update('followUpQuietHours', event.currentTarget.checked)} /><span>Hold delivery outside 8:00 AM–8:00 PM in the workspace time zone.</span></label>
          </div>
          {metaFollowUpOutsideWindow && <div className="studio-policy-notice"><ShieldCheck aria-hidden="true" /><p><strong>Meta delivery protection is active.</strong> A regular Messenger or Instagram follow-up cannot be sent after the 24-hour customer window. ORIN will hold it unless an approved Meta message type is configured.</p></div>}
        </>}
      </div>
    );

    if (step === 7) return <><div className="studio-question"><span>08</span><div><h2>Where does its authority end?</h2><p>Define the decisions that stay with your team and the rules every answer must follow.</p></div></div><FieldOptions options={escalationOptions} values={draft.escalation} onToggle={(value) => toggle('escalation', value)} /><label className="studio-field studio-field--spaced"><span>Operating rules <small>Optional</small></span><textarea value={draft.operatingRules} onChange={(event) => update('operatingRules', event.currentTarget.value)} placeholder="Example: Never invent stock. Never approve a refund. Verify the order number before sharing an update." rows={5} /></label></>;

    return (
      <div className="studio-review">
        <div className="studio-question"><span>09</span><div><h2>Review the foundation.</h2><p>Saving keeps the draft editable. Publishing comes after knowledge and connection tests pass.</p></div></div>
        <dl>
          <div><dt>Purpose</dt><dd>{draft.purpose || 'Not defined'}</dd><button type="button" onClick={() => setStep(0)}>Edit</button></div>
          <div><dt>Channels</dt><dd>{draft.channels.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(1)}>Edit</button></div>
          <div><dt>Knowledge</dt><dd>{draft.knowledge.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(2)}>Edit</button></div>
          <div><dt>Capabilities</dt><dd>{draft.capabilities.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(3)}>Edit</button></div>
          <div><dt>Voice</dt><dd>{[draft.tone, ...draft.languages].filter(Boolean).join(' · ') || 'Not defined'}</dd><button type="button" onClick={() => setStep(4)}>Edit</button></div>
          <div><dt>AI routing</dt><dd>{draft.aiMode === 'orin_auto' ? `ORIN Auto Router · prefers ${draft.aiProvider}` : `${draft.aiMode === 'byok' ? 'BYOK' : 'Managed'} · ${draft.aiModel || 'Choose a model'}`}</dd><button type="button" onClick={() => setStep(5)}>Edit</button></div>
          <div><dt>Follow-up</dt><dd>{draft.followUpEnabled ? `${draft.followUpDelayAmount} ${draft.followUpDelayUnit} · up to ${draft.followUpMaxMessages}` : 'Off'}</dd><button type="button" onClick={() => setStep(6)}>Edit</button></div>
          <div><dt>Escalation</dt><dd>{draft.escalation.join(', ') || 'None selected'}</dd><button type="button" onClick={() => setStep(7)}>Edit</button></div>
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
