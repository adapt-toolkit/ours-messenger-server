import { api } from './api.js';
import { connectEvents } from './events.js';
import { canMarkRead, ReadCoordinator } from './readGate.js';
import type { ConnectionState, ContactView, ConversationPage, IdentityView, ServerEvent } from './types.js';
import { ContactList } from './components/ContactList.js';
import { Conversation } from './components/Conversation.js';
import { IdentityHeader } from './components/IdentityHeader.js';
import { InviteDialog } from './components/InviteDialog.js';
import { element } from './components/dom.js';

const convergenceDelays = [0, 100, 400, 1_000] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const receiptRank = { delivered: 1, read: 2 } as const;

export class MessengerApp {
  identity: IdentityView | null = null;
  contacts: ContactView[] = [];
  selectedContactCid: string | null = null;
  pages = new Map<string, ConversationPage>();
  drafts = new Map<string, string>();
  replies = new Map<string, string>();
  mobileDetailOpen = false;
  coveringDialog: null | 'contact' = null;
  connection: ConnectionState = 'connecting';
  search = '';
  sending = false;
  dialogBusy = false;
  dialogInvite: string | null = null;
  error: string | null = null;
  readonly #reads = new ReadCoordinator();
  readonly #desktop = matchMedia('(min-width: 860px)');
  readonly #convergence = new Map<string, number>();
  #disconnectEvents: (() => void) | null = null;

  constructor(readonly root: HTMLElement) {}

