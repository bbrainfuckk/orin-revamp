type SiteFooterProps = {
  onPrivacy: () => void;
};

export function SiteFooter({ onPrivacy }: SiteFooterProps) {
  return (
    <footer id="footer" className="site-footer">
      <div className="site-footer__brand">
        <img src="/assets/brand/orin-mascot-original.webp" alt="" />
        <div>
          <strong>ORIN AI <span>by IDRA</span></strong>
          <p>Intelligence Design &amp; Revenue Automation</p>
        </div>
      </div>

      <div className="site-footer__meta">
        <p>© 2026 IDRA. All rights reserved.</p>
        <a href="https://marvin.orin.work">by Marvin Sarreal Villanueva</a>
        <button type="button" onClick={onPrivacy}>Privacy policy</button>
      </div>
    </footer>
  );
}
