import type { CSSProperties, ReactNode } from 'react';

type Platform = {
  name: string;
  color: string;
  icon: ReactNode;
};

const iconClass = 'platform-card__icon';

const platforms: Platform[] = [
  {
    name: 'Facebook',
    color: '#1877f2',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 8.1h3.1V4.3c-.5-.1-2.4-.2-4.5-.2-4.4 0-7.4 2.7-7.4 7.6V16H2v4.3h3.4V24h4.2v-3.7h3.5l.6-4.3H9.6v-3.9c0-2.5.7-4 4.6-4Z" /></svg>,
  },
  {
    name: 'Messenger',
    color: '#00b2ff',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C6.35 2 2 5.87 2 10.88c0 2.72 1.26 5.07 3.25 6.7V22l3.43-1.88c1.02.28 2.13.43 3.32.43 5.65 0 10-3.87 10-8.88S17.65 2 12 2Zm1.05 11.62-2.54-2.7-4.96 2.7L11 7.83l2.56 2.7 4.94-2.7-5.45 5.79Z" /></svg>,
  },
  {
    name: 'Instagram',
    color: '#e1306c',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M7.1 2h9.8A5.1 5.1 0 0 1 22 7.1v9.8a5.1 5.1 0 0 1-5.1 5.1H7.1A5.1 5.1 0 0 1 2 16.9V7.1A5.1 5.1 0 0 1 7.1 2Zm-.18 2A2.92 2.92 0 0 0 4 6.92v10.16A2.92 2.92 0 0 0 6.92 20h10.16A2.92 2.92 0 0 0 20 17.08V6.92A2.92 2.92 0 0 0 17.08 4H6.92ZM12 7.14A4.86 4.86 0 1 1 12 16.86 4.86 4.86 0 0 1 12 7.14Zm0 2A2.86 2.86 0 1 0 12 14.86 2.86 2.86 0 0 0 12 9.14Zm6.42-2.25a1.17 1.17 0 1 1-2.34 0 1.17 1.17 0 0 1 2.34 0Z" /></svg>,
  },
  {
    name: 'TikTok',
    color: '#fe2c55',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.4 2c.2 1.7 1.2 3.2 2.7 4.1a7 7 0 0 0 3.4 1v3.6a10.5 10.5 0 0 1-6.1-2.1v7.1a6.2 6.2 0 1 1-5.3-6.1v3.7a2.6 2.6 0 1 0 1.7 2.4V2h3.6Z" /></svg>,
  },
  {
    name: 'Airbnb',
    color: '#ff5a5f',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M12 2.25c1.45 0 2.26 1.26 2.92 2.75l4.33 9.75c.84 1.9.05 4.17-1.82 5.1-1.84.9-4.06.18-5.02-1.62L12 17.45l-.41.78a3.92 3.92 0 0 1-5.02 1.62 3.92 3.92 0 0 1-1.82-5.1L9.08 5C9.74 3.51 10.55 2.25 12 2.25Zm0 3.12c-.2.27-.49.79-.82 1.54L9.9 9.78c.54-.19 1.15-.3 1.78-.3h.64c.63 0 1.24.11 1.78.3l-1.28-2.87c-.33-.75-.62-1.27-.82-1.54Zm0 9.16c.69-1.07 1.41-1.84 2.18-2.25-.52-.36-1.18-.55-1.86-.55h-.64c-.68 0-1.34.19-1.86.55.77.41 1.49 1.18 2.18 2.25Zm-3.2-.3-1.99 1.45a1.66 1.66 0 0 0 .77 2.2c.79.39 1.75.09 2.16-.69l.8-1.5c-.63-.91-1.21-1.4-1.74-1.46Zm6.4 0c-.53.06-1.11.55-1.74 1.46l.8 1.5c.41.78 1.37 1.08 2.16.69.81-.4 1.16-1.38.77-2.2l-1.99-1.45Z" /></svg>,
  },
  {
    name: 'Shopee',
    color: '#ee4d2d',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path fillRule="evenodd" d="M8.25 6V5a3.75 3.75 0 0 1 7.5 0v1h2.85l2.1 15H3.3L5.4 6h2.85Zm2 0h3.5V5a1.75 1.75 0 0 0-3.5 0v1Zm1.58 4c-1.72 0-3.08.92-3.08 2.42 0 1.38.99 2 2.62 2.55 1.1.37 1.43.63 1.43 1.1 0 .5-.47.82-1.18.82-.82 0-1.54-.35-2.12-.92l-1.2 1.38a4.6 4.6 0 0 0 3.27 1.23c1.9 0 3.28-.94 3.28-2.6 0-1.36-.84-2.04-2.6-2.64-1.15-.39-1.48-.61-1.48-1.03 0-.42.4-.68 1.04-.68.68 0 1.27.28 1.85.74l1.03-1.5A4.47 4.47 0 0 0 11.83 10Z" /></svg>,
  },
  {
    name: 'Lazada',
    color: '#f57224',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Zm-3 5.3v8.95h6.35v-2.1h-3.9V7.3H9Z" /></svg>,
  },
  {
    name: 'Shopify',
    color: '#95bf47',
    icon: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.2 3.8c-.2-.05-.45.03-.63.2-.18.17-.35.36-.5.57-.54-1.56-1.46-2.37-2.74-2.37-.12 0-.24.01-.36.03C11.45 1.54 10.8 1.2 10.02 1.2c-2.32 0-3.43 2.9-3.78 4.38L3.7 6.36 2.5 20.55 17.76 23l3.74-1.87L19.45 4.7l-3.25-.9Zm-4.22.1h.2c.7 0 1.17.5 1.5 1.48l-2.3.72c.16-.74.37-1.55.6-2.2Zm-1.94-.97c.29 0 .53.1.73.3-.73.92-1.18 2.25-1.4 3.5l-1.82.57c.4-1.77 1.28-4.37 2.49-4.37Zm1.17 9.03c-.75-.4-1.62-.7-1.62-1.45 0-.57.52-.94 1.33-.94.94 0 1.78.4 1.78.4l.67-2.03s-.62-.5-2.41-.5c-2.5 0-4.22 1.43-4.22 3.45 0 1.16.82 2.04 1.93 2.68.9.52 1.23.9 1.23 1.44 0 .57-.46 1-1.3 1-1.2 0-2.34-.62-2.34-.62l-.72 2.03s1.05.7 2.82.7c2.57 0 4.4-1.26 4.4-3.55 0-1.23-.95-2.1-1.55-2.43v-.18Zm4.38-6.14.36-.11 1.13-.35 1.32.33 1.8 14.45-4.61 2.3V5.82Z" /></svg>,
  },
];

