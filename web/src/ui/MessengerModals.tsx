import { useEffect, useRef, useState } from 'react';
import type { BuildInfoView, IdentityView, InviteView, PushPreviewMode, PushView } from '../types.js';
import { pushGuidance } from '../pwa.js';
import DialogShell from './DialogShell.js';
import { Icon } from './icons.js';
import { QRDisplay } from './QRDisplay.js';
import { QRScanner } from './QRScanner.js';
import { fmtFull, shortCid } from './viewmodel.js';

export function InviteModal(props: {
  identity: IdentityView;
  invites: readonly InviteView[];
  onCreate(mode: 'one_time' | 'public', name?: string): Promise<string>;
  onAccept(invite: string, name?: string): Promise<void>;
  onRevoke(id: string): Promise<void>;
  onRefresh(): Promise<void>;
  onClose(): void;
}) {
  const [tab, setTab] = useState<'generate' | 'accept'>('generate');
  const [kind, setKind] = useState<'one_time' | 'public'>('one_time');
  const [peerName, setPeerName] = useState('');
  const [inviteText, setInviteText] = useState<string | null>(null);
  const [resultKind, setResultKind] = useState<'one_time' | 'public'>('one_time');
  const [pasted, setPasted] = useState('');
  const [renameTo, setRenameTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const busyRef = useRef(false);

  const create = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setNote(null);
    try {
      setResultKind(kind);
      setInviteText(await props.onCreate(kind, kind === 'one_time' ? peerName.trim() || undefined : undefined));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const tabs = (
    <div className="modal-tabs" role="tablist" aria-label="Invite mode">
      <button type="button" role="tab" aria-selected={tab === 'generate'} className={'btn sm' + (tab === 'generate' ? ' primary' : '')} onClick={() => setTab('generate')}>Generate invite</button>
      <button type="button" role="tab" aria-selected={tab === 'accept'} className={'btn sm' + (tab === 'accept' ? ' primary' : '')} onClick={() => setTab('accept')}>Accept invite</button>
    </div>
  );

  return (
    <DialogShell title={tab === 'generate' ? 'Invite a contact' : 'Accept an invite'} onClose={() => { if (!busyRef.current) props.onClose(); }} tabs={tabs}>
      {tab === 'generate' && !inviteText && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
          <p className="muted" data-testid="invite-identity" style={{ margin: 0, fontSize: '0.85rem' }}>Creating as <strong>{props.identity.name}</strong> · <span className="mono">@{shortCid(props.identity.cid)}</span></p>
          <div role="radiogroup" aria-label="Invite kind" style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            <label><input type="radio" name="invite-kind" checked={kind === 'one_time'} onChange={() => setKind('one_time')} /> One person (one time)</label>
            <label><input type="radio" name="invite-kind" checked={kind === 'public'} onChange={() => setKind('public')} /> Reusable public invite</label>
          </div>
          {kind === 'one_time' ? (
            <><p className="muted" style={{ margin: 0, fontSize: '0.9rem' }}>Optionally name the person or agent this invite is for.</p><input className="field" value={peerName} onChange={(event) => setPeerName(event.target.value)} placeholder="Their name (optional), e.g. Bob" maxLength={64} /></>
          ) : (
            <p className="onb-warning" data-testid="public-invite-warning" style={{ margin: 0, fontSize: '0.9rem' }}>Anyone with this invite can connect until you revoke it. It has no expiry and stays valid across server restarts.</p>
          )}
          <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy} onClick={() => void create()}>{busy ? 'Generating…' : kind === 'public' ? 'Create public invite' : 'Generate invite'}</button>
          {kind === 'public' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <h4 style={{ margin: 0, fontSize: '0.9rem' }}>Active reusable invites</h4>
            {props.invites.filter((item) => item.mode === 'public').length === 0 && <p className="muted" style={{ margin: 0 }}>None right now.</p>}
            {props.invites.filter((item) => item.mode === 'public').map((item) => <div key={item.invite_id} data-testid="public-invite-row" style={{ padding: '8px 10px', background: 'var(--inset)', borderRadius: 7 }}>
              <span className="mono">{item.invite_id}</span><p className="muted">Created {item.created ? fmtFull(item.created) : 'unknown'} · Active until revoked · No expiry</p>
              {confirmRevoke === item.invite_id ? <span><button className="btn sm danger" onClick={() => void props.onRevoke(item.invite_id).then(() => { setConfirmRevoke(null); return props.onRefresh(); }).catch((reason) => setError(String(reason)))}>Confirm revoke</button> <button className="btn sm" onClick={() => setConfirmRevoke(null)}>Keep it</button></span> : <button className="btn sm" onClick={() => setConfirmRevoke(item.invite_id)}>Revoke</button>}
            </div>)}
          </div>}
          {note && <p className="muted">{note}</p>}{error && <p className="onb-error">{error}</p>}
        </div>
      )}
      {tab === 'generate' && inviteText && <>
        <p className="muted" data-testid={resultKind === 'public' ? 'public-result-note' : undefined}>{resultKind === 'public' ? 'Shown only on this screen. Copy it now; the text cannot be recovered later. The invite stays active until revoked.' : `Send this invite to ${peerName.trim() || 'your contact'}. It can be redeemed once.`}</p>
        <textarea className="field mono" data-testid="invite-result-text" readOnly rows={5} value={inviteText} onFocus={(event) => event.currentTarget.select()} />
        {resultKind === 'one_time' && <QRDisplay text={inviteText} />}
        <button className="btn primary" onClick={() => void navigator.clipboard.writeText(inviteText).then(() => setNote('Copied to clipboard.'))}><Icon name="copy" size={15} />Copy invite</button>
        {resultKind === 'public' && <button className="btn" data-testid="done-hide-invite" onClick={() => { setInviteText(null); setPeerName(''); void props.onRefresh(); }}>Done — hide invite</button>}
        {note && <p className="muted">{note}</p>}
      </>}
      {tab === 'accept' && <form style={{ display: 'flex', flexDirection: 'column', gap: 13 }} onSubmit={(event) => { event.preventDefault(); if (!pasted.trim() || busy) return; setBusy(true); setError(null); void props.onAccept(pasted.trim(), renameTo.trim() || undefined).then(() => { setNote('Invite accepted — the contact will appear once the sender verifies your identity.'); setPasted(''); setRenameTo(''); }).catch((reason) => setError(String(reason))).finally(() => setBusy(false)); }}>
        <p className="muted">Paste the invite you received, or scan a QR code.</p>
        {scanning ? <QRScanner onDecode={(text) => { setPasted(text); setScanning(false); }} onClose={() => setScanning(false)} /> : <button type="button" className="btn" onClick={() => setScanning(true)}><Icon name="monitor" size={15} />Scan QR code</button>}
        <textarea className="field mono" aria-label="Invite" rows={5} value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste invite text…" />
        <input className="field" value={renameTo} onChange={(event) => setRenameTo(event.target.value)} placeholder="Rename them (optional)" maxLength={64} />
        <button className="btn primary" type="submit" disabled={busy || !pasted.trim()}>{busy ? 'Connecting…' : 'Add contact'}</button>
        {note && <p className="muted">{note}</p>}{error && <p className="onb-error">{error}</p>}
      </form>}
    </DialogShell>
  );
}

