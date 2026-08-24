import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from './api.js';
import { connectEvents, dispatchLiveEvent, listenLiveEvents } from './events.js';
import { startPresence } from './presence.js';
import { canMarkRead, ReadCoordinator } from './readGate.js';
import { chatPath, parseRoute, type AppRoute } from './router.js';
import { appReducer, initialState, pageFor, selectedContactCid, type AppAction, type AppState } from './store.js';
import type { BuildInfoView, InviteView, MediaRecord, PushPreviewMode, PushView, ServerEvent } from './types.js';
import {
  activateWorkerUpdate, clearPushNotifications, currentPushState, disablePush, enablePush,
  registerMessengerWorker, repairPush, startForegroundHeartbeat, type WorkerState,
} from './pwa.js';
import { ChatList, Conversation } from './ui/Chats.js';
import type { ChatMessage } from './ui/chatTypes.js';
import { clearMediaRecords, configureMediaProvider, filePreviewLabel, registerMediaRecords } from './ui/fileStore.js';
import { fmtWhen, initials, type ContactVM, type RootMetaVM, shortCid } from './ui/viewmodel.js';
// @ts-ignore -- canonical pure-JS helper is typed at this seam.
import { timeMs as timeMsJs } from './ui/timelineCore.mjs';
import { Icon } from './ui/icons.js';
import MessageToasts, { useMessageToasts } from './ui/MessageToast.js';
import { InviteModal, SettingsModal } from './ui/MessengerModals.js';
import { forceRecover, startUpdateCheck } from './updateCheck.js';

const convergenceDelays = [0, 100, 400, 1_000, 3_000, 6_000] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const receiptRank = { delivered: 1, read: 2 } as const;
const DARK_KEY = 'ours-dark-v3';
/** Deep link a push notification opens the app with: #chat-message-<wire id>. */
const ANCHOR_HASH = '#chat-message-';
const timelineTimeMs = timeMsJs as (date: string) => number;

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const publicError = (error: unknown) => error instanceof Error && error.message ? error.message : 'The request could not be completed.';

export function timeline(page: ReturnType<typeof pageFor>, media: readonly MediaRecord[]): ChatMessage[] {
  const rows = new Map<string, ChatMessage>();
  const legacy: ChatMessage[] = [];
  for (const message of page?.messages ?? []) {
    const normalized: ChatMessage = {
      dir: message.dir, text: message.text, date: message.date, read: message.read,
      wireId: message.wire_id, replyTo: message.reply_to ? { wireId: message.reply_to.wire_id } : null,
      receipt: message.receipt ?? undefined,
      // An outbound row with no wire id can never be named by a receipt — an
      // introduction-carried send, or a pre-1.4 entry restored from an old
      // backup. Saying "sent" of it is true; leaving the reader to assume a
      // receipt is merely late is not, since none is coming.
      receiptless: message.dir === 'out' && !message.wire_id,
    };
    if (message.wire_id) rows.set(message.wire_id, normalized); else legacy.push(normalized);
  }
  for (const file of media) {
    const matching = rows.get(file.wire_id);
    rows.set(file.wire_id, {
      dir: file.dir,
      text: '',
      date: file.date,
      read: matching?.read ?? file.dir === 'out',
      wireId: file.wire_id,
      replyTo: file.reply_to ? { wireId: file.reply_to.wire_id } : matching?.replyTo ?? null,
      kind: 'file',
      filename: file.filename,
      mime: file.mime,
      receipt: matching?.receipt,
    });
  }
  return [...legacy, ...rows.values()].sort((a, b) => {
    const delta = timelineTimeMs(a.date) - timelineTimeMs(b.date);
    return delta === 0 ? a.wireId.localeCompare(b.wireId) : delta;
  });
}

function rootViews(contacts: AppState['contacts']): Record<string, RootMetaVM> {
  const result: Record<string, RootMetaVM> = {};
  for (const root of Object.values(contacts.roots ?? {})) {
    result[root.root_cid] = { label: root.root_name, note: 'Verified identity' };
  }
  return result;
}

