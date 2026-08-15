import { useEffect, useRef, useState } from 'react';

export function InviteDialog(props: {
  generated: string | null;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onCreate(): void;
  onAccept(invite: string, name: string): void;
}) {
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
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
        <button ref={createButton} type="button" className="primary wide" disabled={props.busy} onClick={props.onCreate}>
          {props.busy ? 'Working…' : 'Create one-time invite'}
        </button>
        {props.generated && (
          <textarea className="invite-output" readOnly value={props.generated} aria-label="Generated invite" />
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
