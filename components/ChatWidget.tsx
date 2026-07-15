import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type Message = {
  role: 'orin' | 'user';
  text: string;
};

type ChatMode = 'chat' | 'builder';
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';
type ListField = 'channels' | 'responsibilities' | 'handoffRules';

type AiDraft = {
  businessName: string;
  useCase: string;
  roleNotes: string;
  channels: string[];
  responsibilities: string[];
  tone: string;
  toneNotes: string;
  handoffRules: string[];
  name: string;
  email: string;
};

type SavedDraft = {
  draft: AiDraft;
  step: number;
  savedAt: number;
};

const contactUrl = 'https://marvin.orin.work';
const storageKey = 'orin-ai-builder-draft-v1';

const quickQuestions = [
  'What can ORIN AI handle?',
  'Which channels work with Orin?',
  'What is included for ₱15,000?',
];

const useCases = [
  'Sales & customer service',
  'E-commerce concierge',
  'Guest & booking support',
  'Appointment coordinator',
  'Information desk',
  'Something custom',
];

const channels = ['Facebook', 'Messenger', 'Instagram', 'TikTok', 'Airbnb', 'Shopee', 'Lazada', 'Shopify', 'Website'];

const responsibilities = [
  'Answer customer questions',
  'Recommend products or services',
  'Take orders or bookings',
  'Share status updates',
  'Qualify new inquiries',
  'Support customers after hours',
];

const tones = [
  { label: 'Warm & conversational', preview: 'Hi! I can help with that. Let me check the details for you.' },
  { label: 'Clear & professional', preview: 'Certainly. I’ll confirm the details and guide you from here.' },
  { label: 'Concise & direct', preview: 'I can help. Here are the next steps.' },
  { label: 'Premium & polished', preview: 'Of course. I’ll take care of the details and keep this simple.' },
  { label: 'Define my own voice', preview: 'Your voice notes will shape how Orin responds.' },
];

const handoffRules = [
  'A customer asks for a person',
  'Orin is not confident in the answer',
  'A complaint or urgent issue arrives',
  'The inquiry is high-value or sensitive',
  'A payment or account issue needs review',
  'Only when my team sets a rule',
];

const stepLabels = ['Business', 'Channels', 'Responsibilities', 'Voice', 'Escalation', 'Review'];

const emptyDraft = (): AiDraft => ({
  businessName: '',
  useCase: '',
  roleNotes: '',
  channels: [],
  responsibilities: [],
  tone: '',
  toneNotes: '',
  handoffRules: [],
  name: '',
  email: '',
});

function readSavedDraft(): SavedDraft | null {
  if (typeof window === 'undefined') return null;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? 'null') as Partial<SavedDraft> | null;
    if (!parsed?.draft || typeof parsed.draft !== 'object') return null;
    const candidate = parsed.draft as Partial<AiDraft>;

    return {
      draft: {
        ...emptyDraft(),
        ...candidate,
        channels: Array.isArray(candidate.channels) ? candidate.channels.filter((item): item is string => typeof item === 'string') : [],
        responsibilities: Array.isArray(candidate.responsibilities) ? candidate.responsibilities.filter((item): item is string => typeof item === 'string') : [],
        handoffRules: Array.isArray(candidate.handoffRules) ? candidate.handoffRules.filter((item): item is string => typeof item === 'string') : [],
      },
      step: Math.min(stepLabels.length - 1, Math.max(0, Number(parsed.step) || 0)),
      savedAt: Number(parsed.savedAt) || Date.now(),
    };
  } catch {
    return null;
  }
}

