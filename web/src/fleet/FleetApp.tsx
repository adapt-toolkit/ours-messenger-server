import { LiveAgentConversations } from './LiveAgentConversations';
import { DraftConversation } from './DraftConversation';
import { AcpConversation } from './AcpConversation';
import { useEffect, useRef, useState } from 'react';
import { Plus, Moon, Sun, Settings, User, MoreHorizontal, X, ChevronDown, FolderInput, Bot, ClipboardList, Users, MessageCircle } from 'lucide-react';
import DialogShell from '../ui/DialogShell';
import { Conversation } from '../ui/Chats';
import type { ChatMessage } from '../ui/chatTypes';
import { Button, Row, MenuAction, SearchField, PageHeader } from './components';
import { contact, initialContacts, statuses, type Agent, type Task, type Section, type Page, type Modal } from './model';
import { ChatSetup, type DraftAgent } from './ChatSetup';
import { AgentActivity } from './AgentActivity';
import { LiveDialogs } from './LiveDialogs';
import { ConfigurationProvider } from './Configuration';
import { LocalLogin } from './LocalLogin';
import { LiveSettings, LiveProfile } from './LiveSettings';
import { fleet, messenger, agentView, taskView, contactViews, messengerHistory, agentHistory } from './live-api';
import { ProfilePage, SettingsPage, AccountPage } from './pages';
import { IconButton, TextButton } from '../ui/Button';
import { SessionList, type ChatScope, type WorkspaceView } from './SessionList';
import './fleet.css';
import { NotificationProvider, NotificationBadge, AgentRequests, useNotifications } from './Notifications';
import { countAt } from './notifications';

function LauncherIcon() {
  return <svg className="fleet-launcher-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <rect key={i} x={3 + (i % 3) * 7} y={3 + Math.floor(i / 3) * 7} width="4" height="4" rx=".6" />)}</svg>;
}

