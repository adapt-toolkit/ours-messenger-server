import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { api } from './api.js';
import { connectEvents } from './events.js';
import { canMarkRead, ReadCoordinator } from './readGate.js';
import { chatPath, parseRoute, type AppRoute } from './router.js';
import {
  appReducer,
  dialogKey,
  initialState,
  pageFor,
  selectedContactCid,
  selectedDialogKey,
  type AppAction,
  type AppState,
} from './store.js';
import type { IdentityTreeRow, InviteView, MediaRecord, PendingContactView, PushState, ServerEvent } from './types.js';
import { ContactList } from './components/ContactList.js';
import { Conversation } from './components/Conversation.js';
import { IdentityHeader } from './components/IdentityHeader.js';
import { InviteDialog } from './components/InviteDialog.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { currentPushState, disablePush, enablePush, registerMessengerWorker, type WorkerState } from './pwa.js';

const convergenceDelays = [0, 100, 400, 1_000] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const receiptRank = { delivered: 1, read: 2 } as const;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function publicError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'The request could not be completed.';
}

export function App() {
  return <AppShell />;
}

export function AppShell() {
  const initial = useRef<AppState>(initialState(parseRoute(window.location.pathname))).current;
  const [state, rawDispatch] = useReducer(appReducer, initial);
  const stateRef = useRef(state);
  const reads = useRef(new ReadCoordinator());
  const desktop = useRef<MediaQueryList | null>(null);
  const routeGeneration = useRef(0);
  const convergence = useRef(new Map<string, number>());
  const [files, setFiles] = useState<Record<string, readonly MediaRecord[]>>({});
  const [fileBusy, setFileBusy] = useState<string | null>(null);
  const [transferLabel, setTransferLabel] = useState<string | null>(null);
  const [contactBusy, setContactBusy] = useState(false);
  const [identities, setIdentities] = useState<readonly IdentityTreeRow[]>([]);
  const [invites, setInvites] = useState<readonly InviteView[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [worker, setWorker] = useState<WorkerState>({ supported: false, offline: !navigator.onLine, updateAvailable: false, registration: null });
  const [push, setPush] = useState<PushState>('unsupported');
  const [pushBusy, setPushBusy] = useState(false);

  const dispatch = useCallback((action: AppAction) => {
    stateRef.current = appReducer(stateRef.current, action);
    rawDispatch(action);
  }, []);

  useEffect(() => { stateRef.current = state; }, [state]);

  const showError = useCallback((error: unknown) => {
    dispatch({ type: 'error', message: publicError(error) });
  }, [dispatch]);

  const gateState = useCallback(() => {
    const current = stateRef.current;
    const cid = selectedContactCid(current);
    return {
      visibility: document.visibilityState,
      appRoute: current.route.name === 'chats' ? 'chats' as const : 'other' as const,
      selectedContactCid: cid,
      desktopLayout: desktop.current?.matches ?? window.innerWidth >= 860,
      mobileDetailOpen: current.mobileDetailOpen,
      conversationCoveringDialogOpen: current.coveringDialog,
    };
  }, []);

  const refreshPage = useCallback(async (cid: string, surfaceError = true) => {
    try {
      const page = await api.conversation(cid);
      dispatch({ type: 'page', contactCid: cid, page });
      return page;
    } catch (error) {
      if (surfaceError) showError(error);
      return null;
    }
  }, [dispatch, showError]);

  const refreshContacts = useCallback(async () => {
    const contacts = await api.contacts();
    dispatch({ type: 'contacts', contacts: { ...contacts, pending: contacts.pending ?? [] } });
    return contacts;
  }, [dispatch]);

  const refreshFiles = useCallback(async (cid: string, surfaceError = true) => {
    try {
      const result = await api.files(cid);
      setFiles((current) => ({ ...current, [cid]: result.files }));
      return result.files;
    } catch (error) {
      if (surfaceError) showError(error);
      return null;
    }
  }, [showError]);

  const refreshSnapshot = useCallback(async (): Promise<string | null> => {
    const before = stateRef.current;
    const selected = selectedContactCid(before);
    const generation = routeGeneration.current;
    try {
      const [identity, contacts, selectedPage] = await Promise.all([
        api.identity(),
        api.contacts(),
        selected ? api.conversation(selected) : Promise.resolve(null),
      ]);
      const normalizedContacts = { ...contacts, pending: contacts.pending ?? [] };
      dispatch({ type: 'snapshot', identity, contacts: normalizedContacts });
      if (selectedPage && selectedContactCid(stateRef.current) === selected) {
        dispatch({ type: 'page', contactCid: selected!, page: selectedPage });
      }
      await Promise.all(normalizedContacts.contacts.map(async (contact) => {
        if (contact.container_id === selected && selectedPage) return;
        await refreshPage(contact.container_id, false);
      }));
      if (selected) await refreshFiles(selected, false);
      const current = stateRef.current;
      return selected && selectedContactCid(current) === selected && routeGeneration.current === generation
        ? selected
        : null;
    } catch (error) {
      showError(error);
      return null;
    }
  }, [dispatch, refreshFiles, refreshPage, showError]);

  const markVisibleRead = useCallback(async (cid: string) => {
    await reads.current.request(cid, async () => {
      if (!canMarkRead(cid, gateState())) return;
      await api.markRead(cid);
      const [page, contacts] = await Promise.all([api.conversation(cid), api.contacts()]);
      dispatch({ type: 'page', contactCid: cid, page });
      dispatch({ type: 'contacts', contacts: { ...contacts, pending: contacts.pending ?? [] } });
    }).catch(showError);
  }, [dispatch, gateState, showError]);

  const refreshVisibleAndRead = useCallback(async () => {
    const cid = selectedContactCid(stateRef.current);
    if (!cid || !canMarkRead(cid, gateState())) return;
    const page = await refreshPage(cid);
    if (page) await markVisibleRead(cid);
  }, [gateState, markVisibleRead, refreshPage]);

  const converge = useCallback(async (
    cid: string,
    ready: (page: NonNullable<ReturnType<typeof pageFor>>) => boolean,
  ) => {
    const generation = (convergence.current.get(cid) ?? 0) + 1;
    convergence.current.set(cid, generation);
    for (const delay of convergenceDelays) {
      if (delay) await sleep(delay);
      if (convergence.current.get(cid) !== generation || selectedContactCid(stateRef.current) !== cid) return;
      const page = await refreshPage(cid, false);
      if (page && ready(page)) return;
    }
  }, [refreshPage]);

  const handleServerEvent = useCallback(async (event: ServerEvent) => {
    if (event.type === 'sync_required') {
      const cid = await refreshSnapshot();
      if (cid && canMarkRead(cid, gateState())) await markVisibleRead(cid);
      return;
    }

    const contacts = refreshContacts().catch(showError);
    if (event.type === 'message_received') {
      if (selectedContactCid(stateRef.current) === event.contact_id) {
        await Promise.all([
          contacts,
          converge(event.contact_id, (page) => page.messages.some((message) => message.wire_id === event.wire_id)),
        ]);
        if (canMarkRead(event.contact_id, gateState())) await markVisibleRead(event.contact_id);
      } else {
        await Promise.all([contacts, refreshPage(event.contact_id, false)]);
      }
      return;
    }

    if (event.type === 'file_received') {
      await Promise.all([contacts, refreshFiles(event.contact_id, false)]);
      return;
    }

    if (selectedContactCid(stateRef.current) === event.contact_id) {
      await Promise.all([
        contacts,
        converge(event.contact_id, (page) => event.wire_ids.every((wireId) => {
          const row = page.messages.find((message) => message.wire_id === wireId);
          return !!row?.receipt && receiptRank[row.receipt] >= receiptRank[event.kind];
        })),
      ]);
    } else {
      await contacts;
    }
  }, [converge, gateState, markVisibleRead, refreshContacts, refreshFiles, refreshPage, refreshSnapshot, showError]);

  const handleEventRef = useRef(handleServerEvent);
  useEffect(() => { handleEventRef.current = handleServerEvent; }, [handleServerEvent]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void registerMessengerWorker((next) => {
      setWorker(next);
      void currentPushState(next.registration).then(setPush);
    }).then((stop) => { cleanup = stop; }).catch(showError);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => {
      cleanup?.();
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
  }, [showError]);

  useEffect(() => {
    if (window.location.pathname === '/') window.history.replaceState(null, '', chatPath());
    desktop.current = window.matchMedia('(min-width: 860px)');
    const onRoute = () => {
      routeGeneration.current++;
      dispatch({ type: 'route', route: parseRoute(window.location.pathname) });
      void refreshVisibleAndRead();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshVisibleAndRead(); };
    const onLayout = () => { if (desktop.current?.matches) void refreshVisibleAndRead(); };
    window.addEventListener('popstate', onRoute);
    document.addEventListener('visibilitychange', onVisible);
    desktop.current.addEventListener('change', onLayout);
    const disconnect = connectEvents(
      (event) => void handleEventRef.current(event).catch(showError),
      (connection) => dispatch({ type: 'connection', connection }),
    );
    void refreshSnapshot().then((cid) => {
      if (cid && canMarkRead(cid, gateState())) return markVisibleRead(cid);
    });
    return () => {
      disconnect();
      window.removeEventListener('popstate', onRoute);
      document.removeEventListener('visibilitychange', onVisible);
      desktop.current?.removeEventListener('change', onLayout);
    };
  }, [dispatch, gateState, markVisibleRead, refreshSnapshot, refreshVisibleAndRead, showError]);

  const goToRoute = (route: AppRoute, path: string, mobileDetailOpen?: boolean) => {
    routeGeneration.current++;
    window.history.pushState(null, '', path);
    dispatch({ type: 'route', route, mobileDetailOpen });
  };

  const selectContact = async (cid: string) => {
    for (const [otherCid, generation] of convergence.current) {
      if (otherCid !== cid) convergence.current.set(otherCid, generation + 1);
    }
    goToRoute({ name: 'chats', contactCid: cid }, chatPath(cid), true);
    const [page] = await Promise.all([refreshPage(cid), refreshFiles(cid, false)]);
    if (page) await markVisibleRead(cid);
  };

  const send = async () => {
    const current = stateRef.current;
    const cid = selectedContactCid(current);
    const key = selectedDialogKey(current);
    if (!cid || !key || current.sendingDialog === key) return;
    const text = (current.drafts[key] ?? '').trim();
    if (!text) return;
    dispatch({ type: 'sending', dialog: key });
    setTransferLabel('Sending message…');
    try {
      await api.send(cid, text, current.replies[key]);
      dispatch({ type: 'draft', contactCid: cid, value: '' });
      dispatch({ type: 'reply', contactCid: cid, wireId: null });
      // The POST never creates a UI row. Only this canonical REST snapshot does.
      await refreshPage(cid);
    } catch (error) {
      showError(error);
    } finally {
      setTransferLabel(null);
      dispatch({ type: 'sending', dialog: null });
    }
  };

  const sendFiles = async (selected: Array<{ blob: Blob; filename: string; mime: string }>) => {
    const current = stateRef.current;
    const cid = selectedContactCid(current);
    const key = selectedDialogKey(current);
    if (!cid || !key || current.sendingDialog === key || selected.length === 0) return;
    const oversized = selected.find((item) => item.blob.size > MAX_FILE_BYTES);
    if (oversized) {
      showError(`${oversized.filename} exceeds the 20 MiB messenger limit.`);
      return;
    }
    dispatch({ type: 'sending', dialog: key });
    try {
      for (const [index, item] of selected.entries()) {
        setTransferLabel(`Uploading ${index + 1} of ${selected.length} · ${item.filename}`);
        await api.sendFile(cid, item.blob, item.filename, item.mime || 'application/octet-stream', current.replies[key]);
      }
      dispatch({ type: 'reply', contactCid: cid, wireId: null });
      await refreshFiles(cid);
    } catch (error) {
      showError(error);
    } finally {
      setTransferLabel(null);
      dispatch({ type: 'sending', dialog: null });
    }
  };

  const fetchFile = async (file: MediaRecord) => {
    setFileBusy(file.wire_id);
    try {
      await api.fetchFiles([file.wire_id]);
      await refreshFiles(file.contact_id);
    } catch (error) {
      showError(error);
    } finally {
      setFileBusy(null);
    }
  };

  const createInvite = async (mode: 'one_time' | 'public') => {
    dispatch({ type: 'dialog_busy', busy: true });
    try {
      const invite = await api.createInvite(mode);
      dispatch({ type: 'generated_invite', blob: invite.blob });
      setInvites(await api.invites());
    } catch (error) {
      showError(error);
    } finally {
      dispatch({ type: 'dialog_busy', busy: false });
    }
  };

  const revokeInvite = async (inviteId: string) => {
    dispatch({ type: 'dialog_busy', busy: true });
    try {
      await api.revokeInvite(inviteId);
      setInvites(await api.invites());
      dispatch({ type: 'generated_invite', blob: null });
    } catch (error) {
      showError(error);
    } finally {
      dispatch({ type: 'dialog_busy', busy: false });
    }
  };

  const acceptInvite = async (invite: string, name: string) => {
    if (!invite) {
      dispatch({ type: 'error', message: 'Paste an invite first.' });
      return;
    }
    dispatch({ type: 'dialog_busy', busy: true });
    try {
      await api.addContact(invite, name || undefined);
      dispatch({ type: 'dialog', open: false });
      await refreshSnapshot();
    } catch (error) {
      showError(error);
      dispatch({ type: 'dialog_busy', busy: false });
    }
  };

  const respondToIntroduction = async (contact: PendingContactView, action: 'approve' | 'reject') => {
    try {
      await api.respondToIntroduction(contact.container_id, action);
      await refreshSnapshot();
    } catch (error) {
      showError(error);
    }
  };

  const renameContact = async (cid: string, name: string) => {
    setContactBusy(true);
    try {
      await api.renameContact(cid, name);
      await refreshSnapshot();
    } catch (error) {
      showError(error);
    } finally {
      setContactBusy(false);
    }
  };

  const removeContact = async (cid: string) => {
    setContactBusy(true);
    try {
      await api.removeContact(cid);
      goToRoute({ name: 'chats', contactCid: null }, chatPath(), false);
      await refreshSnapshot();
    } catch (error) {
      showError(error);
    } finally {
      setContactBusy(false);
    }
  };

  const openInvite = async () => {
    setSettingsOpen(false);
    dispatch({ type: 'dialog', open: true });
    try { setInvites(await api.invites()); } catch (error) { showError(error); }
  };

  const openSettings = async () => {
    setSettingsOpen(true);
    dispatch({ type: 'dialog', open: true });
    try { setIdentities(await api.identities()); } catch (error) { showError(error); }
  };

  const closeDialog = () => {
    setSettingsOpen(false);
    dispatch({ type: 'dialog', open: false });
    void refreshVisibleAndRead();
  };

  const togglePush = async (enable: boolean) => {
    if (!worker.registration) return;
    setPushBusy(true);
    setPush('busy');
    try {
      setPush(await (enable ? enablePush(worker.registration) : disablePush(worker.registration)));
    } catch (error) {
      setPush('error');
      showError(error);
    } finally {
      setPushBusy(false);
    }
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const selectedCid = selectedContactCid(state);
  const contact = state.contacts.contacts.find((item) => item.container_id === selectedCid) ?? null;
  const key = selectedDialogKey(state);

  if (state.route.name === 'not_found') {
    return (
      <div className="centered-screen">
        <h1>Page not found</h1>
        <p className="muted">This messenger route does not exist.</p>
        <button type="button" className="primary" onClick={() => goToRoute({ name: 'chats', contactCid: null }, chatPath())}>
          Open chats
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <IdentityHeader
        identity={state.identity}
        connection={state.connection}
        openInvite={() => void openInvite()}
        openSettings={() => void openSettings()}
        installable={installPrompt !== null}
        install={() => void install()}
      />
      {worker.offline && <div className="offline-banner" role="status">Offline shell · message and identity data are not cached</div>}
      {state.connection !== 'live' && (
        <div className="connection-banner" role="status">
          {state.connection === 'retrying' ? 'Live updates interrupted. Reconnecting; REST remains authoritative.' : 'Connecting to live updates…'}
        </div>
      )}
      <main className="messenger-main">
        <ContactList
          state={state}
          selected={selectedCid}
          onQuery={(search) => dispatch({ type: 'search', search })}
          onSelect={(cid) => void selectContact(cid)}
          onAdd={() => void openInvite()}
          onIntroduction={(pending, action) => void respondToIntroduction(pending, action)}
        />
        <Conversation
          contact={contact}
          page={selectedCid ? pageFor(state, selectedCid) : null}
          draft={key ? state.drafts[key] ?? '' : ''}
          replyWire={key ? state.replies[key] ?? null : null}
          sending={state.sendingDialog === key && key !== null}
          sendingLabel={transferLabel}
          files={selectedCid ? files[selectedCid] ?? [] : []}
          busyWire={fileBusy}
          contactBusy={contactBusy}
          mobileOpen={state.mobileDetailOpen}
          onBack={() => {
            goToRoute({ name: 'chats', contactCid: null }, chatPath(), false);
            queueMicrotask(() => document.querySelector<HTMLButtonElement>('.contact-row.selected')?.focus());
          }}
          onDraft={(value) => selectedCid && dispatch({ type: 'draft', contactCid: selectedCid, value })}
          onReply={(wireId) => selectedCid && dispatch({ type: 'reply', contactCid: selectedCid, wireId })}
          onCancelReply={() => selectedCid && dispatch({ type: 'reply', contactCid: selectedCid, wireId: null })}
          onSend={() => void send()}
          onFiles={(selected) => void sendFiles(selected.map((file) => ({ blob: file, filename: file.name, mime: file.type })))}
          onVoice={(blob, filename, mime) => void sendFiles([{ blob, filename, mime }])}
          onFetch={(file) => void fetchFile(file)}
          onRename={(name) => selectedCid && void renameContact(selectedCid, name)}
          onRemove={() => selectedCid && void removeContact(selectedCid)}
          onError={(message) => dispatch({ type: 'error', message })}
        />
      </main>
      {state.coveringDialog && !settingsOpen && (
        <InviteDialog
          generated={state.generatedInvite}
          invites={invites}
          busy={state.dialogBusy}
          error={state.error}
          onClose={closeDialog}
          onCreate={(mode) => void createInvite(mode)}
          onRevoke={(inviteId) => void revokeInvite(inviteId)}
          onAccept={(invite, name) => void acceptInvite(invite, name)}
        />
      )}
      {state.coveringDialog && settingsOpen && (
        <SettingsDialog
          identity={state.identity}
          identities={identities}
          push={push}
          workerSupported={worker.supported}
          offline={worker.offline}
          updateAvailable={worker.updateAvailable}
          busy={pushBusy}
          onTogglePush={(enable) => void togglePush(enable)}
          onReloadUpdate={() => {
            worker.registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
            window.location.reload();
          }}
          onClose={closeDialog}
        />
      )}
      {state.error && !state.coveringDialog && (
        <div className="error-toast" role="alert">
          <span>{state.error}</span>
          <button type="button" className="icon-button" aria-label="Dismiss error" onClick={() => dispatch({ type: 'error', message: null })}>×</button>
        </div>
      )}
    </div>
  );
}
