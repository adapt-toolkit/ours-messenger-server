export interface ReadGateState {
  visibility: DocumentVisibilityState;
  appRoute: 'chats' | 'other';
  selectedContactCid: string | null;
  desktopLayout: boolean;
  mobileDetailOpen: boolean;
  conversationCoveringDialogOpen: boolean;
}

/** The one predicate every read POST must pass immediately before mutation. */
export function canMarkRead(contactCid: string, state: ReadGateState): boolean {
  return state.visibility === 'visible'
    && state.appRoute === 'chats'
    && state.selectedContactCid === contactCid
    && (state.desktopLayout || state.mobileDetailOpen)
    && !state.conversationCoveringDialogOpen;
}

interface Entry {
  running: Promise<void> | null;
  rerun: boolean;
}

/** Coalesces per CID only: one in-flight call and at most one requested rerun. */
export class ReadCoordinator {
  readonly #entries = new Map<string, Entry>();

  request(contactCid: string, action: () => Promise<void>): Promise<void> {
    let entry = this.#entries.get(contactCid);
    if (entry?.running) {
      entry.rerun = true;
      return entry.running;
    }
    entry ??= { running: null, rerun: false };
    this.#entries.set(contactCid, entry);
    entry.running = (async () => {
      do {
        entry!.rerun = false;
        await action();
      } while (entry!.rerun);
    })().finally(() => {
      entry!.running = null;
      if (!entry!.rerun) this.#entries.delete(contactCid);
    });
    return entry.running;
  }
}