export default function FleetApp() { return <LocalLogin><ConfigurationProvider live><NotificationProvider live><FleetAppContent /></NotificationProvider></ConfigurationProvider></LocalLogin>; }
function FleetAppContent() {
  const notifications = useNotifications();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [draftAgent, setDraftAgent] = useState<DraftAgent | null>(null);
  const startedDrafts = useRef(new Set<string>());
  const [tasks, setTasks] = useState<Task[]>([]);
  const [contacts, setContacts] = useState<typeof initialContacts>([]);
  const [histories, setHistories] = useState<Record<string, ChatMessage[]>>({});
  const [lists, setLists] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('work');
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [modal, rawSetModal] = useState<Modal>(null);
  const modalTrigger = useRef<HTMLElement | null>(null);
  const setModal = (next: Modal) => {
    if(next && !modal && document.activeElement instanceof HTMLElement) modalTrigger.current = document.activeElement;
    rawSetModal(next);
  };
  const [lifetime, setLifetime] = useState('Persistent');
  const [scope, setScope] = useState<ChatScope>('All');
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('All work');
  const chatSource = useRef<Section>('work');
  const parentSearch = useRef('');
  const [nested, setNested] = useState<string | null>(null);
  const [workChat, setWorkChat] = useState<string | null>(null);
  const [messengerChat, setMessengerChat] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [search, setSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [listFilter, setListFilter] = useState('All lists');
  const [dark, setDark] = useState(() => localStorage.getItem('ours-fleet-dark') !== '0');
  const [toast, setToast] = useState('');
  const [coordinatorWelcomed, setCoordinatorWelcomed] = useState(false);
  const [openedChats, setOpenedChats] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const historyReady = useRef(false);
  const pageRef = useRef(page); pageRef.current = page;
  const pageStack = useRef<Page[]>([]);
  const profileSource = useRef<Page>({ kind: 'home' });
  const profileTrigger = useRef<HTMLElement | null>(null);
  const profileStackStart = useRef(0);
  const isProfile = (p: Page) => p.kind === 'profile' || p.kind === 'contacts';
  const displayPage = isProfile(page) ? profileSource.current : page;
  const activeId = section === 'messenger' ? messengerChat : workChat;
  const task = tasks.find(t => t.id === nested);
  const selectedTask = displayPage.kind === 'task' ? tasks.find(t => t.id === displayPage.id) : undefined;
  const notify = (text: string) => { setToast(text); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(''), 4000); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { document.documentElement.classList.toggle('theme-dark', dark); localStorage.setItem('ours-fleet-dark', dark ? '1' : '0'); return () => document.documentElement.classList.remove('theme-dark'); }, [dark]);
  const go = (next: Page) => {
    if(isProfile(next) && !isProfile(pageRef.current)) {
      profileSource.current = pageRef.current;
      profileStackStart.current = pageStack.current.length;
      profileTrigger.current = modal ? modalTrigger.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    pageStack.current.push(pageRef.current); setPage(next); setModal(null);
  };
  const closeProfile = () => {
    setPage(profileSource.current); setModal(null);
    pageStack.current.length = profileStackStart.current;
    requestAnimationFrame(() => { if(profileTrigger.current?.isConnected) profileTrigger.current.focus({ preventScroll: true }); });
  };
  const backPage = () => { setPage(pageStack.current.pop() ?? { kind: 'home' }); setModal(null); };
  const switchSection = (s: Section) => { setSection(s === 'work' ? chatSource.current : s); if(s === 'messenger') { setScope('External'); setNested(null); chatSource.current = s; } go({ kind: 'home' }); setMobileDetail(false); };
  useEffect(() => {
    const read = () => {
      const bits = location.pathname.replace(/^\/fleet\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      if (bits[0] === 'chats') {
        const q = new URLSearchParams(location.search);
        const source = q.get('source') === 'messenger' ? 'messenger' : 'work';
        setSection(source); chatSource.current = source; setPage({ kind: 'home' });
        setScope((['All', 'Workspace', 'External'].includes(q.get('scope') ?? '') ? q.get('scope') : 'All') as ChatScope);
        setWorkspaceView((['All work', 'Agents', 'Tasks'].includes(q.get('view') ?? '') ? q.get('view') : 'All work') as WorkspaceView);
        setLifetime(q.get('lifetime') === 'Temporary' ? 'Temporary' : 'Persistent');
        setNested(q.get('task')); setSearch(q.get('search') ?? ''); parentSearch.current = q.get('parentSearch') ?? '';
        const id = q.get('chat'); setMobileDetail(q.get('detail') === '1');
        if(source === 'messenger') setMessengerChat(id); else setWorkChat(id);
        if(id) { notifications.read(id); setOpenedChats(x => [...new Set([...x, id])]); }
      }
      else if (bits[0] === 'tasks') { setSection('tasks'); setPage(bits[1] ? { kind: 'task', id: bits[1] } : { kind: 'home' }); }
      else if (bits[0] === 'profile') setPage(bits[2] === 'contacts' ? { kind: 'contacts', id: bits[1] ?? 'human', peer: bits[3] } : { kind: 'profile', id: bits[1] ?? 'human' });
      else if (bits[0] === 'settings') setPage({ kind: 'settings', editor: bits.slice(1).join('/') || undefined });
      else if (bits[0] === 'account') setPage({ kind: 'account', step: bits[1] ?? 'login' });
      else if (bits[0] === 'empty') setPage({ kind: 'empty' });
      else if (bits[0] === 'messenger') { setScope('External'); setNested(null); chatSource.current = 'messenger'; setSection('messenger'); setPage({ kind: 'home' }); if(bits[1]) { notifications.read(bits[1]); setMessengerChat(bits[1]); const own = agents.find(a => `messenger-${a.id}` === bits[1]); if(own) setContacts(x => x.some(c => c.id === bits[1]) ? x : [...x, contact(bits[1], own.name)]); setMobileDetail(true); setOpenedChats(x => [...new Set([...x, bits[1]])]); } }
      else { setNested(null); setMobileDetail(false); chatSource.current = 'work'; setSection('work'); setPage({ kind: 'home' }); if(bits[1]) { notifications.read(bits[1]); setWorkChat(bits[1]); setMobileDetail(true); setOpenedChats(x => [...new Set([...x, bits[1]])]); const a = agents.find(a => a.id === bits[1]); if(a) { setLifetime(a.lifetime); setNested(a.taskId ?? null); } else if(bits[1].startsWith('room-')) { setLifetime('Temporary'); setNested(bits[1].slice(5)); } } }
      setModal(null);
    };
    read(); historyReady.current = true;
    addEventListener('popstate', read); return () => removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if(!historyReady.current) return;
    let path = '/fleet';
    if(page.kind === 'home') {
      if(section === 'tasks') path += '/tasks';
      else {
        const q = new URLSearchParams();
        if(scope !== 'All') q.set('scope', scope);
        if(workspaceView !== 'All work') q.set('view', workspaceView);
        if(lifetime !== 'Persistent') q.set('lifetime', lifetime);
        if(nested) { q.set('task', nested); if(parentSearch.current) q.set('parentSearch', parentSearch.current); }
        if(search) q.set('search', search);
        if(section === 'messenger') q.set('source', section);
        if(activeId) q.set('chat', activeId);
        if(mobileDetail) q.set('detail', '1');
        path += '/chats' + (q.size ? '?' + q.toString() : '');
      }
    }
    else if(page.kind === 'task') path += `/tasks/${page.id}`;
    else if(page.kind === 'profile' || page.kind === 'contacts') path += `/profile/${page.id}${page.kind === 'contacts' ? '/contacts' + (page.peer ? '/' + encodeURIComponent(page.peer) : '') : ''}`;
    else if(page.kind === 'settings') path += `/settings${page.editor ? '/' + page.editor : ''}`;
    else if(page.kind === 'account') path += `/account/${page.step}`;
    else path += '/empty';
    if(location.pathname + location.search !== path) window.history.pushState({}, '', path);
  }, [section, page, mobileDetail, workChat, messengerChat, scope, workspaceView, lifetime, nested, search]);
  const knownAgents = useRef(agents);
  // Creation can select an agent in the same render that adds it to the collection.
  useEffect(() => {
    if(knownAgents.current === agents) return;
    knownAgents.current = agents;
    const agent = agents.find(a => a.id === workChat);
    if(agent) {
      if (!agent.taskId) setNested(null);
      if(!agent.taskId && scope === 'Workspace' && workspaceView === 'Agents') setLifetime(agent.lifetime);
    }
  }, [workChat, agents]);
  const openChat = (id: string, target: Section = 'work') => {
    notifications.read(id);
    setOpenedChats(x => [...new Set([...x, id])]);
    chatSource.current = target;
    if(target === 'messenger' && scope === 'Workspace') setScope('External');
    if(target === 'work' && scope === 'External') setScope('Workspace');
    if(target === 'messenger') { setNested(null); setMessengerChat(id); const ownerAgent = agents.find(a => `messenger-${a.id}` === id); if(ownerAgent) setContacts(x => x.some(c => c.id === id) ? x : [...x, contact(id, ownerAgent.name)]); } else { setWorkChat(id); const a = agents.find(a => a.id === id); if(a && !(scope === 'Workspace' && workspaceView === 'Agents' && !nested)) { if(a.taskId && !nested) { parentSearch.current = search; setSearch(''); } setNested(a.taskId ?? null); } }
    setSection(target); setPage({ kind: 'home' }); setMobileDetail(true); setModal(null);
  };
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const rawTasks = useRef<any[]>([]);
  const refresh = async () => {
    const [roles, taskData, listData] = await Promise.all([fleet('/roles?includeTemporary=true'), fleet('/tasks'), fleet('/task-lists')]);
    setAgents(roles.roles.map((r: any) => ({ ...agentView(r), taskId: taskData.tasks.find((t: any) => t.member_roles.some((m: any) => m.name === r.role.id))?.task_id }))); setTasks(taskData.tasks.map(taskView));
    rawTasks.current = taskData.tasks;
    setLists(listData.lists.map((l: any) => l.name));
    try { setContacts(await contactViews()); setLoadError(''); }
    catch (e) { setLoadError('Messenger: ' + (e as Error).message); }
    setLoaded(true);
  };
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { await refresh(); } catch (e) { if (active) setLoadError((e as Error).message); } finally { if (active) timer = setTimeout(tick, 10000); } };
    void tick(); return () => { active = false; clearTimeout(timer); };
  }, []);
  const history = async (id: string) => {
    const roomCid = id.startsWith('room-') ? rawTasks.current.find(t => t.task_id === id.slice(5))?.room_identity_cid : undefined;
    if (id.startsWith('room-') && !roomCid) throw new Error('This task has no room yet.');
    const messages = contacts.some(c => c.id === id) || roomCid ? await messengerHistory(roomCid ?? id) : await agentHistory(id);
    setHistories(x => ({ ...x, [id]: messages }));
    if ((contacts.some(c => c.id === id) || roomCid) && document.visibilityState === 'visible' && page.kind === 'home' && section !== 'tasks' && (!matchMedia('(max-width: 700px)').matches || mobileDetail)) { await messenger.markRead(roomCid ?? id); notifications.read(id); }
  };
  useEffect(() => {
    if (!activeId || activeId.startsWith('draft-') || !loaded || agents.some(a => a.id === activeId)) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { await history(activeId); } catch (e) { if (active) setLoadError((e as Error).message); } finally { if (active) timer = setTimeout(tick, 3000); } };
    void tick();
    const events = new EventSource('/messenger/api/events');
    events.onmessage = () => { void history(activeId).catch(() => {}); };
    events.addEventListener('sync_required', () => { void history(activeId).catch(() => {}); });
    return () => { active = false; clearTimeout(timer); events.close(); };
  }, [activeId, loaded, contacts.map(c => c.id).join(','), agents.map(a => a.id).join(','), page.kind, section, mobileDetail]);
  const newChat = () => { const id='draft-'+crypto.randomUUID(); setDraftAgent({id,name:'',role:'',brain:'',permissions:'Ask before changes',folder:''}); setNested(null); openChat(id); };
  const completeOnboarding = () => {};
  const openRoom = (id: string, showChat = true) => { if(!nested) parentSearch.current = search; setSearch(''); setNested(id); if (showChat) openChat(`room-${id}`); else { setWorkChat(null); setSection('work'); setPage({kind:'home'}); } setMobileDetail(showChat); };
  const updateTask = (id: string, patch: Partial<Task>) => {
    const action = patch.status === 'Provisioning' ? 'start' : patch.status === 'Review' ? 'review' : '';
    if (!action) { notify('This change is not available.'); return; }
    void fleet(`/tasks/${id}/${action}`, {}).then(async result => { await refresh(); if (result.provisioning?.blocker || result.provisioning?.next_action) notify(result.provisioning.blocker ?? result.provisioning.next_action); }).catch(e => notify(e.message));
  };
  const send = async (id: string, text: string, replyTo?: string) => {
    const roomCid = id.startsWith('room-') ? rawTasks.current.find(t => t.task_id === id.slice(5))?.room_identity_cid : undefined;
    if (id.startsWith('room-') && !roomCid) throw new Error('This task has no room yet.');
    if (contacts.some(c => c.id === id) || roomCid) {
      const result = await messenger.send(roomCid ?? id, text, replyTo); await history(id); return result.wire_id ?? '';
    }
    const result = await fleet(`/roles/${encodeURIComponent(id)}/input`, { text, commandId: crypto.randomUUID() });
    await history(id); return result.promptId ?? result.commandId;
  };
  const contextTaskId = selectedTask?.id ?? task?.id;

  const dialogs = modal ? <LiveDialogs key={`${modal.kind}:${modal.id ?? ''}`} modal={modal} close={() => setModal(null)} setModal={setModal} section={section} agents={agents} tasks={tasks} lists={lists} go={go} switchSection={switchSection} openChat={openChat} refresh={refresh} notify={notify} newChat={newChat} closedChat={id=>{setOpenedChats(x=>x.filter(v=>v!==id));setWorkChat(null);setMobileDetail(false);setPage({kind:'home'});}} /> : null;

  return <div className={'fleet-app' + (mobileDetail && displayPage.kind === 'home' && section !== 'tasks' ? ' fleet-in-chat' : '') + (displayPage.kind === 'account' ? ' fleet-account-mode' : '')}>
    <header className="fleet-nav" hidden={displayPage.kind === 'account'}>
      <button className="fleet-brand" onClick={() => switchSection('work')}>ours<span className="fleet-preview">Local</span></button>
      <TextButton className="fleet-section-trigger" aria-label={`Change section: ${section === 'tasks' ? 'Tasks' : 'Chats'}`} aria-haspopup="dialog" aria-expanded={modal?.kind === 'navigation'} onClick={() => setModal({ kind: 'navigation' })}><span>{section === 'tasks' ? 'Tasks' : 'Chats'}</span><ChevronDown size={12} aria-hidden /></TextButton>
      <IconButton className=" fleet-nav-trigger" aria-label="Navigate" onClick={() => setModal({ kind: 'navigation' })}><LauncherIcon /><NotificationBadge node="root" /></IconButton>

      <span className="fleet-host">{loaded ? 'Connected to Fleet' : 'Connecting…'}</span>
      <div className="fleet-actions"><Button primary aria-label="Add or connect" onClick={() => setModal({ kind: 'add' })}><Plus size={18} /></Button><IconButton className="" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(x => !x)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</IconButton><IconButton className=" fleet-desktop-control" aria-label="Settings" onClick={() => go({ kind: 'settings' })}><Settings size={18} /></IconButton><IconButton className=" fleet-desktop-control" aria-label="My profile" onClick={() => go({ kind: 'profile', id: 'human' })}><User size={18} /></IconButton></div>
    </header>
    <div className="fleet-body">
      {loadError && <div className="fleet-live-error" role="alert">{loadError}<Button onClick={() => void refresh().catch(e => setLoadError(e.message))}>Retry</Button></div>}
      <div className={'fleet-workspace' + (mobileDetail ? ' fleet-show-detail' : '')} hidden={displayPage.kind !== 'home' || section === 'tasks'}>
        <aside className="fleet-list fleet-messenger-list signal-stage" aria-label="Chats">
          <SessionList invite={() => setModal({ kind: 'add' })} settings={() => go({ kind: 'settings' })} agents={agents} tasks={tasks} contacts={contacts} task={task} selected={activeId} scope={scope} workspaceView={workspaceView} lifetime={lifetime} search={search} setSearch={setSearch} setScope={value => { setScope(value); setNested(null); }} setWorkspaceView={setWorkspaceView} setLifetime={setLifetime} leaveTask={() => { setNested(null); setSearch(parentSearch.current); setMobileDetail(false); setWorkChat(null); }} openChat={openChat} openExternal={id => openChat(id, 'messenger')} openRoom={openRoom} taskMenu={id => setModal({ kind: 'task-menu', id })} approve={async id => { await messenger.respondToIntroduction(id, 'approve'); await refresh(); return true; }} reject={async id => { await messenger.respondToIntroduction(id, 'reject'); await refresh(); return true; }} />
        </aside>
        <section className="fleet-conversation" aria-label={section === 'messenger' ? 'Messenger' : 'My Agent chat'}>
          {!activeId && <div className="fleet-no-conversation"><h2>Choose a conversation</h2><p>Your agents and their chats are in the list. Open one whenever you’re ready.</p></div>}
          {openedChats.map(id => { if(id.startsWith('draft-')) return draftAgent?.id===id ? <div key={id} className="fleet-chat-slot" hidden={activeId!==id}><DraftConversation dark={dark} back={()=>setMobileDetail(false)} ready={async roleId=>{await refresh(); setOpenedChats(x=>x.filter(x=>x!==id)); setDraftAgent(null); openChat(roleId);}}/></div> : null; const a = agents.find(a => a.id === id || `messenger-${a.id}` === id); const peer = id.startsWith('room-') ? rawTasks.current.find(t => t.task_id === id.slice(5))?.room_identity_cid : id; if (a && a.id === id) return <div key={id} className="fleet-chat-slot" hidden={activeId !== id}><AcpConversation id={id} name={a.name} active={activeId === id && page.kind === 'home' && section !== 'tasks' && (!matchMedia('(max-width: 700px)').matches || mobileDetail)} dark={dark} back={() => setMobileDetail(false)} actions={() => go({kind:'profile',id})}/></div>; const c = contacts.find(c => c.id === peer) ?? contact(peer ?? id, id.startsWith('room-') ? 'Room' : a?.name ?? (draftAgent?.id === id ? 'New chat' : 'Agent')); return <div key={id} className="fleet-chat-slot signal-stage show-detail" hidden={activeId !== id}><Conversation backAdornment={<NotificationBadge node="root" excludeChat={id} />} headerActions={<div className="fleet-header-actions">{section === 'work' && (a || id.startsWith('room-')) && <IconButton className="" aria-label={id.startsWith('room-') ? 'Room actions' : 'Agent actions'} onClick={() => id.startsWith('room-') ? setModal({kind:'members',id:id.slice(5)}) : go({kind:'profile',id:a?.id??id})}><MoreHorizontal size={20} /></IconButton>}<IconButton className=" fleet-desktop-control" aria-label="Close conversation" onClick={() => { if(section === 'messenger') setMessengerChat(null); else setWorkChat(null); setMobileDetail(false); }}><X size={18} /></IconButton></div>} timelineFooter={<AgentRequests chat={id} />} contact={c} messages={histories[id] ?? []} onBack={() => setMobileDetail(false)} onOpenContact={draftAgent?.id === id && !a ? undefined : () => id.startsWith('room-') ? setModal({ kind: 'members', id: id.slice(5) }) : go({ kind: 'profile', id })} onSend={(text, reply) => send(id, text, reply)} onSendFile={contacts.some(c => c.id === id) || (id.startsWith('room-') && rawTasks.current.find(t => t.task_id === id.slice(5))?.room_identity_cid) ? async (att, reply) => { const peer = id.startsWith('room-') ? rawTasks.current.find(t => t.task_id === id.slice(5))!.room_identity_cid : id; await messenger.sendFile(peer, new Blob([new Uint8Array(att.bytes)]), att.filename, att.mime, reply); await history(id); } : undefined} /></div>; })}
        </section>
      </div>
      {displayPage.kind === 'home' && section === 'tasks' && <main className="fleet-page fleet-board-page"><PageHeader title="Tasks" actions={<><select className="field" aria-label="Filter task list" value={listFilter} onChange={e => setListFilter(e.target.value)}>{['All lists', ...lists].map(l => <option key={l}>{l}</option>)}</select><Button onClick={() => setModal({ kind: 'lists' })}>Manage lists</Button></>} /><SearchField value={taskSearch} onChange={setTaskSearch} placeholder="Search tasks" /><div className="fleet-board">{statuses.map(status => { const rows = tasks.filter(t => t.status === status && (listFilter === 'All lists' || t.list === listFilter) && t.name.toLowerCase().includes(taskSearch.toLowerCase())); return <section key={status} className="fleet-column"><h2>{status} <span>{rows.length}</span></h2>{rows.map(t => <button key={t.id} className="fleet-task-card" onClick={() => go({ kind: 'task', id: t.id })}><strong>{t.name}<NotificationBadge node={`task:${t.id}`} /></strong><span>{t.list}</span><small className={t.blocked ? 'fleet-warning' : ''}>{t.blocked ? `Blocked · ${t.blocked}` : t.status === 'Provisioning' ? 'Provisioning' : t.status === 'Backlog' ? 'Not started' : t.status === 'Failed' ? 'Launch failed' : t.status === 'Done' ? 'Completed' : `${t.agents.length} agents`}</small></button>)}</section>; })}</div></main>}
      {displayPage.kind === 'task' && (selectedTask ? <main className="fleet-page"><PageHeader title={selectedTask.name} subtitle={`TASK · ${selectedTask.id}`} onBack={backPage} actions={<><Button onClick={() => setModal({ kind: 'task-menu', id: selectedTask.id })}>{selectedTask.status} ▾</Button>{['Backlog','Active'].includes(selectedTask.status) && <Button primary disabled={!!selectedTask.pending} onClick={() => { updateTask(selectedTask.id, { status: selectedTask.status === 'Backlog' ? 'Provisioning' : 'Review' });  }}>{selectedTask.status === 'Backlog' ? 'Start task' : 'Send to review →'}</Button>}</>} /><div className="fleet-task-detail"><section><h2>Description</h2><p>{selectedTask.description}</p>{selectedTask.pending && <p role="status">{selectedTask.pending}</p>}{selectedTask.blocked && <p className="fleet-warning">Blocked · {selectedTask.blocked}</p>}<h2>Work <span className="muted">{selectedTask.agents.length} agents</span></h2><Row title={`${selectedTask.name} · Room`} subtitle={selectedTask.closed ? 'Closed' : selectedTask.status === 'Backlog' ? 'Not started' : selectedTask.status} avatar="#" onClick={() => openRoom(selectedTask.id)} />{selectedTask.agents.map(id => { const a = agents.find(a => a.id === id); return a && <div key={id} className="fleet-member"><Row title={a.name} subtitle={a.state} onClick={() => openChat(a.id)} /></div>; })}{!selectedTask.agents.length && <p>Task members appear here after the room starts.</p>}</section><aside><h2>Details</h2><MenuAction icon={FolderInput} title="List" description={selectedTask.list} onClick={() => setModal({ kind: 'move-task', id: selectedTask.id })} /><p className="muted">Created from Workspace</p></aside></div></main> : <main className="fleet-page"><PageHeader title="Task no longer available" onBack={() => switchSection('tasks')} /></main>)}
      {(page.kind === 'profile' || page.kind === 'contacts') && <DialogShell title="Profile" wide onClose={closeProfile} className="fleet-modal fleet-profile-modal">{!modal && (page.kind==='contacts' && agents.find(a=>a.id===page.id) ? <LiveAgentConversations key={page.id} agent={agents.find(a=>a.id===page.id)!} peer={page.peer} go={go}/> : <LiveProfile id={page.id} agents={agents} go={go} modal={setModal} tasks={tasks} />)}{dialogs}</DialogShell>}
      {displayPage.kind === 'settings' && <LiveSettings back={backPage} editor={displayPage.editor} go={go} />}
      {displayPage.kind === 'account' && <main className="fleet-page"><PageHeader title="Local instance" onBack={backPage} /><p>Central accounts are not enabled.</p></main>}
      {displayPage.kind === 'empty' && <main className="fleet-form-page"><PageHeader title="Your first agent session" subtitle="Start a focused conversation with an agent on Workstation." onBack={() => go({ kind: 'home' })} /><MenuAction icon={Bot} title="One agent" description="Choose a template and host folder" onClick={newChat} /><MenuAction icon={ClipboardList} title="A task with several agents" description="Create a task session with a shared room" onClick={() => setModal({ kind: 'new-task' })} /><MenuAction icon={Users} title="Persistent agents" description="Configured agents appear here when available" onClick={() => switchSection('work')} /><MenuAction icon={MessageCircle} title="Looking for someone?" description="Open external chats" onClick={() => switchSection('messenger')} /></main>}
    </div>
    {!isProfile(page) && dialogs}
    {toast && <div className="fleet-toast" role="status">{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}>×</button></div>}
  </div>;
}