export function SettingsModal(props: {
  identity: IdentityView;
  push: PushView;
  workerSupported: boolean;
  busy: boolean;
  offline: boolean;
  updateAvailable: boolean;
  build: BuildInfoView | null;
  dark: boolean;
  onToggleDark(): void;
  onSaveBio(bio: string): Promise<void>;
  onPushAction(action: 'enable' | 'disable' | 'repair', preview?: PushPreviewMode): Promise<void>;
  onReloadUpdate(): void;
  onClose(): void;
}) {
  const [bio, setBio] = useState(props.identity.bio ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PushPreviewMode>(props.push.preview);
  const guidance = pushGuidance();
  const pushCopy = !props.workerSupported || props.push.status === 'unsupported' ? guidance ?? 'Unavailable — requires a secure browser with service-worker support.'
    : props.push.status === 'needs-permission' ? guidance ?? 'Needs permission — allow notifications, then choose Enable or Repair.'
      : props.push.status === 'on' ? 'On — this browser and the server agree on the current Web Push configuration.'
        : props.push.status === 'repairing' ? 'Repairing — checking the browser subscription and server acknowledgement…'
          : props.push.status === 'error' ? 'Repair needed — the browser and server could not confirm the same subscription.'
            : 'Off — enable notifications for this browser.';
  return <DialogShell title="Settings" onClose={props.onClose} wide>
    <div><span className="lbl">Display name</span><input className="field" readOnly value={props.identity.name} /></div>
    <div><span className="lbl">Your address</span><input className="field mono" readOnly value={props.identity.cid} onFocus={(event) => event.currentTarget.select()} /><p className="muted">Your public address on ours. Share an invite to connect more easily.</p></div>
    <div><span className="lbl">Public bio</span><textarea className="field" rows={3} value={bio} onChange={(event) => { setBio(event.target.value); setSaved(false); setError(null); }} /><button className="btn sm" onClick={() => { setError(null); void props.onSaveBio(bio).then(() => setSaved(true)).catch((reason) => setError(String(reason))); }}>{saved ? 'Saved' : 'Save bio'}</button>{error && <p className="onb-error">{error}</p>}</div>
    <label style={{ display: 'flex', gap: 9 }}><input type="checkbox" checked={props.dark} onChange={props.onToggleDark} /> Dark mode</label>
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h4>Notifications</h4>
      <p className={props.push.status === 'needs-permission' || props.push.status === 'error' ? 'onb-error' : 'muted'}>{pushCopy}</p>
      {guidance && guidance !== pushCopy && <p className="muted" data-testid="push-platform-guidance">{guidance}</p>}
      <fieldset style={{ border: 0, padding: 0, margin: '12px 0' }}>
        <legend className="lbl">Lock-screen preview</legend>
        <label style={{ display: 'block', marginTop: 7 }}><input type="radio" name="push-preview" checked={preview === 'full'} onChange={() => setPreview('full')} /> Full — sender and message text or filename</label>
        <label style={{ display: 'block', marginTop: 7 }}><input type="radio" name="push-preview" checked={preview === 'private'} onChange={() => setPreview('private')} /> Private — generic content only</label>
      </fieldset>
      <p className="muted">Full previews can expose sender names, message text, and filenames on the lock screen. The push provider still sees delivery endpoint, timing, and payload size metadata in either mode.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {props.push.status === 'on'
          ? <><button className="btn" disabled={props.busy} onClick={() => void props.onPushAction('disable', preview)}>Disable notifications</button><button className="btn" disabled={props.busy} onClick={() => void props.onPushAction('repair', preview)}>Repair</button>{preview !== props.push.preview && <button className="btn primary" disabled={props.busy} onClick={() => void props.onPushAction('enable', preview)}>Save preview</button>}</>
          : <button className="btn primary" disabled={props.busy || !props.workerSupported || props.push.status === 'unsupported'} onClick={() => void props.onPushAction(props.push.status === 'error' || props.push.blocked ? 'repair' : 'enable', preview)}>{props.busy ? 'Repairing…' : props.push.status === 'error' || props.push.blocked ? 'Repair' : 'Enable notifications'}</button>}
      </div>
    </div>
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}><h4>App status</h4><p className="muted">{props.offline ? 'Offline shell active. Message and identity data are never cached.' : 'Online.'}</p>{props.updateAvailable && <button className="btn primary" onClick={props.onReloadUpdate}>Reload to update</button>}</div>
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}><h4>Build</h4><input className="field mono" readOnly value={props.build ? `${props.build.version} · ${props.build.sha}` : 'Loading…'} /></div>
  </DialogShell>;
}
