import type { CSSProperties } from 'react';
import { ServiceIcon, serviceBrandColor } from './ServiceIcon';

type Platform = {
  id: string;
  name: string;
};

const iconClass = 'platform-card__icon';

const platforms: Platform[] = [
  { id: 'facebook', name: 'Facebook' },
  { id: 'messenger', name: 'Messenger' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'airbnb', name: 'Airbnb' },
  { id: 'shopee', name: 'Shopee' },
  { id: 'lazada', name: 'Lazada' },
  { id: 'shopify', name: 'Shopify' },
];

function PlatformCard({ platform, duplicate = false }: { platform: Platform; duplicate?: boolean }) {
  const style = { '--platform-color': serviceBrandColor(platform.id) } as CSSProperties;
  return (
    <div className="platform-card" style={style} role={duplicate ? undefined : 'listitem'} aria-hidden={duplicate || undefined}>
      <span className={iconClass}><ServiceIcon service={platform.id} label={platform.name} /></span>
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
