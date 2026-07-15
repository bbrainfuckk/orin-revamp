import { useEffect, useRef, useState } from 'react';
import { ChatWidget } from './components/ChatWidget';
import { PlatformRail } from './components/PlatformRail';
import { PrivacyPolicy } from './components/PrivacyPolicy';
import { RoiCalculator } from './components/RoiCalculator';
import { SiteFooter } from './components/SiteFooter';

declare global {
  interface Window {
    mountScrollWorld?: (container: HTMLElement, config: Record<string, unknown>) => void;
  }
}

const mascotPoster = '/assets/brand/orin-mascot-3d-master.webp';
const contactUrl = 'https://marvin.orin.work';

const sections = [
  {
    id: 'inquiry',
    label: 'Answer',
    still: '/assets/world/stills/01-inquiry-arrives.webp',
    clip: '/assets/world/video/01-inquiry-arrives.mp4',
    clipMobile: '/assets/world/video/01-inquiry-arrives-m.mp4',
    accent: '#54F99B',
    scroll: 1.6,
    linger: 0.22,
    eyebrow: 'ORIN AI · one front desk for every channel',
    title: "Your business is open, even when you aren't.",
    body: 'Orin answers routine questions the moment they arrive, whether the customer sends text, a voice note, or an image.',
    tags: ['Across your channels', 'Day and night'],
  },
  {
    id: 'commerce',
    label: 'Sell',
    still: '/assets/world/stills/02-commerce-studio.webp',
    clip: '/assets/world/video/02-commerce-studio.mp4',
    clipMobile: '/assets/world/video/02-commerce-studio-m.mp4',
    accent: '#72F2B0',
    scroll: 1.4,
    linger: 0.18,
    eyebrow: 'Sell without watching the inbox',
    title: 'A question can become an order.',
    body: 'Orin handles product, stock, delivery, and payment questions across social and online stores.',
    tags: ['TikTok · Instagram', 'Shopee · Lazada · Shopify'],
  },
  {
    id: 'guest-stays',
    label: 'Host',
    still: '/assets/world/stills/03-guest-checkin.webp',
    clip: '/assets/world/video/03-guest-checkin.mp4',
    clipMobile: '/assets/world/video/03-guest-checkin-m.mp4',
    accent: '#B8F2A1',
    scroll: 1.4,
    linger: 0.18,
    eyebrow: 'The host can sleep',
    title: 'Guests arrive knowing what to do.',
    body: 'Orin handles check-in details, house questions, and routine requests on Airbnb.',
    tags: ['Airbnb guest support', 'Available after hours'],
  },
  {
    id: 'care',
    label: 'Guide',
    still: '/assets/world/stills/04-care-navigation.webp',
    clip: '/assets/world/video/04-care-navigation.mp4',
    clipMobile: '/assets/world/video/04-care-navigation-m.mp4',
    accent: '#54F99B',
    scroll: 1.4,
    linger: 0.16,
    eyebrow: 'Give people a clear next step',
    title: 'Less waiting. Fewer wrong turns.',
    body: 'Orin answers routine questions about schedules, departments, and locations. Staff keep their time for people.',
    tags: ['Routine inquiries', 'People stay in charge'],
  },
  {
    id: 'handoff',
    label: 'Handoff',
    still: '/assets/world/stills/05-human-handoff-draft.webp',
    accent: '#8FD56F',
    scroll: 1.2,
    linger: 0.12,
    eyebrow: 'A clean handoff',
    title: 'Nothing gets lost in the handoff.',
    body: 'When your team needs to step in, Orin sends the conversation to the right person with the next action clear.',
    tags: ['The full conversation', 'Clear ownership'],
  },
  {
    id: 'morning',
    label: 'Morning',
    still: mascotPoster,
    accent: '#D7B66F',
    scroll: 1.7,
    linger: 0.32,
    eyebrow: 'By morning',
    title: 'Start the day ahead.',
    body: 'Customers have answers, orders are moving, guests are informed, and the questions that need you are ready.',
    tags: ['ORIN AI by IDRA'],
    cta: {
      primary: { label: 'See ORIN AI on your workflow', href: contactUrl },
      secondary: { label: 'Run your numbers', href: '#roi' },
    },
  },
];

export default function App() {
  const worldRef = useRef<HTMLDivElement>(null);
  const [privacyOpen, setPrivacyOpen] = useState(() => window.location.hash === '#privacy');

  useEffect(() => {
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    const blockAssetDrag = (event: DragEvent) => {
      if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) {
        event.preventDefault();
      }
    };
    const blockInspectShortcuts = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      const inspectShortcut = command && event.shiftKey && ['i', 'j', 'c'].includes(key);
      const macInspectShortcut = event.metaKey && event.altKey && ['i', 'j', 'c'].includes(key);
      if (event.key === 'F12' || inspectShortcut || macInspectShortcut || (command && key === 'u')) {
        event.preventDefault();
      }
    };

    document.addEventListener('contextmenu', blockContextMenu);
    document.addEventListener('dragstart', blockAssetDrag);
    document.addEventListener('keydown', blockInspectShortcuts);
    return () => {
      document.removeEventListener('contextmenu', blockContextMenu);
      document.removeEventListener('dragstart', blockAssetDrag);
      document.removeEventListener('keydown', blockInspectShortcuts);
    };
  }, []);

  useEffect(() => {
    const container = worldRef.current;
    const mount = window.mountScrollWorld;

    if (!container || !mount || container.dataset.mounted === 'true') return;
    container.dataset.mounted = 'true';

    mount(container, {
      brand: { name: 'ORIN AI', href: '#top' },
      cta: { label: 'See the plan', href: '#roi' },
      hint: 'Scroll to follow Orin',
      nav: true,
      atmosphere: true,
      diveScroll: 1.4,
      connScroll: 0.8,
      crossfade: 0.1,
      sections,
      connectors: [],
    });
  }, []);

  return (
    <main id="top" className="orin-site">
      <div ref={worldRef} id="world" aria-label="Follow how ORIN AI handles customer inquiries" />
      <PlatformRail />
      <RoiCalculator />
      <SiteFooter onPrivacy={() => {
        window.history.replaceState(null, '', '#privacy');
        setPrivacyOpen(true);
      }} />
      <ChatWidget />
      <PrivacyPolicy open={privacyOpen} onClose={() => {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        setPrivacyOpen(false);
      }} />
      <noscript>
        <section className="orin-noscript">
          <img src={mascotPoster} alt="Orin, the friendly ORIN AI mascot" />
          <p>ORIN AI answers customer questions across the channels your business already uses.</p>
          <a href={contactUrl}>Book an ORIN AI walkthrough</a>
        </section>
      </noscript>
    </main>
  );
}
