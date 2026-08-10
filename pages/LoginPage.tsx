import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.87h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.35Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.97-.9 6.62-2.42l-3.24-2.51c-.9.6-2.04.96-3.38.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.59A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.39 13.9A6.01 6.01 0 0 1 6.07 12c0-.66.11-1.3.32-1.9V7.51H3.04A10 10 0 0 0 2 12c0 1.61.38 3.14 1.04 4.49l3.35-2.59Z" />
      <path fill="#EA4335" d="M12 5.97c1.47 0 2.78.5 3.82 1.49l2.87-2.87A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.51l3.35 2.59C7.18 7.73 9.39 5.97 12 5.97Z" />
    </svg>
  );
}

export function LoginPage() {
  const { configured, error, loading, signInWithEmail, signInWithGoogle, user, workspace, signOut } = useAuth();
  const [submitting, setSubmitting] = useState<'email' | 'google' | ''>('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const location = useLocation();
  const destination = new URLSearchParams(location.search).get('next') || '/app';

  if (!loading && user && workspace) return <Navigate to={destination} replace />;

  const beginGoogleSignIn = async () => {
    setSubmitting('google');
    setLocalError('');
    try {
      await signInWithGoogle();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : 'Google sign-in could not be started.');
      setSubmitting('');
    }
  };

  const beginEmailSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting('email');
    setLocalError('');
    try {
      await signInWithEmail(email, password);
    } catch {
      setLocalError('Email or password is incorrect.');
      setSubmitting('');
    }
  };

  return (
    <main className="login-page">
      <section className="login-story" aria-labelledby="login-title">
        <Link className="login-brand" to="/">
          <img src="/assets/brand/orin-mascot-original.webp" alt="" />
          <span>ORIN AI</span>
        </Link>
        <div className="login-story__copy">
          <p>One front desk. Built around your business.</p>
          <h1 id="login-title">Shape the AI your customers will meet.</h1>
          <ul>
            <li><Check aria-hidden="true" /> Teach it from approved business knowledge</li>
            <li><Check aria-hidden="true" /> Set its voice, languages, and operating rules</li>
            <li><Check aria-hidden="true" /> Connect channels and see every conversation</li>
          </ul>
        </div>
        <p className="login-story__footer">ORIN AI by IDRA</p>
      </section>

      <section className="login-access" aria-label="Sign in to ORIN AI">
        <Link className="login-back" to="/"><ArrowLeft aria-hidden="true" /> Back to orin.work</Link>
        <div className="login-card">
          <span className="login-card__eyebrow">Your workspace</span>
          <h2>Sign in.</h2>
          <p>Use your invited email and password, or continue with Google.</p>

          <form className="login-email-form" onSubmit={beginEmailSignIn}>
            <label>
              <span>Email</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} autoComplete="username" required maxLength={254} />
            </label>
            <label>
              <span>Password</span>
              <input type="password" value={password} onChange={(event) => setPassword(event.currentTarget.value)} autoComplete="current-password" required maxLength={4096} />
            </label>
            <button type="submit" disabled={!configured || Boolean(submitting) || loading}>
              {submitting === 'email' ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null}
              <span>{submitting === 'email' ? 'Signing in…' : 'Sign in'}</span>
            </button>
          </form>

          <div className="login-divider"><span>or</span></div>

          <button className="google-signin" type="button" onClick={beginGoogleSignIn} disabled={!configured || Boolean(submitting) || loading}>
            {submitting === 'google' || loading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <GoogleMark />}
            <span>{loading ? 'Checking your account…' : submitting === 'google' ? 'Opening Google…' : 'Continue with Google'}</span>
          </button>

          {!configured && (
            <p className="login-card__notice" role="status">Account setup is being connected. The public ORIN AI experience remains available.</p>
          )}
          {(localError || error) && <p className="login-card__error" role="alert">{localError || error}</p>}
          {!loading && user && !workspace && <button className="login-signout" type="button" onClick={() => void signOut()}>Use another Google account</button>}

          <small>By continuing, you acknowledge the ORIN AI <Link to="/#privacy">privacy policy</Link>.</small>
        </div>
      </section>
    </main>
  );
}
