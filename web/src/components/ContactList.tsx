import type { ContactView, PendingContactView } from '../types.js';
import type { AppState } from '../store.js';
import { pageFor } from '../store.js';

export function ContactList(props: {
  state: AppState;
  selected: string | null;
  onQuery(query: string): void;
  onSelect(cid: string): void;
  onAdd(): void;
  onIntroduction(contact: PendingContactView, action: 'approve' | 'reject'): void;
}) {
  const query = props.state.search.trim().toLocaleLowerCase();
  const visible = props.state.contacts.contacts.filter((contact) =>
    !query || contact.name.toLocaleLowerCase().includes(query));

  return (
    <aside className="contact-rail" aria-label="Conversations">
      <div className="rail-tools">
        <input
          className="search"
          type="search"
          placeholder="Search conversations"
          aria-label="Search conversations"
          value={props.state.search}
          onChange={(event) => props.onQuery(event.target.value)}
        />
        <button type="button" className="icon-button" aria-label="Add contact" onClick={props.onAdd}>+</button>
      </div>
      {props.state.contacts.pending.length > 0 && (
        <section className="pending-introductions" aria-label="Pending contact requests">
          <h2>Contact requests</h2>
          {props.state.contacts.pending.map((contact) => (
            <PendingContact key={contact.container_id} contact={contact} onAction={props.onIntroduction} />
          ))}
        </section>
      )}
      <div className="contacts" role="listbox" aria-label="Conversation list">
        {visible.map((contact) => (
          <ContactRow
            key={contact.container_id}
            contact={contact}
            selected={props.selected === contact.container_id}
            unread={pageFor(props.state, contact.container_id)?.unread ?? 0}
            onSelect={props.onSelect}
          />
        ))}
        {visible.length === 0 && <p className="empty-copy">{props.state.loaded ? 'No conversations found.' : 'Loading conversations…'}</p>}
      </div>
    </aside>
  );
}

function ContactRow(props: { contact: ContactView; selected: boolean; unread: number; onSelect(cid: string): void }) {
  return (
    <button
      type="button"
      className={`contact-row${props.selected ? ' selected' : ''}`}
      role="option"
      aria-selected={props.selected}
      onClick={() => props.onSelect(props.contact.container_id)}
    >
      <span className="avatar" aria-hidden="true">{props.contact.name.slice(0, 1).toUpperCase()}</span>
      <span className="contact-copy">
        <strong>{props.contact.name}</strong>
        <small>{props.contact.container_id.slice(0, 10)}…</small>
      </span>
      {props.unread > 0 && <span className="unread" aria-label={`${props.unread} unread`}>{props.unread}</span>}
    </button>
  );
}

function PendingContact(props: {
  contact: PendingContactView;
  onAction(contact: PendingContactView, action: 'approve' | 'reject'): void;
}) {
  return (
    <div className="pending-row">
      <span><strong>{props.contact.name}</strong><small>{props.contact.queued} queued</small></span>
      <span className="pending-actions">
        <button type="button" className="secondary compact" onClick={() => props.onAction(props.contact, 'reject')}>Reject</button>
        <button type="button" className="primary compact" onClick={() => props.onAction(props.contact, 'approve')}>Approve</button>
      </span>
    </div>
  );
}
