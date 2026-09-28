import { useEffect, useState, type ReactNode } from 'react';
import { fleet, setCsrf } from './live-api';
export function LocalLogin({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const admit = (session: { csrfToken: string }) => { setCsrf(session.csrfToken); setReady(true); };
  useEffect(() => {
    const expired = () => { setReady(false); setError('Session expired. Sign in again.'); };
    addEventListener('fleet-session-expired', expired);
    fleet('/auth/session').then(admit).catch(() => fleet('/auth/resume', {}).then(admit)).catch(() => {}).finally(() => setChecking(false));
    return () => removeEventListener('fleet-session-expired', expired);
  }, []);
  if (checking) return <div className="centered-screen">Connecting to Fleet…</div>;
  if (ready) return <>{children}</>;
  return <main className="centered-screen"><form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { admit(await fleet('/auth/login', { password })); setPassword(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }}><h1>Sign in to Fleet</h1><p>Use the password for this local instance.</p><label>Password<input className="field" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label><button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>{error && <p role="alert">{error}</p>}</form></main>;
}