  async start(): Promise<void> {
    this.render();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.refreshVisibleAndRead();
    });
    this.#desktop.addEventListener('change', () => {
      this.render();
      if (this.#desktop.matches) void this.refreshVisibleAndRead();
    });
    this.#disconnectEvents = connectEvents(
      (event) => void this.onServerEvent(event).catch((error) => this.showError(error)),
      (connection) => { this.connection = connection; this.render(); },
    );
    await this.refreshSnapshot();
  }

  stop(): void {
    this.#disconnectEvents?.();
  }

  gateState() {
    return {
      visibility: document.visibilityState,
      appRoute: 'chats' as const,
      selectedContactCid: this.selectedContactCid,
      desktopLayout: this.#desktop.matches,
      mobileDetailOpen: this.mobileDetailOpen,
      conversationCoveringDialogOpen: this.coveringDialog !== null,
    };
  }

  async refreshSnapshot(): Promise<void> {
    const selected = this.selectedContactCid;
    try {
      const [identity, contacts, page] = await Promise.all([
        api.identity(),
        api.contacts(),
        selected ? api.conversation(selected) : Promise.resolve(null),
      ]);
      this.identity = identity;
      this.contacts = contacts.contacts;
      if (page && this.selectedContactCid === selected) this.pages.set(selected!, page);
      this.render();
      // The contacts result has no unread count, so populate list metadata from
      // non-consuming pages. This never calls markRead.
      await Promise.all(this.contacts.map((contact) => this.refreshPage(contact.container_id, false)));
      this.render();
    } catch (error) {
      this.showError(error);
    }
  }

  async refreshPage(cid: string, rerender = true): Promise<ConversationPage | null> {
    try {
      const page = await api.conversation(cid);
      this.pages.set(cid, page);
      if (rerender) this.render();
      return page;
    } catch (error) {
      this.showError(error);
      return null;
    }
  }

  async selectContact(cid: string): Promise<void> {
    this.selectedContactCid = cid;
    this.mobileDetailOpen = true;
    this.cancelOtherConvergence(cid);
    this.render();
    await this.refreshPage(cid);
    await this.markVisibleRead(cid);
  }

  async refreshVisibleAndRead(): Promise<void> {
    const cid = this.selectedContactCid;
    if (!cid || !canMarkRead(cid, this.gateState())) return;
    await this.refreshPage(cid);
    await this.markVisibleRead(cid);
  }

  async markVisibleRead(cid: string): Promise<void> {
    await this.#reads.request(cid, async () => {
      // Load/render happens before this function. Recheck at the last possible
      // instant so a hidden tab, mobile back, or covering dialog cannot race it.
      if (!canMarkRead(cid, this.gateState())) return;
      await api.markRead(cid);
      await Promise.all([this.refreshPage(cid, false), api.contacts().then((view) => { this.contacts = view.contacts; })]);
      this.render();
    }).catch((error) => this.showError(error));
  }

  async onServerEvent(event: ServerEvent): Promise<void> {
    if (event.type === 'sync_required') {
      await this.refreshSnapshot();
      return;
    }

    const contacts = api.contacts().then((view) => { this.contacts = view.contacts; });
    if (event.type === 'message_received') {
      if (this.selectedContactCid === event.contact_id && canMarkRead(event.contact_id, this.gateState())) {
        await Promise.all([contacts, this.converge(event.contact_id, (page) => page.messages.some((m) => m.wire_id === event.wire_id))]);
        await this.markVisibleRead(event.contact_id);
      } else {
        await Promise.all([contacts, this.refreshPage(event.contact_id, false)]);
        this.render();
      }
      return;
    }

    if (this.selectedContactCid === event.contact_id) {
      await Promise.all([
        contacts,
        this.converge(event.contact_id, (page) => event.wire_ids.every((wireId) => {
          const row = page.messages.find((message) => message.wire_id === wireId);
          return !!row?.receipt && receiptRank[row.receipt] >= receiptRank[event.kind];
        })),
      ]);
    } else {
      await contacts;
    }
    this.render();
  }

  async converge(cid: string, ready: (page: ConversationPage) => boolean): Promise<void> {
    const generation = (this.#convergence.get(cid) ?? 0) + 1;
    this.#convergence.set(cid, generation);
    for (const delay of convergenceDelays) {
      if (delay) await sleep(delay);
      if (this.#convergence.get(cid) !== generation || this.selectedContactCid !== cid) return;
      const page = await this.refreshPage(cid, false);
      if (page && ready(page)) { this.render(); return; }
    }
  }

  cancelOtherConvergence(keepCid: string): void {
    for (const [cid, generation] of this.#convergence) {
      if (cid !== keepCid) this.#convergence.set(cid, generation + 1);
    }
  }

  async send(): Promise<void> {
    const cid = this.selectedContactCid;
    if (!cid || this.sending) return;
    const text = (this.drafts.get(cid) ?? '').trim();
    if (!text) return;
    this.sending = true;
    this.render();
    try {
      await api.send(cid, text, this.replies.get(cid));
      this.drafts.set(cid, '');
      this.replies.delete(cid);
      // No optimistic sent row: only authoritative outbound history is rendered.
      await this.refreshPage(cid, false);
    } catch (error) {
      this.showError(error);
    } finally {
      this.sending = false;
      this.render();
    }
  }

  async createInvite(): Promise<void> {
    this.dialogBusy = true;
    this.render();
    try {
      this.dialogInvite = (await api.createInvite()).blob;
    } catch (error) {
      this.showError(error);
    } finally {
      this.dialogBusy = false;
      this.render();
    }
  }

  async acceptInvite(invite: string, name: string): Promise<void> {
    if (!invite) { this.error = 'Paste an invite first.'; this.render(); return; }
    this.dialogBusy = true;
    this.render();
    try {
      await api.addContact(invite, name || undefined);
      this.closeDialog();
      await this.refreshSnapshot();
    } catch (error) {
      this.showError(error);
      this.dialogBusy = false;
      this.render();
    }
  }

  openDialog(): void {
    this.coveringDialog = 'contact';
    this.dialogInvite = null;
    this.error = null;
    this.render();
  }

  closeDialog(): void {
    this.coveringDialog = null;
    this.dialogBusy = false;
    this.error = null;
    this.render();
    void this.refreshVisibleAndRead();
  }

  showError(error: unknown): void {
    this.error = error instanceof Error ? error.message : String(error);
    this.render();
  }

  render(): void {
    this.root.replaceChildren();
    const shell = element('div', 'app-shell');
    shell.append(IdentityHeader(this.identity, this.connection, () => this.openDialog()));
    const main = element('main', 'messenger-main');
    main.append(ContactList({
      contacts: this.contacts,
      pages: this.pages,
      selected: this.selectedContactCid,
      query: this.search,
      onQuery: (query) => { this.search = query; this.render(); },
      onSelect: (cid) => void this.selectContact(cid),
      onAdd: () => this.openDialog(),
    }));
    const contact = this.contacts.find((candidate) => candidate.container_id === this.selectedContactCid) ?? null;
    const cid = contact?.container_id ?? null;
    main.append(Conversation({
      contact,
      page: cid ? this.pages.get(cid) ?? null : null,
      draft: cid ? this.drafts.get(cid) ?? '' : '',
      replyWire: cid ? this.replies.get(cid) ?? null : null,
      sending: this.sending,
      mobileOpen: this.mobileDetailOpen,
      onBack: () => {
        this.mobileDetailOpen = false;
        this.render();
        queueMicrotask(() => document.querySelector<HTMLButtonElement>('.contact-row.selected')?.focus());
      },
      onDraft: (value) => { if (cid) this.drafts.set(cid, value); },
      onReply: (wireId) => { if (cid) { this.replies.set(cid, wireId); this.render(); } },
      onCancelReply: () => { if (cid) { this.replies.delete(cid); this.render(); } },
      onSend: () => void this.send(),
    }));
    shell.append(main);
    if (this.coveringDialog) shell.append(InviteDialog({
      generated: this.dialogInvite,
      busy: this.dialogBusy,
      error: this.error,
      onClose: () => this.closeDialog(),
      onCreate: () => void this.createInvite(),
      onAccept: (invite, name) => void this.acceptInvite(invite, name),
    }));
    if (this.error && !this.coveringDialog) {
      const toast = element('div', 'error-toast', this.error);
      toast.setAttribute('role', 'alert');
      shell.append(toast);
    }
    this.root.append(shell);
  }
}
