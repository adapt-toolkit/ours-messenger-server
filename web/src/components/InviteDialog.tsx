import { useEffect, useRef, useState } from 'react';
import type { InviteView } from '../types.js';

export function InviteDialog(props: {
  generated: string | null;
  invites: readonly InviteView[];
  busy: boolean;
  error: string | null;
  onClose(): void;
  onCreate(mode: 'one_time' | 'public'): void;
  onRevoke(inviteId: string): void;
  onAccept(invite: string, name: string): void;
}) {
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [mode, setMode] = useState<'one_time' | 'public'>('one_time');
  const createButton = useRef<HTMLButtonElement>(null);
  useEffect(() => createButton.current?.focus(), []);

  return (
    <div className="dialog-cover" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title">
        <div className="dialog-top">
          <h2 id="contact-dialog-title">Add a contact</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <p className="muted">Create an invite to share, or accept one you received.</p>
        <label className="field-label">Invite type
          <select className="field" value={mode} onChange={(event) => setMode(event.target.value as 'one_time' | 'public')}>
            <option value="one_time">One-time</option>
            <option value="public">Reusable public invite</option>
          </select>
        </label>
        <button ref={createButton} type="button" className="primary wide" disabled={props.busy} onClick={() => props.onCreate(mode)}>
          {props.busy ? 'Working…' : mode === 'public' ? 'Create reusable invite' : 'Create one-time invite'}
        </button>
        {mode === 'public' && <p className="muted">Reusable invites do not expire. Revoke them here when you stop sharing.</p>}
        {props.generated && (
          <textarea className="invite-output" readOnly value={props.generated} aria-label="Generated invite" />
        )}
        {props.invites.length > 0 && (
          <div className="active-invites">
            <h3>Active invites</h3>
            {props.invites.map((item) => (
              <div className="active-invite" key={item.invite_id}>
                <span>{item.mode === 'public' ? 'Reusable' : 'One-time'} · {item.invite_id.slice(0, 10)}…</span>
                <button type="button" className="secondary compact" disabled={props.busy} onClick={() => props.onRevoke(item.invite_id)}>Revoke</button>
              </div>
            ))}
          </div>
        )}
        <div className="divider">or accept an invite</div>
        <input
          className="field"
          placeholder="Contact name (optional)"
          aria-label="Contact name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          className="field invite-input"
          placeholder="Paste invite"
          aria-label="Invite"
          value={invite}
          onChange={(event) => setInvite(event.target.value)}
        />
        <button
          type="button"
          className="secondary wide"
          disabled={props.busy}
          onClick={() => props.onAccept(invite.trim(), name.trim())}
        >
          Accept invite
        </button>
        {props.error && <p className="error" role="alert">{props.error}</p>}
      </section>
    </div>
  );
}
