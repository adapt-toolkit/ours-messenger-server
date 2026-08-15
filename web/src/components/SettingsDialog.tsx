import type { IdentityTreeRow, IdentityView, PushState } from '../types.js';

export function SettingsDialog(props: {
  identity: IdentityView | null;
  identities: readonly IdentityTreeRow[];
  push: PushState;
  workerSupported: boolean;
  offline: boolean;
  updateAvailable: boolean;
  busy: boolean;
  onTogglePush(enable: boolean): void;
  onReloadUpdate(): void;
  onClose(): void;
}) {
  return (
    <div className="dialog-cover" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <section className="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-top">
          <div><h2 id="settings-title">Messenger settings</h2><p className="muted settings-subtitle">This server acts as one explicitly bound identity.</p></div>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={props.onClose}>×</button>
        </div>

        <section className="settings-section">
          <h3>Identities</h3>
          <p className="muted">Human/root and agent identities share a verified hierarchy. Switching remains an operator action so this server never silently rebinds its live watcher.</p>
          <div className="identity-tree">
            {props.identities.map((identity) => (
              <div className={`identity-row identity-${identity.kind}`} key={identity.cid}>
                <span className="avatar" aria-hidden="true">{identity.kind === 'root' ? 'H' : 'A'}</span>
                <span><strong>{identity.name}</strong><small>{identity.kind === 'root' ? 'Human identity' : identity.kind === 'role' ? 'Agent identity' : 'Legacy identity'} · {identity.cid.slice(0, 12)}…</small></span>
                {identity.cid === props.identity?.cid && <span className="current-pill">Active</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Web Push</h3>
          <p className="muted">
            Opt in to receive the full message text or file/voice label. Web Push encrypts payloads to this browser, but the push provider still sees delivery metadata and your device may show decrypted text on its lock screen. This is not ours end-to-end transport.
          </p>
          {!props.workerSupported && <p className="error">Push requires a secure browser context with service-worker support.</p>}
          {props.push === 'blocked' && <p className="error">Notifications are blocked in browser settings.</p>}
          <button
            type="button"
            className={props.push === 'subscribed' ? 'secondary' : 'primary'}
            disabled={props.busy || !props.workerSupported || props.push === 'unsupported' || props.push === 'blocked'}
            onClick={() => props.onTogglePush(props.push !== 'subscribed')}
          >
            {props.busy ? 'Updating…' : props.push === 'subscribed' ? 'Disable notifications' : 'Enable notifications'}
          </button>
        </section>

        <section className="settings-section">
          <h3>App status</h3>
          <p className="muted">{props.offline ? 'Offline shell active. Messages and identity data are never cached.' : 'Online.'}</p>
          {props.updateAvailable && <button type="button" className="primary" onClick={props.onReloadUpdate}>Reload to update</button>}
        </section>
      </section>
    </div>
  );
}
