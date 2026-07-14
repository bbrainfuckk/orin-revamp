import { useEffect, useRef } from 'react';
import { RoiCalculator } from './components/RoiCalculator';

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
    label: 'Inquiry',
    still: '/assets/world/stills/01-inquiry-arrives.webp',
    clip: '/assets/world/video/01-inquiry-arrives.mp4',
    clipMobile: '/assets/world/video/01-inquiry-arrives-m.mp4',
    accent: '#54F99B',
    scroll: 1.6,
    linger: 0.22,
    eyebrow: 'Facebook Messenger, always attended',
    title: 'Every inquiry, answered.',
    body: 'ORIN is the 24/7 AI front desk for Filipino shops, hosts, care teams, and public service.',
    tags: ['Text, voice + images', '24/7 response'],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    still: '/assets/world/stills/02-commerce-studio.webp',
    clip: '/assets/world/video/02-commerce-studio.mp4',
    clipMobile: '/assets/world/video/02-commerce-studio-m.mp4',
    accent: '#72F2B0',
    scroll: 1.4,
    linger: 0.18,
    eyebrow: 'For online sellers',
    title: 'Questions become orders.',
    body: 'ORIN handles product questions and keeps online sales moving while the seller is away.',
    tags: ['E-commerce support', 'After-hours sales'],
  },
  {
    id: 'guest-stays',
    label: 'Guest stays',
    still: '/assets/world/stills/03-guest-checkin.webp',
    clip: '/assets/world/video/03-guest-checkin.mp4',
    clipMobile: '/assets/world/video/03-guest-checkin-m.mp4',
    accent: '#B8F2A1',
    scroll: 1.4,
    linger: 0.18,
    eyebrow: 'For hosts and guests',
    title: 'Guests know what happens next.',
    body: 'Routine check-in questions get a clear response without waking the host.',
    tags: ['Guest support', 'Always available'],
  },
  {
    id: 'care',
    label: 'Care',
    still: '/assets/world/stills/04-care-navigation.webp',
    clip: '/assets/world/video/04-care-navigation.mp4',
    clipMobile: '/assets/world/video/04-care-navigation-m.mp4',
    accent: '#54F99B',
    scroll: 1.4,
    linger: 0.16,
    eyebrow: 'For routine hospital inquiries',
    title: 'The right question finds the right desk.',
    body: 'ORIN organizes appointment and location requests, then connects people to hospital staff.',
    tags: ['Administrative intake', 'Human-led care'],
  },
  {
    id: 'handoff',
    label: 'Handoff',
    still: '/assets/world/stills/05-human-handoff-draft.webp',
    accent: '#8FD56F',
    scroll: 1.2,
    linger: 0.12,
    eyebrow: 'Humans stay responsible',
    title: 'Sensitive cases reach a person.',
    body: 'ORIN keeps the context attached and hands responsibility to the right human.',
    tags: ['Safe escalation', 'Full context'],
  },
  {
    id: 'morning',
    label: 'Morning',
    still: mascotPoster,
    accent: '#D7B66F',
    scroll: 1.7,
    linger: 0.32,
    eyebrow: 'By morning',
    title: 'No one starts from zero.',
    body: 'Inquiries are answered, organized, or already waiting with the right human.',
    tags: ['Built for Filipino communities'],
    cta: {
      primary: { label: 'Book an ORIN walkthrough', href: contactUrl },
      secondary: { label: 'See the ₱15,000 plan', href: '#roi' },
    },
  },
];

export default function App() {
  const worldRef = useRef<HTMLDivElement>(null);

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
      brand: { name: 'ORIN', href: '#top' },
      cta: { label: 'See pricing', href: '#roi' },
      hint: 'Scroll to follow one inquiry',
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
      <div ref={worldRef} id="world" aria-label="Follow how ORIN handles community inquiries" />
      <RoiCalculator />
      <noscript>
        <section className="orin-noscript">
          <img src={mascotPoster} alt="ORIN, a friendly green robot with a sprout leaf" />
          <p>ORIN helps every inquiry find an answer or the right human.</p>
          <a href={contactUrl}>Book an ORIN walkthrough</a>
        </section>
      </noscript>
    </main>
  );
}