function contactViews(state: AppState, media: Record<string, readonly MediaRecord[]>): ContactVM[] {
  const active = state.contacts.contacts.map((contact) => {
    const root = state.contacts.roots?.[contact.container_id];
    const page = pageFor(state, contact.container_id);
    const items = timeline(page, media[contact.container_id] ?? []);
    const last = items.at(-1);
    return {
      id: contact.container_id,
      name: contact.name,
      announcedName: contact.name,
      initials: initials(contact.name),
      when: last ? fmtWhen(last.date) : '',
      activityAt: last?.date ?? '',
      // A file row is labelled from its own metadata; everything else takes the
      // SERVER'S preview, which is the same line the push notification carries.
      // Falling back to the raw text keeps a page from an older server working,
      // and is the only path that can still show a room body verbatim.
      last: last?.kind === 'file'
        ? filePreviewLabel(last.filename, last.mime)
        : page?.preview ?? last?.text ?? '',
      unread: page?.unread ?? 0,
      status: 'active' as const,
      root: root?.root_cid ?? null,
      sub: root ? `role “${root.role_id}” of ${root.root_name}` : '',
      roleId: root?.role_id ?? null,
      rootName: root?.root_name ?? null,
      mine: false,
      kind: root ? 'agent' as const : 'person' as const,
    };
  });
  return [...active, ...state.contacts.pending.map((pending) => ({
    id: `pending:${pending.container_id}`, name: pending.name, announcedName: pending.name,
    initials: initials(pending.name), when: '', activityAt: '', last: `${pending.queued} queued · approval required`, unread: 0,
    status: 'pending' as const, root: null, sub: '', roleId: null, rootName: null, mine: false, kind: 'person' as const,
  }))];
}

export function App() { return <AppShell />; }

