import { useEffect } from 'react';

type PrivacyPolicyProps = {
  open: boolean;
  onClose: () => void;
};

export function PrivacyPolicy({ open, onClose }: PrivacyPolicyProps) {
  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="privacy-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <article className="privacy-dialog" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
        <header className="privacy-dialog__header">
          <div>
            <span>ORIN AI by IDRA</span>
            <h2 id="privacy-title">Privacy policy</h2>
          </div>
          <button type="button" onClick={onClose} autoFocus aria-label="Close privacy policy">×</button>
        </header>

        <div className="privacy-dialog__body">
          <p className="privacy-updated">Last updated: July 15, 2026</p>
          <p>
            This policy explains what the ORIN AI website handles when you visit orin.work.
            It covers this website, not a client's separate ORIN AI deployment.
          </p>

          <section>
            <h3>Who is responsible</h3>
            <p>
              ORIN AI is a product of IDRA, Intelligence Design &amp; Revenue Automation,
              led by Marvin Sarreal Villanueva in the Philippines.
            </p>
          </section>

          <section>
            <h3>What this website handles</h3>
            <ul>
              <li>Hosting systems may receive basic request data such as your IP address, browser, device type, requested page, and request time to deliver and protect the site.</li>
              <li>The ROI calculator runs in your browser. The values you enter are not sent to ORIN AI or stored by this website.</li>
              <li>The floating chat on this page uses local, prewritten answers. Its messages stay in the current browser session and clear when you refresh.</li>
              <li>If you contact Marvin or book a walkthrough through a linked page, that page may collect the details you choose to submit.</li>
            </ul>
          </section>

          <section>
            <h3>Why data may be used</h3>
            <p>
              Technical request data may be used to deliver the site, prevent abuse, diagnose failures,
              and maintain security. Contact details you choose to send may be used to answer your request
              and discuss an ORIN AI setup.
            </p>
          </section>

          <section>
            <h3>Sharing and retention</h3>
            <p>
              IDRA does not sell personal data and this site does not use advertising trackers. Technical
              data may be processed by hosting and security providers that operate the site, or disclosed
              when required by law. Information is kept only as long as needed for its stated purpose,
              security, or legal obligations.
            </p>
          </section>

          <section>
            <h3>Your choices and rights</h3>
            <p>
              Under the Philippine Data Privacy Act of 2012, data subjects may have rights to be informed,
              access personal data, object to processing, correct inaccurate data, request erasure or blocking,
              and file a complaint with the National Privacy Commission.
            </p>
            <p>
              To ask about data connected with this website, contact IDRA through
              {' '}<a href="https://marvin.orin.work">Marvin's contact page</a>. You may also read the
              {' '}<a href="https://privacy.gov.ph/data-subject-rights/" target="_blank" rel="noreferrer">National Privacy Commission's guide to data-subject rights</a>.
            </p>
          </section>

          <section>
            <h3>Client deployments</h3>
            <p>
              A business that deploys ORIN AI remains responsible for telling its customers how that specific
              deployment handles personal data. Its contract, channel permissions, retention rules, and privacy
              notice apply separately from this website policy.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
}