function replyFor(message: string) {
  const text = message.toLowerCase();

  if (/channel|platform|messenger|facebook|instagram|tiktok|airbnb|shopee|lazada|shopify/.test(text)) {
    return 'ORIN AI can be configured for Facebook, Messenger, Instagram, TikTok, Airbnb, Shopee, Lazada, Shopify, and your website. The exact setup depends on the access each platform provides to your business.';
  }

  if (/15|price|pricing|plan|cost|include/.test(text)) {
    return 'The ORIN AI plan is ₱15,000 per month. We first map your channels, business knowledge, reply rules, voice, and human escalation. Build a brief here or book a walkthrough so the scope is clear before anything goes live.';
  }

  if (/handle|do|voice|image|answer|inquir|message/.test(text)) {
    return 'Orin handles routine questions, product or booking details, text, voice notes, images, and after-hours messages. You decide how Orin should sound and exactly when your team should take over.';
  }

  if (/human|marvin|talk|book|demo|walkthrough|contact/.test(text)) {
    return 'Marvin can map ORIN AI to your actual workflow. You can build your AI brief here first, then bring that plan into a walkthrough.';
  }

  return 'That depends on how your business receives and answers inquiries. Use “Build my ORIN AI” and I’ll turn your channels, voice, responsibilities, and escalation rules into a clear brief.';
}

function selectionSummary(items: string[]) {
  return items.length ? items.join(', ') : 'Not chosen yet';
}

