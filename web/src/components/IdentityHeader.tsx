import type { ConnectionState, IdentityView } from '../types.js';

export function IdentityHeader(props: {
  identity: IdentityView | null;
  connection: ConnectionState;
  openInvite(): void;
}) {
  const status = props.connection === 'live' ? 'Live' : props.connection === 'retrying' ? 'Reconnecting' : 'Connecting';
  return (
    <header className="identity-header">
      <div className="brand"><span className="brand-mark">ours</span><span className="brand-product">messenger</span></div>
      <div className="identity-block">
        <strong>{props.identity?.name ?? 'Connecting…'}</strong>
        <span className="identity-cid">{props.identity?.cid ? `${props.identity.cid.slice(0, 12)}…` : ''}</span>
      </div>
      <span className={`connection connection-${props.connection}`} role="status">{status}</span>
      <button type="button" className="primary compact" onClick={props.openInvite}>Add contact</button>
    </header>
  );
}
