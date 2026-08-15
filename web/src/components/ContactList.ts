import type { ContactView, ConversationPage } from '../types.js';
import { button, element } from './dom.js';

export function ContactList(opts: {
  contacts: ContactView[];
  pages: Map<string, ConversationPage>;
  selected: string | null;
  query: string;
  onQuery(query: string): void;
  onSelect(cid: string): void;
  onAdd(): void;
}): HTMLElement {
  const rail = element('aside', 'contact-rail');
  const tools = element('div', 'rail-tools');
  const search = element('input', 'search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Search conversations';
  search.setAttribute('aria-label', 'Search conversations');
  search.value = opts.query;
  search.addEventListener('input', () => opts.onQuery(search.value));
  tools.append(search, button('+', 'icon-button', opts.onAdd));
  rail.append(tools);

  const list = element('div', 'contacts');
  list.setAttribute('role', 'listbox');
  const query = opts.query.trim().toLocaleLowerCase();
  const visible = opts.contacts.filter((contact) => !query || contact.name.toLocaleLowerCase().includes(query));
  for (const contact of visible) {
    const cid = contact.container_id;
    const row = button('', `contact-row${opts.selected === cid ? ' selected' : ''}`, () => opts.onSelect(cid));
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(opts.selected === cid));
    const avatar = element('span', 'avatar', contact.name.slice(0, 1).toUpperCase());
    const copy = element('span', 'contact-copy');
    copy.append(element('strong', '', contact.name), element('small', '', `${cid.slice(0, 10)}…`));
    row.append(avatar, copy);
    const unread = opts.pages.get(cid)?.unread ?? 0;
    if (unread > 0) row.append(element('span', 'unread', String(unread)));
    list.append(row);
  }
  if (visible.length === 0) list.append(element('p', 'empty-copy', 'No conversations found.'));
  rail.append(list);
  return rail;
}
