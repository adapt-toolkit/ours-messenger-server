import { button, element } from './dom.js';

export function InviteDialog(opts: {
  generated: string | null;
  busy: boolean;
  error: string | null;
  onClose(): void;
  onCreate(): void;
  onAccept(invite: string, name: string): void;
}): HTMLElement {
  const cover = element('div', 'dialog-cover');
  const dialog = element('section', 'dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'contact-dialog-title');
  const top = element('div', 'dialog-top');
  const title = element('h2', '', 'Add a contact');
  title.id = 'contact-dialog-title';
  top.append(title, button('×', 'icon-button', opts.onClose));
  dialog.append(top, element('p', 'muted', 'Create an invite to share, or accept one you received.'));

  const create = button(opts.busy ? 'Working…' : 'Create one-time invite', 'primary wide', opts.onCreate);
  create.disabled = opts.busy;
  dialog.append(create);
  if (opts.generated) {
    const output = element('textarea', 'invite-output') as HTMLTextAreaElement;
    output.readOnly = true;
    output.value = opts.generated;
    output.setAttribute('aria-label', 'Generated invite');
    dialog.append(output);
  }
  dialog.append(element('div', 'divider', 'or accept an invite'));
  const name = element('input', 'field') as HTMLInputElement;
  name.placeholder = 'Contact name (optional)';
  const invite = element('textarea', 'field invite-input') as HTMLTextAreaElement;
  invite.placeholder = 'Paste invite';
  const accept = button('Accept invite', 'secondary wide', () => opts.onAccept(invite.value.trim(), name.value.trim()));
  accept.disabled = opts.busy;
  dialog.append(name, invite, accept);
  if (opts.error) dialog.append(element('p', 'error', opts.error));
  cover.append(dialog);
  cover.addEventListener('mousedown', (event) => { if (event.target === cover) opts.onClose(); });
  queueMicrotask(() => create.focus());
  return cover;
}
