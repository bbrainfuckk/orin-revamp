import type { CSSProperties } from 'react';
import {
  siAirbnb,
  siBluesky,
  siFacebook,
  siGoogle,
  siInstagram,
  siMastodon,
  siMessenger,
  siMeta,
  siN8n,
  siPinterest,
  siQuickbooks,
  siReddit,
  siShopee,
  siShopify,
  siTelegram,
  siThreads,
  siTiktok,
  siWhatsapp,
  siX,
  siYoutube,
  type SimpleIcon,
} from 'simple-icons';

const linkedin: SimpleIcon = {
  title: 'LinkedIn',
  slug: 'linkedin',
  hex: '0A66C2',
  svg: '<svg role="img" viewBox="0 0 24 24"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124ZM7.119 20.452H3.555V9h3.564v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z"/></svg>',
  path: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286ZM5.337 7.433a2.062 2.062 0 1 1 0-4.124 2.062 2.062 0 0 1 0 4.124ZM7.119 20.452H3.555V9h3.564v11.452ZM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003Z',
  source: 'https://www.linkedin.com/',
  guidelines: 'https://brand.linkedin.com/',
};

const icons: Record<string, SimpleIcon> = {
  airbnb: siAirbnb,
  bluesky: siBluesky,
  facebook: siFacebook,
  google: siGoogle,
  google_business: siGoogle,
  instagram: siInstagram,
  linkedin,
  mastodon: siMastodon,
  messenger: siMessenger,
  meta: siMeta,
  n8n: siN8n,
  pinterest: siPinterest,
  quickbooks: siQuickbooks,
  reddit: siReddit,
  shopee: siShopee,
  shopify: siShopify,
  telegram: siTelegram,
  threads: siThreads,
  tiktok: siTiktok,
  whatsapp: siWhatsapp,
  x: siX,
  youtube: siYoutube,
};

const siteMarks: Record<string, string> = {
  highlevel: 'https://www.gohighlevel.com/favicon.ico',
  lazada: 'https://www.lazada.com.ph/favicon.ico',
};

export function ServiceIcon({ service, label, className = '' }: { service: string; label?: string; className?: string }) {
  const key = service.trim().toLowerCase().replaceAll(' ', '_');
  const icon = icons[key];
  const title = label || icon?.title || service;
  const classes = `service-icon ${className}`.trim();
  if (icon) {
    return (
      <svg className={classes} viewBox="0 0 24 24" role="img" aria-label={title} style={{ '--service-color': `#${icon.hex}` } as CSSProperties}>
        <path d={icon.path} />
      </svg>
    );
  }
  if (siteMarks[key]) return <img className={classes} src={siteMarks[key]} alt={`${title} logo`} referrerPolicy="no-referrer" />;
  return <span className={`${classes} service-icon--fallback`} aria-label={title}>{title.charAt(0).toUpperCase()}</span>;
}

export function serviceBrandColor(service: string) {
  return `#${icons[service.trim().toLowerCase().replaceAll(' ', '_')]?.hex || '59645D'}`;
}