export function AppShell() {
  const initial = useRef<AppState>(initialState(parseRoute(window.location.pathname))).current;
  const [state, rawDispatch] = useReducer(appReducer, initial);
  const stateRef = useRef(state);
  const reads = useRef(new ReadCoordinator());
  const desktop = useRef<MediaQueryList | null>(null);
  const convergence = useRef(new Map<string, number>());
  const recentEvents = useRef(new Map<string, number>());
  const [files, setFiles] = useState<Record<string, readonly MediaRecord[]>>({});
  const filesRef = useRef(files);
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const historyLoads = useRef(new Set<string>());
  const [modal, setModal] = useState<'invite' | 'settings' | null>(null);
  const modalRef = useRef(modal);
  const draftPresentRef = useRef(false);
  const [invites, setInvites] = useState<readonly InviteView[]>([]);
  const [build, setBuild] = useState<BuildInfoView | null>(null);
  const [dark, setDark] = useState(() => localStorage.getItem(DARK_KEY) !== '0');
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [worker, setWorker] = useState<WorkerState>({ supported: false, offline: !navigator.onLine, updateAvailable: false, registration: null });
  const [push, setPush] = useState<PushView>({ status: 'unsupported', preview: 'full' });
  const [pushBusy, setPushBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // A cold open from a push notification asks for one specific message. Until
  // that message is on screen the app is still catching up, and it says so.
  const [anchorPending, setAnchorPending] = useState(() => window.location.hash.startsWith(ANCHOR_HASH));
  const { toasts, push: pushToast, dismiss: dismissToast, clear: clearToasts } = useMessageToasts();

  const dispatch = useCallback((action: AppAction) => {
    stateRef.current = appReducer(stateRef.current, action);
    rawDispatch(action);
  }, []);
  const noteDraftPresence = useCallback((hasText: boolean) => { draftPresentRef.current = hasText; }, []);
  useEffect(() => { stateRef.current = state; }, [state]);
  modalRef.current = modal;
  filesRef.current = files;
  useMemo(() => { registerMediaRecords(Object.values(files).flat()); return null; }, [files]);
  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', dark);
    return () => document.documentElement.classList.remove('theme-dark');
  }, [dark]);

  const showError = useCallback((error: unknown) => dispatch({ type: 'error', message: publicError(error) }), [dispatch]);
  const gateState = useCallback(() => {
    const current = stateRef.current;
    return {
      visibility: document.visibilityState,
      appRoute: current.route.name === 'chats' ? 'chats' as const : 'other' as const,
      selectedContactCid: selectedContactCid(current),
      desktopLayout: desktop.current?.matches ?? window.innerWidth >= 861,
      mobileDetailOpen: current.mobileDetailOpen,
      conversationCoveringDialogOpen: modalRef.current !== null,
    };
  }, []);

  const refreshPage = useCallback(async (cid: string, surface = true) => {
    try { const page = await api.conversation(cid); dispatch({ type: 'page', contactCid: cid, page }); return page; }
    catch (error) { if (surface) showError(error); return null; }
  }, [dispatch, showError]);
  const refreshFiles = useCallback(async (cid: string, surface = true) => {
    try {
      const result = await api.files(cid);
      registerMediaRecords(result.files);
      setFiles((current) => ({ ...current, [cid]: result.files }));
      return result.files;
    } catch (error) { if (surface) showError(error); return null; }
  }, [showError]);

  useEffect(() => startUpdateCheck({
    onUpdateAvailable: () => setWorker((current) => ({ ...current, updateAvailable: true })),
    // Messenger state is server-owned, so the control-plane recovery can run
    // automatically without risking local identity or message data.
    onStuck: (remoteSha) => { void forceRecover(remoteSha); },
  }), []);
  const refreshContacts = useCallback(async () => {
    const contacts = await api.contacts();
    dispatch({ type: 'contacts', contacts: { ...contacts, pending: contacts.pending ?? [] } });
    return contacts;
  }, [dispatch]);
  const refreshSnapshot = useCallback(async () => {
    try {
      const [identity, contacts, buildInfo] = await Promise.all([api.identity(), api.contacts(), api.buildInfo()]);
      const normalized = { ...contacts, pending: contacts.pending ?? [] };
      if (stateRef.current.identity && stateRef.current.identity.cid !== identity.cid) {
        clearMediaRecords();
        filesRef.current = {};
        setFiles({});
      }
      dispatch({ type: 'snapshot', identity, contacts: normalized });
      setBuild(buildInfo);
      await Promise.all(normalized.contacts.flatMap((contact) => [refreshPage(contact.container_id, false), refreshFiles(contact.container_id, false)]));
      return selectedContactCid(stateRef.current);
    } catch (error) { showError(error); return null; }
  }, [dispatch, refreshFiles, refreshPage, showError]);
  const markVisibleRead = useCallback(async (cid: string) => {
    await reads.current.request(cid, async () => {
      if (!canMarkRead(cid, gateState())) return;
      await api.markRead(cid);
      await Promise.all([refreshPage(cid), refreshContacts()]);
    }).catch(showError);
  }, [gateState, refreshContacts, refreshPage, showError]);
  /**
   * Poll the conversation until `ready`, then stop.
   *
   * `purpose` SCOPES THE CANCELLATION, and it is load-bearing. Every caller used
   * to share one generation slot per contact, so the last converge to start
   * silently orphaned all the others. In practice that meant the convergence
   * watching for a delivered receipt was cancelled by the one the send itself
   * starts — whose predicate ("my message is in the page") is satisfied by its
   * very first poll. Nothing was left watching for the receipt, and the tick
   * waited for whatever unrelated refresh happened next, which is usually the
   * READ receipt. That is the "one tick, then straight to read" report.
   *
   * On a fast link the receipt lands before the send resolves, so the ordering
   * is harmless and the bug hides completely — which is why it never showed up
   * in local testing.
   *
   * Same purpose still supersedes: a read receipt for the same wire ids cancels
   * the delivered convergence for them, and should, because it is strictly
   * stronger.
   */
  const converge = useCallback(async (
    cid: string,
    ready: (page: NonNullable<ReturnType<typeof pageFor>>) => boolean,
    purpose = 'page',
  ) => {
    const key = `page:${cid}:${purpose}`;
    const generation = (convergence.current.get(key) ?? 0) + 1;
    convergence.current.set(key, generation);
    for (const delay of convergenceDelays) {
      if (delay) await sleep(delay);
      if (convergence.current.get(key) !== generation) return;
      const page = await refreshPage(cid, false);
      if (page && ready(page)) return;
    }
  }, [refreshPage]);
  const convergeFile = useCallback(async (cid: string, wireId: string) => {
    const key = `file:${cid}`;
    const generation = (convergence.current.get(key) ?? 0) + 1;
    convergence.current.set(key, generation);
    for (const delay of convergenceDelays) {
      if (delay) await sleep(delay);
      if (convergence.current.get(key) !== generation) return;
      const records = await refreshFiles(cid, false);
      if (records?.some((item) => item.wire_id === wireId)) return;
    }
  }, [refreshFiles]);

  // Opening the app from a push notification asks for one specific message.
  // Hold the "updating" state until that message is actually in the loaded
  // page — or until the bounded convergence gives up, so it always settles.
  const anchorConverged = useRef(false);
  useEffect(() => {
    if (!anchorPending || !state.loaded) return;
    const wireId = decodeURIComponent(window.location.hash.slice(ANCHOR_HASH.length));
    const cid = selectedContactCid(stateRef.current);
    if (!wireId || !cid) { setAnchorPending(false); return; }
    if (pageFor(stateRef.current, cid)?.messages.some((item) => item.wire_id === wireId)) {
      setAnchorPending(false);
      return;
    }
    if (anchorConverged.current) return;
    anchorConverged.current = true;
    void converge(cid, (page) => page.messages.some((item) => item.wire_id === wireId), `anchor:${wireId}`)
      .catch(() => undefined)
      .finally(() => setAnchorPending(false));
  }, [anchorPending, converge, state.loaded, state.pages]);

  useMemo(() => {
    configureMediaProvider({
      url: (wireId) => {
        const record = Object.values(filesRef.current).flat().find((item) => item.wire_id === wireId);
        return record?.available ? api.mediaUrl(wireId) : null;
      },
      bytes: async (wireId) => {
        const record = Object.values(filesRef.current).flat().find((item) => item.wire_id === wireId);
        if (!record?.available) return null;
        const response = await fetch(api.mediaUrl(wireId), { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Media request failed (HTTP ${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
      fetch: async (wireId) => {
        const record = Object.values(filesRef.current).flat().find((item) => item.wire_id === wireId);
        if (!record) throw new Error('Media record is unavailable');
        await api.fetchFiles([wireId]);
        await refreshFiles(record.contact_id);
      },
    });
    return null;
  }, [refreshFiles]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    void registerMessengerWorker((next) => {
      setWorker(next);
      void currentPushState(next.registration).then(setPush).catch(() =>
        setPush((current) => ({ ...current, status: 'error' })));
    }, { shouldDeferReload: () => draftPresentRef.current || modalRef.current !== null })
      .then((stop) => { cleanup = stop; }).catch(showError);
    const prompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPromptEvent); };
    window.addEventListener('beforeinstallprompt', prompt);
    return () => { cleanup?.(); window.removeEventListener('beforeinstallprompt', prompt); };
  }, [showError]);

  useEffect(() => startForegroundHeartbeat(), []);

  useEffect(() => {
    if (!worker.registration || push.status !== 'on') return;
    return startPresence({
      registration: worker.registration,
      identity: api.identity,
      onEvent: dispatchLiveEvent,
    });
  }, [push.status, push.bindingId, worker.registration]);

  useEffect(() => {
    const repairRequired = () => setPush((current) => ({ ...current, status: 'error' }));
    window.addEventListener('ours-push-repair-required', repairRequired);
    return () => window.removeEventListener('ours-push-repair-required', repairRequired);
  }, []);

  useEffect(() => {
    if (window.location.pathname === '/') window.history.replaceState(null, '', chatPath());
    desktop.current = window.matchMedia('(min-width: 861px)');
    const onRoute = () => dispatch({ type: 'route', route: parseRoute(window.location.pathname) });
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const cid = selectedContactCid(stateRef.current);
      if (cid) void markVisibleRead(cid);
      void clearPushNotifications();
      if (worker.registration) void currentPushState(worker.registration).then(setPush).catch(() =>
        setPush((current) => ({ ...current, status: 'error' })));
    };
    window.addEventListener('popstate', onRoute);
    document.addEventListener('visibilitychange', onVisible);
    const handleEvent = (event: ServerEvent) => {
      const wireKey = event.type === 'sync_required'
        ? `${event.type}:${event.reason}`
        : event.type === 'receipt_received'
          ? `${event.type}:${event.contact_id}:${event.kind}:${event.wire_ids.join(',')}`
          : `${event.type}:${event.contact_id}:${event.wire_id}`;
      const now = Date.now();
      const previous = recentEvents.current.get(wireKey) ?? 0;
      recentEvents.current.set(wireKey, now);
      for (const [key, time] of recentEvents.current) if (now - time > 60_000) recentEvents.current.delete(key);
      if (now - previous < 60_000) return;
      void (async () => {
        if (event.type === 'sync_required') { await refreshSnapshot(); return; }
        void refreshContacts().catch(showError);
        if (event.type === 'file_received') {
          await convergeFile(event.contact_id, event.wire_id);
          const contact = stateRef.current.contacts.contacts.find((item) => item.container_id === event.contact_id);
          if (selectedContactCid(stateRef.current) !== event.contact_id && contact) pushToast(event.contact_id, contact.name, 'New file');
          return;
        }
        if (event.type === 'message_received') {
          const contact = stateRef.current.contacts.contacts.find((item) => item.container_id === event.contact_id);
          await converge(
            event.contact_id,
            (page) => page.messages.some((item) => item.wire_id === event.wire_id),
            `message:${event.wire_id}`,
          );
          if (selectedContactCid(stateRef.current) === event.contact_id) await markVisibleRead(event.contact_id);
          else if (contact) pushToast(event.contact_id, contact.name, 'New message');
          return;
        }
        // APPLY IT NOW, from the payload the event already carries. The poll
        // below is confirmation, not the mechanism: it reconciles with canonical
        // state and catches anything the event did not name. Before this, the
        // event's kind and wire ids were discarded and the client went back to
        // the server to rediscover what it had just been told.
        dispatch({
          type: 'receipt', contactCid: event.contact_id, kind: event.kind, wireIds: event.wire_ids,
        });
        await converge(event.contact_id, (page) => event.wire_ids.every((wireId) => {
          const row = page.messages.find((item) => item.wire_id === wireId);
          return !!row?.receipt && receiptRank[row.receipt] >= receiptRank[event.kind];
        }), `receipt:${event.wire_ids.join(',')}`);
      })().catch(showError);
    };
    const disconnectLive = listenLiveEvents(handleEvent);
    const disconnect = connectEvents(handleEvent, (connection) => dispatch({ type: 'connection', connection }));
    void refreshSnapshot().then((cid) => { if (cid) void markVisibleRead(cid); });
    return () => { disconnect(); disconnectLive(); window.removeEventListener('popstate', onRoute); document.removeEventListener('visibilitychange', onVisible); };
  }, [converge, convergeFile, dispatch, markVisibleRead, pushToast, refreshContacts, refreshSnapshot, showError, worker.registration]);

  const go = (route: AppRoute, path: string, mobileDetailOpen?: boolean) => {
    window.history.pushState(null, '', path);
    dispatch({ type: 'route', route, mobileDetailOpen });
  };
  const selectContact = async (cid: string) => {
    go({ name: 'chats', contactCid: cid }, chatPath(cid), true);
    clearToasts(cid);
    await Promise.all([refreshPage(cid), refreshFiles(cid, false)]);
    await markVisibleRead(cid);
  };
  const loadOlder = async (cid: string) => {
    const current = pageFor(stateRef.current, cid);
    if (!current?.nextBefore || historyLoads.current.has(cid)) return;
    historyLoads.current.add(cid); setHistoryBusy(cid);
    try {
      const page = await api.conversation(cid, current.nextBefore);
      dispatch({ type: 'older_page', contactCid: cid, page, newer: current.messages });
    } catch (error) { showError(error); }
    finally { historyLoads.current.delete(cid); setHistoryBusy(null); }
  };

  const selectedCid = selectedContactCid(state);
  const selected = state.contacts.contacts.find((item) => item.container_id === selectedCid);
  const viewContacts = useMemo(() => contactViews(state, files), [state, files]);
  const selectedView = viewContacts.find((item) => item.id === selectedCid) ?? null;
  const messages = selectedCid ? timeline(pageFor(state, selectedCid), files[selectedCid] ?? []) : [];
  const identity = state.identity;
  // What the conversation header reports while canonical state is behind the
  // screen. Every branch is derived from state, so it clears by itself.
  const syncing: 'connecting' | 'updating' | null = !state.loaded
    ? 'connecting'
    : selectedCid && !pageFor(state, selectedCid)
      ? 'updating'
      : anchorPending
        ? 'updating'
        : state.connection !== 'live'
          ? 'connecting'
          : null;
  const updatePush = async (action: 'enable' | 'disable' | 'repair', preview: PushPreviewMode = push.preview) => {
    if (!worker.registration) return;
    setPushBusy(true); setPush((current) => ({ ...current, status: 'repairing', preview }));
    try {
      setPush(await (action === 'enable' ? enablePush(worker.registration, { preview })
        : action === 'repair' ? repairPush(worker.registration, preview)
          : disablePush(worker.registration, push)));
    }
    catch (error) { setPush((current) => ({ ...current, status: 'error' })); showError(error); }
    finally { setPushBusy(false); }
  };
  const openInvites = () => {
    setInvites([]);
    setModal('invite');
    void api.invites().then(setInvites).catch(showError);
  };

  if (state.route.name === 'not_found') return <div className="centered-screen"><h1>Page not found</h1><button className="btn primary" onClick={() => go({ name: 'chats', contactCid: null }, chatPath())}>Open chats</button></div>;
  if (!identity) return <div className={dark ? 'theme-dark' : ''} style={{ height: '100%' }}><div className="centered-screen"><p className="muted">Loading…</p></div></div>;

  return <div className={dark ? 'theme-dark' : ''} style={{ height: '100%' }}>
    <div className="app signal-app">
      <header className="commandbar">
        <div className="command-brand" aria-label="ours network"><span className="command-mark" aria-hidden>o</span><span>ours</span></div>
        <div className="command-copy"><strong>Messenger</strong><span className="command-kicker">Private conversations on ours</span></div>
        <div className={'command-health ' + (state.connection === 'live' ? 'is-live' : 'is-connecting')} role="status">
          <span aria-hidden />{state.connection === 'live' ? 'Connected' : 'Connecting'}
        </div>
        <div className="command-actions">
          {installPrompt && <button className="command-action" onClick={() => void installPrompt.prompt().then(() => setInstallPrompt(null))}>Install app</button>}
          <button className="command-action" onClick={openInvites}><Icon name="plus" /><span>New chat</span></button>
          <button className="icon-btn command-settings" title="Settings" aria-label="Settings" onClick={() => setModal('settings')}><Icon name="settings" /></button>
          <button className="rail-me command-me" title={identity.name} onClick={() => setMenuOpen((value) => !value)}>{initials(identity.name)}<span className={'conn-dot ' + (state.connection === 'live' ? 'on' : 'off')} /></button>
        </div>
      </header>
      <main className={'section signal-stage' + (state.mobileDetailOpen ? ' show-detail' : '')}>
        <ChatList contacts={viewContacts} roots={rootViews(state.contacts)} selected={selectedCid} onSelect={(cid) => { if (!cid.startsWith('pending:')) void selectContact(cid); }} onInvite={openInvites} onSettings={() => setModal('settings')} />
        <Conversation
          key={selectedCid ?? 'no-conversation'} contact={selectedView} messages={messages} syncing={syncing}
          hiddenEarlier={pageFor(state, selectedCid ?? '')?.hasMore ? Math.max(1, (pageFor(state, selectedCid ?? '')?.total ?? messages.length) - messages.length) : 0}
          onLoadEarlier={selectedCid && historyBusy !== selectedCid ? () => void loadOlder(selectedCid) : undefined}
          onBack={() => go({ name: 'chats', contactCid: null }, chatPath(), false)}
          onDraftChange={noteDraftPresence}
          onSend={async (text, reply, signal) => {
            if (!selectedCid) return;
            const cid = selectedCid;
            const sent = await api.send(cid, text, reply, signal);
            dispatch({
              type: 'sent_message',
              contactCid: cid,
              message: {
                dir: 'out', text, date: new Date().toISOString(), read: true,
                wire_id: sent.wire_id ?? '', receipt: null,
                reply_to: reply ? { wire_id: reply } : null,
              },
            });
            if (sent.wire_id) {
              void converge(
                cid,
                (page) => page.messages.some((message) => message.wire_id === sent.wire_id),
                `send:${sent.wire_id}`,
              );
            } else {
              // An introduction-carried send: converging on its wire id would poll
              // the full 10.5s schedule for a canonical row that is never written.
              // The local row IS the record. What did change is the contact list —
              // the introduction created this edge — so refresh that instead.
              void refreshContacts().catch(showError);
            }
            // The composer's own bubble is already on screen; handing back the
            // wire id lets it become the confirmed message in place instead of
            // being replaced by a second one. An introduction-carried send has
            // none to hand over, and the composer retires its copy in favour of
            // the row this dispatch just put in the store.
            return sent.wire_id ?? undefined;
          }}
          onSendFile={async (att, reply) => { if (!selectedCid) return; await api.sendFile(selectedCid, new Blob([att.bytes as BlobPart], { type: att.mime }), att.filename, att.mime, reply); await Promise.all([refreshFiles(selectedCid), refreshPage(selectedCid, false)]); }}
          onFetchFile={async (wireId) => { await api.fetchFiles([wireId]); if (selectedCid) await refreshFiles(selectedCid); }}
          onRename={(name) => { if (selectedCid) void api.renameContact(selectedCid, name).then(refreshSnapshot).catch(showError); }}
          onRemove={() => { if (selectedCid && confirm(`Remove “${selected?.name ?? 'contact'}”?`)) void api.removeContact(selectedCid).then(() => { go({ name: 'chats', contactCid: null }, chatPath(), false); return refreshSnapshot(); }).catch(showError); }}
        />
      </main>
      <nav className="mobile-tabbar" aria-label="Primary navigation">
        <button className="mobile-tab active" aria-current="page"><Icon name="chat" /><span>Chats</span></button>
        <button className="mobile-tab" onClick={() => setModal('settings')}><Icon name="bell" /><span>Alerts</span></button>
        <button className="mobile-tab" onClick={() => setModal('settings')}><Icon name="settings" /><span>Settings</span></button>
      </nav>
      <div className="app-banners">
        {worker.offline && <div className="banner warn">Offline — reconnecting to the network…</div>}
        {state.connection !== 'live' && <div className="banner warn">{state.connection === 'retrying' ? 'Live updates interrupted — reconnecting…' : 'Connecting to live updates…'}</div>}
        {worker.updateAvailable && <div className="banner info">A new version is available.<span className="banner-actions"><button className="linkbtn" onClick={() => { if (worker.registration) void activateWorkerUpdate(worker.registration); }}>Restart now</button></span></div>}
        {state.contacts.pending.map((pending) => <div className="banner info" key={pending.container_id}>Introduction from {pending.name} · {pending.queued} queued<span className="banner-actions"><button className="linkbtn" onClick={() => void api.respondToIntroduction(pending.container_id, 'approve').then(refreshSnapshot).catch(showError)}>Approve</button><button className="linkbtn quiet" onClick={() => void api.respondToIntroduction(pending.container_id, 'reject').then(refreshSnapshot).catch(showError)}>Reject</button></span></div>)}
        <MessageToasts items={toasts} onDismiss={dismissToast} onOpen={(cid) => void selectContact(cid)} />
      </div>
      {menuOpen && <><div className="pop-backdrop" onClick={() => setMenuOpen(false)} /><div className="menu command-menu"><div className="menu-head"><div className="avatar accent lg">{initials(identity.name)}</div><div><strong>{identity.name}</strong><div className="faint mono">@{shortCid(identity.cid)}</div></div></div><button className="menu-item" onClick={() => { setMenuOpen(false); openInvites(); }}><Icon name="plus" />Invite a contact</button><button className="menu-item" onClick={() => { setMenuOpen(false); setModal('settings'); }}><Icon name="settings" />Settings</button></div></>}
      {modal === 'invite' && <InviteModal identity={identity} invites={invites} onRefresh={async () => setInvites(await api.invites())} onCreate={async (mode, name) => { const result = await api.createInvite(mode, name); return result.blob; }} onAccept={async (invite, name) => { await api.addContact(invite, name); await refreshSnapshot(); }} onRevoke={async (id) => { await api.revokeInvite(id); }} onClose={() => { setModal(null); void refreshSnapshot(); }} />}
      {modal === 'settings' && <SettingsModal identity={identity} push={push} workerSupported={worker.supported} busy={pushBusy} offline={worker.offline} updateAvailable={worker.updateAvailable} build={build} dark={dark} onToggleDark={() => setDark((value) => { localStorage.setItem(DARK_KEY, value ? '0' : '1'); return !value; })} onSaveBio={async (bio) => { await api.setBio(bio); await refreshSnapshot(); }} onPushAction={updatePush} onReloadUpdate={() => { if (worker.registration) void activateWorkerUpdate(worker.registration); }} onClose={() => { modalRef.current = null; setModal(null); if (selectedCid) void markVisibleRead(selectedCid); }} />}
      {state.error && <div className="banner error">{state.error}<button className="linkbtn" onClick={() => dispatch({ type: 'error', message: null })}>dismiss</button></div>}
    </div>
  </div>;
}