export function ChatWidget() {
  const [initialSaved] = useState<SavedDraft | null>(() => readSavedDraft());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ChatMode>('chat');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'orin',
      text: "Hi, I'm Orin. Ask a question, or build the first brief for your own ORIN AI.",
    },
  ]);
  const [draft, setDraft] = useState<AiDraft>(() => initialSaved?.draft ?? emptyDraft());
  const [builderStep, setBuilderStep] = useState(() => initialSaved?.step ?? 0);
  const [builderStarted, setBuilderStarted] = useState(Boolean(initialSaved));
  const [hasSavedDraft, setHasSavedDraft] = useState(Boolean(initialSaved));
  const [savedAt, setSavedAt] = useState<number | null>(() => initialSaved?.savedAt ?? null);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [submitError, setSubmitError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);

  const closeChat = () => {
    setOpen(false);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => launcherRef.current?.focus());
    }
  };

  const tonePreview = useMemo(
    () => tones.find((option) => option.label === draft.tone)?.preview ?? 'Choose a voice to hear how Orin could sound.',
    [draft.tone],
  );

  useEffect(() => {
    if (!open || mode !== 'chat') return;
    inputRef.current?.focus();
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, mode, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeChat();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!builderStarted || submitState === 'success' || typeof window === 'undefined') return;
    const now = Date.now();
    const payload: SavedDraft = { draft, step: builderStep, savedAt: now };

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
      setSavedAt(now);
      setHasSavedDraft(true);
    } catch {
      setSavedAt(null);
    }
  }, [builderStarted, builderStep, draft, submitState]);

  const send = (message: string) => {
    const clean = message.trim();
    if (!clean) return;
    setMessages((current) => [
      ...current,
      { role: 'user', text: clean },
      { role: 'orin', text: replyFor(clean) },
    ]);
    setInput('');
  };

  const submitChat = (event: FormEvent) => {
    event.preventDefault();
    send(input);
  };

  const startBuilder = () => {
    setBuilderStarted(true);
    setMode('builder');
    setSubmitState('idle');
    setSubmitError('');
  };

  const setField = <Key extends keyof AiDraft>(field: Key, value: AiDraft[Key]) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setSubmitState('idle');
  };

  const toggleList = (field: ListField, value: string) => {
    setDraft((current) => {
      const list = current[field];
      return {
        ...current,
        [field]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value],
      };
    });
    setSubmitState('idle');
  };

  const canContinue = [
    Boolean(draft.businessName.trim() && draft.useCase && (draft.useCase !== 'Something custom' || draft.roleNotes.trim())),
    draft.channels.length > 0,
    draft.responsibilities.length > 0,
    Boolean(draft.tone && (draft.tone !== 'Define my own voice' || draft.toneNotes.trim())),
    draft.handoffRules.length > 0,
  ][builderStep] ?? true;

  const goNext = () => {
    if (!canContinue) return;
    setBuilderStep((current) => Math.min(stepLabels.length - 1, current + 1));
  };

  const clearDraft = () => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey);
    setDraft(emptyDraft());
    setBuilderStep(0);
    setBuilderStarted(false);
    setHasSavedDraft(false);
    setSavedAt(null);
    setSubmitState('idle');
    setSubmitError('');
    setMode('chat');
  };

  const submitBrief = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.email.trim()) {
      setSubmitState('error');
      setSubmitError('Add your name and email so we know where to send the next step.');
      return;
    }

    setSubmitState('submitting');
    setSubmitError('');

    try {
      const response = await fetch('/api/submit-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: draft.name,
          business_name: draft.businessName,
          email: draft.email,
          ai_role: `${draft.useCase} · ${draft.tone}`,
          configuration: JSON.stringify({
            role_notes: draft.roleNotes,
            channels: draft.channels,
            responsibilities: draft.responsibilities,
            tone_notes: draft.toneNotes,
            handoff_rules: draft.handoffRules,
          }),
          company_website: '',
        }),
      });

      await response.json().catch(() => ({}));
      if (!response.ok) throw new Error('Your brief is still saved on this device. Please try again or book a walkthrough.');

      if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey);
      setSubmitState('success');
      setBuilderStarted(false);
      setHasSavedDraft(false);
      setSavedAt(null);
    } catch (error) {
      setSubmitState('error');
      setSubmitError(error instanceof Error ? error.message : 'Your brief could not be sent yet.');
    }
  };

  const renderBuilderStep = () => {
    if (submitState === 'success') {
      return (
        <div className="builder-success" role="status">
          <span className="builder-success__mark" aria-hidden="true">✓</span>
          <p className="builder-kicker">Brief received</p>
          <h3>Your ORIN AI has a starting point.</h3>
          <p>We’ll use this brief to prepare the right channels, voice, responsibilities, and escalation rules for your walkthrough.</p>
          <a href={contactUrl}>Book the walkthrough</a>
          <button type="button" onClick={clearDraft}>Start another brief</button>
        </div>
      );
    }

    if (builderStep === 0) {
      return (
        <>
          <div className="builder-prompt">
            <span>Orin</span>
            <p>What should Orin become for your business?</p>
            <small>Choose the closest starting point. We’ll shape the details next.</small>
          </div>
          <label className="builder-field">
            <span>Business name</span>
            <input value={draft.businessName} onChange={(event) => setField('businessName', event.currentTarget.value)} placeholder="Your business" autoComplete="organization" />
          </label>
          <fieldset className="builder-options">
            <legend>Primary role</legend>
            {useCases.map((option) => (
              <button key={option} type="button" className={draft.useCase === option ? 'is-selected' : ''} aria-pressed={draft.useCase === option} onClick={() => setField('useCase', option)}>{option}</button>
            ))}
          </fieldset>
          {draft.useCase === 'Something custom' && (
            <label className="builder-field">
              <span>Describe the role</span>
              <textarea value={draft.roleNotes} onChange={(event) => setField('roleNotes', event.currentTarget.value)} placeholder="Tell us what Orin should own." rows={3} />
            </label>
          )}
        </>
      );
    }

    if (builderStep === 1) {
      return (
        <>
          <div className="builder-prompt">
            <span>Orin</span>
            <p>Where should customers reach me?</p>
            <small>Select every channel you want in the first setup.</small>
          </div>
          <fieldset className="builder-options builder-options--compact">
            <legend>Channels</legend>
            {channels.map((option) => (
              <button key={option} type="button" className={draft.channels.includes(option) ? 'is-selected' : ''} aria-pressed={draft.channels.includes(option)} onClick={() => toggleList('channels', option)}>{option}</button>
            ))}
          </fieldset>
        </>
      );
    }

    if (builderStep === 2) {
      return (
        <>
          <div className="builder-prompt">
            <span>Orin</span>
            <p>What should I take off your team’s plate?</p>
            <small>Choose the work that repeats most often.</small>
          </div>
          <fieldset className="builder-options">
            <legend>Responsibilities</legend>
            {responsibilities.map((option) => (
              <button key={option} type="button" className={draft.responsibilities.includes(option) ? 'is-selected' : ''} aria-pressed={draft.responsibilities.includes(option)} onClick={() => toggleList('responsibilities', option)}>{option}</button>
            ))}
          </fieldset>
        </>
      );
    }

    if (builderStep === 3) {
      return (
        <>
          <div className="builder-prompt">
            <span>Orin</span>
            <p>How should I sound?</p>
            <small>The voice should feel like your business—not a generic chatbot.</small>
          </div>
          <fieldset className="builder-options">
            <legend>Voice</legend>
            {tones.map((option) => (
              <button key={option.label} type="button" className={draft.tone === option.label ? 'is-selected' : ''} aria-pressed={draft.tone === option.label} onClick={() => setField('tone', option.label)}>{option.label}</button>
            ))}
          </fieldset>
          <blockquote className="builder-tone-preview">
            <span>Voice preview</span>
            <p>“{tonePreview}”</p>
          </blockquote>
          <label className="builder-field">
            <span>{draft.tone === 'Define my own voice' ? 'Describe the voice' : 'Add voice notes (optional)'}</span>
            <textarea value={draft.toneNotes} onChange={(event) => setField('toneNotes', event.currentTarget.value)} placeholder="Example: Use English and Taglish. Calm, never pushy." rows={3} />
          </label>
        </>
      );
    }

    if (builderStep === 4) {
      return (
        <>
          <div className="builder-prompt">
            <span>Orin</span>
            <p>When should your team take over?</p>
            <small>Orin handles the repeatable work. Your people keep the judgment calls.</small>
          </div>
          <fieldset className="builder-options">
            <legend>Human escalation rules</legend>
            {handoffRules.map((option) => (
              <button key={option} type="button" className={draft.handoffRules.includes(option) ? 'is-selected' : ''} aria-pressed={draft.handoffRules.includes(option)} onClick={() => toggleList('handoffRules', option)}>{option}</button>
            ))}
          </fieldset>
        </>
      );
    }

    return (
      <form className="builder-review" onSubmit={submitBrief}>
        <div className="builder-prompt">
          <span>Orin</span>
          <p>Here’s the ORIN AI we’ll design together.</p>
          <small>Review the brief, then send it when you’re ready.</small>
        </div>

        <div className="builder-summary">
          <button type="button" onClick={() => setBuilderStep(0)}><span>Role</span><strong>{draft.useCase}</strong></button>
          <button type="button" onClick={() => setBuilderStep(1)}><span>Channels</span><strong>{selectionSummary(draft.channels)}</strong></button>
          <button type="button" onClick={() => setBuilderStep(2)}><span>Responsibilities</span><strong>{selectionSummary(draft.responsibilities)}</strong></button>
          <button type="button" onClick={() => setBuilderStep(3)}><span>Voice</span><strong>{draft.tone}</strong></button>
          <button type="button" onClick={() => setBuilderStep(4)}><span>Human escalation</span><strong>{selectionSummary(draft.handoffRules)}</strong></button>
        </div>

        <div className="builder-contact">
          <label className="builder-field">
            <span>Your name</span>
            <input value={draft.name} onChange={(event) => setField('name', event.currentTarget.value)} placeholder="Your name" autoComplete="name" />
          </label>
          <label className="builder-field">
            <span>Email</span>
            <input type="email" value={draft.email} onChange={(event) => setField('email', event.currentTarget.value)} placeholder="you@business.com" autoComplete="email" />
          </label>
        </div>

        {submitState === 'error' && <p className="builder-error" role="alert">{submitError}</p>}

        <button className="builder-submit" type="submit" disabled={submitState === 'submitting'}>
          {submitState === 'submitting' ? 'Sending your brief…' : 'Send my ORIN AI brief'}
        </button>
        <p className="builder-consent">Your brief is sent to IDRA only when you press send.</p>
      </form>
    );
  };

  return (
    <div className={`chat-widget${open ? ' is-open' : ''}`}>
      <section id="orin-chat-panel" className={`chat-panel chat-panel--${mode}`} aria-label="Chat with Orin" aria-hidden={!open}>
        <header className="chat-panel__header">
          <div className="chat-panel__identity">
            <span className="chat-panel__avatar">
              <img src="/assets/brand/orin-mascot-original.webp" alt="" />
              <i aria-hidden="true" />
            </span>
            <span>
              <strong>ORIN AI</strong>
              <small>{mode === 'builder' ? 'Build your AI' : 'Ask Orin'}</small>
            </span>
          </div>
          <button type="button" onClick={closeChat} aria-label="Close chat">×</button>
        </header>

        <nav className="chat-panel__switcher" aria-label="Orin chat options">
          <button type="button" className={mode === 'chat' ? 'is-active' : ''} aria-pressed={mode === 'chat'} onClick={() => setMode('chat')}>Ask Orin</button>
          <button type="button" className={mode === 'builder' ? 'is-active' : ''} aria-pressed={mode === 'builder'} onClick={startBuilder}>{hasSavedDraft ? 'Resume setup' : 'Build my AI'}</button>
        </nav>

        {mode === 'chat' ? (
          <>
            <div ref={logRef} className="chat-panel__log" aria-live="polite">
              {messages.map((message, index) => (
                <p key={`${message.role}-${index}`} className={`chat-message chat-message--${message.role}`}>
                  {message.text}
                </p>
              ))}
              {messages.length === 1 && (
                <div className="chat-start">
                  <button className="chat-build-card" type="button" onClick={startBuilder}>
                    <span>Design yours</span>
                    <strong>Build my ORIN AI</strong>
                    <small>Voice, channels, responsibilities, and human escalation.</small>
                  </button>
                  <div className="chat-questions" aria-label="Suggested questions">
                    {quickQuestions.map((question) => (
                      <button key={question} type="button" onClick={() => send(question)}>{question}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <a className="chat-panel__contact" href={contactUrl}>Book an ORIN AI walkthrough</a>

            <form className="chat-panel__form" onSubmit={submitChat}>
              <label className="visually-hidden" htmlFor="orin-chat-input">Ask Orin a question</label>
              <input
                ref={inputRef}
                id="orin-chat-input"
                value={input}
                onChange={(event) => setInput(event.currentTarget.value)}
                placeholder="Ask Orin..."
                autoComplete="off"
                tabIndex={open ? 0 : -1}
              />
              <button type="submit" aria-label="Send question" tabIndex={open ? 0 : -1}>Send</button>
            </form>
            <p className="chat-panel__privacy">Your questions stay in this browser.</p>
          </>
        ) : (
          <div className="ai-builder">
            {submitState !== 'success' && (
              <div className="builder-progress">
                <div>
                  <span>Build your ORIN AI</span>
                  <strong>Step {builderStep + 1} of {stepLabels.length}</strong>
                </div>
                <ol aria-label="Setup progress">
                  {stepLabels.map((label, index) => (
                    <li key={label} className={index === builderStep ? 'is-current' : index < builderStep ? 'is-complete' : ''} aria-current={index === builderStep ? 'step' : undefined}><span>{label}</span></li>
                  ))}
                </ol>
              </div>
            )}

            <div className="builder-stage">{renderBuilderStep()}</div>

            {submitState !== 'success' && (
              <footer className="builder-footer">
                <div className="builder-footer__actions">
                  {builderStep > 0 && <button type="button" onClick={() => setBuilderStep((current) => Math.max(0, current - 1))}>Back</button>}
                  {builderStep < stepLabels.length - 1 && <button className="is-primary" type="button" disabled={!canContinue} onClick={goNext}>Continue</button>}
                  <button type="button" onClick={closeChat}>Save & close</button>
                </div>
                <div className="builder-save-state">
                  <span>{savedAt ? 'Saved on this device' : 'Changes stay on this device'}</span>
                  {hasSavedDraft && <button type="button" onClick={clearDraft}>Clear draft</button>}
                </div>
              </footer>
            )}
          </div>
        )}
      </section>

      <button
        ref={launcherRef}
        className="chat-launcher"
        type="button"
        aria-expanded={open}
        aria-controls="orin-chat-panel"
        aria-label={open ? 'Close Orin chat' : hasSavedDraft ? 'Resume ORIN AI setup' : 'Chat with Orin'}
        onClick={() => {
          if (open) {
            closeChat();
            return;
          }
          if (hasSavedDraft) {
            setMode('builder');
            setBuilderStarted(true);
          }
          setOpen(true);
        }}
      >
        <img src="/assets/brand/orin-mascot-original.webp" alt="" />
        <span>{open ? 'Close' : hasSavedDraft ? 'Resume setup' : 'Ask Orin'}</span>
      </button>
    </div>
  );
}