function PlatformCard({ platform, duplicate = false }: { platform: Platform; duplicate?: boolean }) {
  const style = { '--platform-color': platform.color } as CSSProperties;
  return (
    <div className="platform-card" style={style} role={duplicate ? undefined : 'listitem'} aria-hidden={duplicate || undefined}>
      <span className={iconClass}>{platform.icon}</span>
      <span>{platform.name}</span>
    </div>
  );
}

export function PlatformRail() {
  return (
    <section id="channels" className="platform-section" aria-labelledby="platform-title">
      <div className="platform-shell">
        <header className="platform-heading">
          <span className="platform-eyebrow">More than Messenger</span>
          <h2 id="platform-title">One front desk.<br />Every channel.</h2>
          <p>
            ORIN AI meets customers on the apps they already use. Orin keeps the answers
            consistent and brings your team in when the conversation needs a person.
          </p>
        </header>

        <div className="platform-flow" role="list" aria-label="Channels supported by ORIN AI">
          <div className="platform-flow__track">
            <div className="platform-flow__group">
              {platforms.map((platform) => <PlatformCard key={platform.name} platform={platform} />)}
            </div>
            <div className="platform-flow__group" aria-hidden="true" inert>
              {platforms.map((platform) => <PlatformCard key={`duplicate-${platform.name}`} platform={platform} duplicate />)}
            </div>
          </div>
          <div className="platform-flow__signal" aria-hidden="true">
            <img src="/assets/brand/orin-mascot-original.webp" alt="" />
            <span>ORIN AI</span>
          </div>
        </div>

        <p className="platform-note">Facebook · Messenger · Instagram · TikTok · Airbnb · Shopee · Lazada · Shopify</p>
      </div>
    </section>
  );
}
