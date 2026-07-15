import { FormEvent, useEffect, useRef, useState } from 'react';

type Message = {
  role: 'orin' | 'user';
  text: string;
};

const contactUrl = 'https://marvin.orin.work';

const quickQuestions = [
  'What can ORIN AI handle?',
  'Which channels work with Orin?',
  'What is included for ₱15,000?',
];

function replyFor(message: string) {
  const text = message.toLowerCase();

  if (/channel|platform|messenger|facebook|instagram|tiktok|airbnb|shopee|lazada|shopify/.test(text)) {
    return 'ORIN AI can be configured for Facebook, Messenger, Instagram, TikTok, Airbnb, Shopee, Lazada, and Shopify. The exact setup depends on the access each platform provides to your business.';
  }

  if (/15|price|pricing|plan|cost|include/.test(text)) {
    return 'The ORIN AI plan is ₱15,000 per month. We first map your channels, business knowledge, reply rules, and human handoff. Book a walkthrough so the scope is clear before anything goes live.';
  }

  if (/handle|do|voice|image|answer|inquir|message/.test(text)) {
    return 'Orin handles routine questions, product or booking details, text, voice notes, images, and after-hours messages. When a conversation needs judgment, your team receives the conversation and the customer context.';
  }

  if (/human|marvin|talk|book|demo|walkthrough|contact/.test(text)) {
    return 'Marvin can map ORIN AI to your actual workflow. Use the walkthrough link below and bring the channels and questions your team handles most often.';
  }

  return 'That depends on how your business receives and answers inquiries. Marvin can map the workflow with you and show where ORIN AI should answer, wait, or hand the conversation over.';
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'orin',
      text: "Hi, I'm Orin. Ask what ORIN AI can handle, where it works, or what the ₱15,000 plan includes.",
    },
  ]);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(input);
  };

  return (
    <div className={`chat-widget${open ? ' is-open' : ''}`}>
      <section id="orin-chat-panel" className="chat-panel" aria-label="Chat with Orin" aria-hidden={!open}>
        <header className="chat-panel__header">
          <div className="chat-panel__identity">
            <span className="chat-panel__avatar">
              <img src="/assets/brand/orin-mascot-original.webp" alt="" />
              <i aria-hidden="true" />
            </span>
            <span>
              <strong>ORIN AI</strong>
              <small>Ask Orin</small>
            </span>
          </div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Close chat">×</button>
        </header>

        <div ref={logRef} className="chat-panel__log" aria-live="polite">
          {messages.map((message, index) => (
            <p key={`${message.role}-${index}`} className={`chat-message chat-message--${message.role}`}>
              {message.text}
            </p>
          ))}
          {messages.length === 1 && (
            <div className="chat-questions" aria-label="Suggested questions">
              {quickQuestions.map((question) => (
                <button key={question} type="button" onClick={() => send(question)}>{question}</button>
              ))}
            </div>
          )}
        </div>

        <a className="chat-panel__contact" href={contactUrl}>Book an ORIN AI walkthrough</a>

        <form className="chat-panel__form" onSubmit={submit}>
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
        <p className="chat-panel__privacy">This demo stays in your browser and clears when you refresh.</p>
      </section>

      <button
        className="chat-launcher"
        type="button"
        aria-expanded={open}
        aria-controls="orin-chat-panel"
        aria-label={open ? 'Close Orin chat' : 'Chat with Orin'}
        onClick={() => setOpen((value) => !value)}
      >
        <img src="/assets/brand/orin-mascot-original.webp" alt="" />
        <span>{open ? 'Close' : 'Ask Orin'}</span>
      </button>
    </div>
  );
}
