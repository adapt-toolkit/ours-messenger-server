import { useEffect, useRef, useState } from 'react';
import { Plus, Moon, Sun, Settings, User, MoreHorizontal, X } from 'lucide-react';
import DialogShell from '../ui/DialogShell';
import { ChatList, Conversation } from '../ui/Chats';
import type { ChatMessage } from '../ui/chatTypes';
import { Button, Row, SearchField, PageHeader } from './components';
import { contact, initialAgents, initialContacts, initialMessages, initialTasks, statuses, type Agent, type Task, type Section, type Page, type Modal } from './model';
import { ChatSetup, type DraftAgent } from './ChatSetup';
import { AgentActivity } from './AgentActivity';
import { FleetDialogs } from './FleetDialogs';
import { ProfilePage, SettingsPage, AccountPage } from './pages';
import './fleet.css';

function LauncherIcon() {
  return <svg className="fleet-launcher-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <rect key={i} x={3 + (i % 3) * 7} y={3 + Math.floor(i / 3) * 7} width="4" height="4" rx=".6" />)}</svg>;
}

export default function FleetApp() {
  const [agents, setAgents] = useState(initialAgents);
  const [draftAgent, setDraftAgent] = useState<DraftAgent | null>(null);
  const startedDrafts = useRef(new Set<string>());
  const [tasks, setTasks] = useState(initialTasks);
  const [contacts, setContacts] = useState(initialContacts);
  const [histories, setHistories] = useState(initialMessages);
  const [lists, setLists] = useState(['Default', 'Website', 'Product']);
  const [section, setSection] = useState<Section>('work');
  const [page, setPage] = useState<Page>({ kind: 'home' });
  const [modal, rawSetModal] = useState<Modal>(null);
  const modalTrigger = useRef<HTMLElement | null>(null);
  const setModal = (next: Modal) => {
    if(next && !modal && document.activeElement instanceof HTMLElement) modalTrigger.current = document.activeElement;
    rawSetModal(next);
  };
  const [lifetime, setLifetime] = useState('Persistent');
  const [nested, setNested] = useState<string | null>(null);
  const [workChat, setWorkChat] = useState<string | null>('coordinator');
  const [messengerChat, setMessengerChat] = useState<string | null>('maya');
  const [mobileDetail, setMobileDetail] = useState(false);
  const [search, setSearch] = useState('');
  const [taskSearch, setTaskSearch] = useState('');
  const [listFilter, setListFilter] = useState('All lists');
  const [dark, setDark] = useState(() => localStorage.getItem('ours-fleet-dark') !== '0');
  const [toast, setToast] = useState('');
  const [coordinatorWelcomed, setCoordinatorWelcomed] = useState(false);
  const [openedChats, setOpenedChats] = useState(['coordinator', 'maya']);
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
  const switchSection = (s: Section) => { setSection(s); go({ kind: 'home' }); setMobileDetail(false); };
  useEffect(() => {
    const read = () => {
      const bits = location.pathname.replace(/^\/fleet\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
      if (bits[0] === 'tasks') { setSection('tasks'); setPage(bits[1] ? { kind: 'task', id: bits[1] } : { kind: 'home' }); }
      else if (bits[0] === 'profile') setPage({ kind: bits[2] === 'contacts' ? 'contacts' : 'profile', id: bits[1] ?? 'human' });
      else if (bits[0] === 'settings') setPage({ kind: 'settings', editor: bits[1] });
      else if (bits[0] === 'account') setPage({ kind: 'account', step: bits[1] ?? 'login' });
      else if (bits[0] === 'empty') setPage({ kind: 'empty' });
      else if (bits[0] === 'messenger') { setSection('messenger'); setPage({ kind: 'home' }); if(bits[1]) { setMessengerChat(bits[1]); const own = initialAgents.find(a => `messenger-${a.id}` === bits[1]); if(own) setContacts(x => x.some(c => c.id === bits[1]) ? x : [...x, contact(bits[1], own.name)]); setMobileDetail(true); setOpenedChats(x => [...new Set([...x, bits[1]])]); } }
      else { setSection('work'); setPage({ kind: 'home' }); if(bits[1]) { setWorkChat(bits[1]); setMobileDetail(true); setOpenedChats(x => [...new Set([...x, bits[1]])]); const a = initialAgents.find(a => a.id === bits[1]); if(a) { setLifetime(a.lifetime); setNested(a.taskId ?? null); } else if(bits[1].startsWith('room-')) { setLifetime('Temporary'); setNested(bits[1].slice(5)); } } }
      setModal(null);
    };
    read(); historyReady.current = true;
    addEventListener('popstate', read); return () => removeEventListener('popstate', read);
  }, []);
  useEffect(() => {
    if(!historyReady.current) return;
    let path = '/fleet';
    if(page.kind === 'home') path += `/${section}` + (section === 'work' && mobileDetail && workChat ? `/${encodeURIComponent(workChat)}` : section === 'messenger' && mobileDetail && messengerChat ? `/${encodeURIComponent(messengerChat)}` : '');
    else if(page.kind === 'task') path += `/tasks/${page.id}`;
    else if(page.kind === 'profile' || page.kind === 'contacts') path += `/profile/${page.id}${page.kind === 'contacts' ? '/contacts' : ''}`;
    else if(page.kind === 'settings') path += `/settings${page.editor ? '/' + page.editor : ''}`;
    else if(page.kind === 'account') path += `/account/${page.step}`;
    else path += '/empty';
    if(location.pathname !== path) history.pushState({}, '', path);
  }, [section, page, mobileDetail, workChat, messengerChat]);
  useEffect(() => { const a = agents.find(a => a.id === workChat); if(a) { setLifetime(a.lifetime); setNested(a.taskId ?? null); } else if(workChat?.startsWith('room-')) { setLifetime('Temporary'); setNested(workChat.slice(5)); } }, [workChat, agents]);
  const openChat = (id: string, target: Section = 'work') => {
    setOpenedChats(x => [...new Set([...x, id])]);
    if(target === 'messenger') { setMessengerChat(id); const ownerAgent = agents.find(a => `messenger-${a.id}` === id); if(ownerAgent) setContacts(x => x.some(c => c.id === id) ? x : [...x, contact(id, ownerAgent.name)]); } else { setWorkChat(id); const a = agents.find(a => a.id === id); if(a) { setLifetime(a.lifetime); setNested(a.taskId ?? null); } }
    setSection(target); setPage({ kind: 'home' }); setMobileDetail(true); setModal(null);
  };
  const newChat = () => {
    const draft = draftAgent && !startedDrafts.current.has(draftAgent.id) ? draftAgent : { id: `agent-${crypto.randomUUID()}`, name: `Sage ${crypto.randomUUID().slice(0, 4)}`, role: 'Assistant', brain: 'Codex', permissions: 'Ask before changes', folder: '/home/you/work/website' };
    setDraftAgent(draft); setNested(null); setLifetime('Temporary'); openChat(draft.id);
  };
  const completeOnboarding = (name: string) => {
    if(!coordinatorWelcomed) {
      setHistories(x => ({ ...x, coordinator: [{ dir: 'in', text: 'Hi ' + name + '! I’m your persistent Coordinator.\n\nHere’s where to find your way around ours network:\n\n• **Sessions** — chat with your agents. Persistent keeps your configured agents; Temporary holds short chats and task rooms.\n• **Messenger** — conversations with people and connected identities.\n• **Task manager** — organize work and follow your team’s progress.\n• **Settings** — configure agent templates, roles, brains and permissions. To choose a section, open the launcher outside the chat. On your phone, tap Back to return to the list first.\n\nAsk me anything about the app, or tell me what you want to work on. I can explain how things work and help bring a team together.', date: new Date().toISOString(), read: true, wireId: 'coordinator-welcome', replyTo: null, receipt: 'read' }] }));
      setCoordinatorWelcomed(true);
    }
    openChat('coordinator');
  };
  const openRoom = (id: string, showChat = true) => { setNested(id); setLifetime('Temporary'); openChat(`room-${id}`); setMobileDetail(showChat); };
  const updateTask = (id: string, patch: Partial<Task>) => setTasks(x => x.map(t => t.id === id ? { ...t, ...patch } : t));
  const send = async (id: string, text: string, replyTo?: string) => {
    if(draftAgent?.id === id && !startedDrafts.current.has(id)) {
      startedDrafts.current.add(id);
      const created: Agent = { ...draftAgent, name: draftAgent.name.trim() || 'Sage', lifetime: 'Temporary', state: 'Ready' };
      setAgents(x => x.some(a => a.id === id) ? x : [...x, created]);
    }
    if(id.startsWith('room-') && tasks.find(t => t.id === id.slice(5))?.closed) throw new Error('This room is closed.');
    const wireId = `mock-${crypto.randomUUID()}`;
    const message: ChatMessage = { dir: 'out', text, date: new Date().toISOString(), read: true, wireId, replyTo: replyTo ? { wireId: replyTo } : null, receipt: 'delivered' };
    setHistories(x => ({ ...x, [id]: [...(x[id] ?? []), message] })); return wireId;
  };
  const contextTaskId = selectedTask?.id ?? task?.id;
  const matches = (name: string) => name.toLowerCase().includes(search.toLowerCase());

  const dialogs = modal ? <FleetDialogs section={section} newChat={newChat} embedded={isProfile(page)} modal={modal} close={() => setModal(null)} setModal={setModal} agents={agents} setAgents={setAgents} tasks={tasks} setTasks={setTasks} lists={lists} setLists={setLists} taskId={contextTaskId} openChat={openChat} openRoom={openRoom} go={go} switchSection={switchSection} notify={notify} updateTask={updateTask} /> : null;

  return <div className={'fleet-app' + (mobileDetail && displayPage.kind === 'home' && section !== 'tasks' ? ' fleet-in-chat' : '') + (displayPage.kind === 'account' ? ' fleet-account-mode' : '')}>
    <header className="fleet-nav" hidden={displayPage.kind === 'account'}>
      <button className="fleet-brand" onClick={() => switchSection('work')}>ours<span className="fleet-preview">Preview</span></button>
      <button className="icon-btn fleet-nav-trigger" aria-label="Navigate" onClick={() => setModal({ kind: 'navigation' })}><LauncherIcon /></button>

      <span className="fleet-host">Workstation · Online</span>
      <div className="fleet-actions"><button className="btn primary" aria-label="Add or connect" onClick={() => setModal({ kind: 'add' })}><Plus size={18} /></button><button className="icon-btn" aria-label={dark ? 'Use light theme' : 'Use dark theme'} onClick={() => setDark(x => !x)}>{dark ? <Sun size={18} /> : <Moon size={18} />}</button><button className="icon-btn fleet-desktop-control" aria-label="Settings" onClick={() => go({ kind: 'settings' })}><Settings size={18} /></button><button className="icon-btn fleet-desktop-control" aria-label="My profile" onClick={() => go({ kind: 'profile', id: 'human' })}><User size={18} /></button></div>
    </header>
    <div className="fleet-body">
      <div className={'fleet-workspace' + (mobileDetail ? ' fleet-show-detail' : '')} hidden={displayPage.kind !== 'home' || section === 'tasks'}>
        <aside className="fleet-list" hidden={section !== 'work'}>
          <h1>Sessions</h1><Button primary onClick={newChat}>New chat</Button><div className="fleet-segment">{['Persistent', 'Temporary'].map(v => <button key={v} aria-pressed={v === lifetime} onClick={() => { setLifetime(v); setNested(null); }}>{v}</button>)}</div>
          {task ? <><Button onClick={() => setNested(null)}>‹ Temporary</Button><h2>{task.name}</h2><p className="muted">Task · {task.agents.length} agents · Workstation</p><Row selected={workChat === `room-${task.id}`} title="Room" subtitle="Shared chat · 2 unread" avatar="#" onClick={() => openRoom(task.id)} end={<span className="fleet-badge">2</span>} />{task.agents.map(id => { const a = agents.find(a => a.id === id); return a && <Row key={id} selected={workChat === id} title={a.name} subtitle={`Direct agent chat · ${a.state}`} onClick={() => openChat(id)} />; })}<Button onClick={() => setModal({ kind: 'add-agent', id: task.id })}>＋ Agent</Button><Button onClick={() => setModal({ kind: 'task-menu', id: task.id })}>Task ⋯</Button></> : <><SearchField value={search} onChange={setSearch} placeholder={lifetime === 'Persistent' ? 'Search agents' : 'Search chats and tasks'} />{lifetime === 'Temporary' && <><div className="fleet-actions"><Button onClick={newChat}>＋ New chat</Button><Button onClick={() => setModal({ kind: 'new-task' })}>＋ Task</Button></div><h2 className="fleet-list-group">Tasks</h2>{tasks.filter(t => matches(t.name)).map(t => <Row key={t.id} selected={false} title={t.name} subtitle={`Task · ${t.agents.length} agents · ${t.status}`} onClick={() => openRoom(t.id, false)} />)}</>}{lifetime === 'Temporary' && <h2 className="fleet-list-group">Chats</h2>}{agents.filter(a => a.lifetime === lifetime && !a.taskId && matches(a.name)).map(a => <Row key={a.id} selected={a.id === workChat} title={a.name} subtitle={`${a.lifetime} · ${a.state}`} onClick={() => openChat(a.id)} />)}<p className="fleet-list-note">{lifetime === 'Persistent' ? 'Agents that stay configured' : 'Tasks and standalone temporary sessions'}</p></>}
        </aside>
        <div hidden={section !== 'messenger'} className="fleet-messenger-list signal-stage"><ChatList contacts={contacts} roots={{}} selected={messengerChat} onSelect={id => openChat(id, 'messenger')} onInvite={() => setModal({ kind: 'add' })} onSettings={() => go({ kind: 'settings' })} onApprovePending={async id => { setContacts(x => x.map(c => c.id === id ? { ...c, status: 'active' } : c)); return true; }} onRejectPending={async id => { setContacts(x => x.filter(c => c.id !== id)); return true; }} /></div>
        <section className="fleet-conversation" aria-label={section === 'messenger' ? 'Messenger' : 'My Agent chat'}>
          {!activeId && <div className="fleet-no-conversation"><h2>Choose a conversation</h2><p>Your agents and their chats are in the list. Open one whenever you’re ready.</p></div>}
          {openedChats.map(id => { const a = agents.find(a => a.id === id || `messenger-${a.id}` === id); const c = contacts.find(c => c.id === id) ?? contact(id, id.startsWith('room-') ? 'Room' : a?.name ?? (draftAgent?.id === id ? 'New chat' : 'Agent')); return <div key={id} className="fleet-chat-slot signal-stage show-detail" hidden={activeId !== id}><Conversation headerActions={<div className="fleet-header-actions">{section === 'work' && (a || id.startsWith('room-')) && <button className="icon-btn" aria-label={id.startsWith('room-') ? 'Room actions' : 'Agent actions'} onClick={() => setModal({ kind: id.startsWith('room-') ? 'members' : 'agent-menu', id: id.startsWith('room-') ? id.slice(5) : id })}><MoreHorizontal size={20} /></button>}<button className="icon-btn fleet-desktop-control" aria-label="Close conversation" onClick={() => { if(section === 'messenger') setMessengerChat(null); else setWorkChat(null); setMobileDetail(false); }}><X size={18} /></button></div>} timelineFooter={draftAgent?.id === id ? <ChatSetup draft={a?.brain ? { ...a, brain: a.brain, permissions: a.permissions! } : draftAgent} locked={!!a} onChange={next => { if(!startedDrafts.current.has(id)) setDraftAgent(next); }} /> : a?.brain ? <ChatSetup draft={{ ...a, brain: a.brain, permissions: a.permissions! }} locked /> : id === 'coordinator' && !coordinatorWelcomed ? <div className="fleet-chat-context"><Row title="Launch website" subtitle="Task created · pair · 2 agents" onClick={() => openRoom(initialTasks[0].id, false)} /><Button onClick={() => go({ kind: 'settings', editor: 'template' })}>Configuration</Button><Button onClick={() => go({ kind: 'contacts', id: 'coordinator' })}>Agent identity connections</Button></div> : a?.id === id && a.role === 'Developer' ? <AgentActivity onOpenOutput={() => setModal({ kind: 'tool-output' })} /> : undefined} contact={c} messages={histories[id] ?? []} onBack={() => setMobileDetail(false)} onOpenContact={draftAgent?.id === id && !a ? undefined : () => id.startsWith('room-') ? setModal({ kind: 'members', id: id.slice(5) }) : go({ kind: 'profile', id })} onSend={(text, reply) => send(id, text, reply)} onSendFile={async () => { notify('Attachment selected. File delivery is unavailable in this preview.'); }} /></div>; })}
        </section>
      </div>
      {displayPage.kind === 'home' && section === 'tasks' && <main className="fleet-page fleet-board-page"><PageHeader title="Task manager" actions={<><select aria-label="Filter task list" value={listFilter} onChange={e => setListFilter(e.target.value)}>{['All lists', ...lists].map(l => <option key={l}>{l}</option>)}</select><Button onClick={() => setModal({ kind: 'lists' })}>Manage lists</Button><Button primary onClick={() => setModal({ kind: 'new-task' })}>＋ New task</Button></>} /><SearchField value={taskSearch} onChange={setTaskSearch} placeholder="Search tasks" /><div className="fleet-board">{statuses.map(status => { const rows = tasks.filter(t => t.status === status && (listFilter === 'All lists' || t.list === listFilter) && t.name.toLowerCase().includes(taskSearch.toLowerCase())); return <section key={status} className="fleet-column"><h2>{status} <span>{rows.length}</span></h2>{rows.map(t => <button key={t.id} className="fleet-task-card" onClick={() => go({ kind: 'task', id: t.id })}><strong>{t.name}</strong><span>{t.list}</span><small className={t.blocked ? 'fleet-warning' : ''}>{t.blocked ? `Blocked · ${t.blocked}` : t.status === 'Provisioning' ? 'Joining room · 2/3' : t.status === 'Backlog' ? 'Not started' : t.status === 'Failed' ? 'Launch failed' : t.status === 'Done' ? 'Completed today' : 'Developer + Critic'}</small></button>)}</section>; })}</div></main>}
      {displayPage.kind === 'task' && (selectedTask ? <main className="fleet-page"><PageHeader title={selectedTask.name} subtitle={`TASK · ${selectedTask.id}`} onBack={backPage} actions={<><Button onClick={() => setModal({ kind: 'task-menu', id: selectedTask.id })}>{selectedTask.status} ▾</Button><Button primary onClick={() => { updateTask(selectedTask.id, { status: selectedTask.status === 'Backlog' ? 'Provisioning' : 'Review' }); if(selectedTask.status === 'Backlog') setModal({ kind: 'provisioning', id: selectedTask.id }); }}>{selectedTask.status === 'Backlog' ? 'Start task' : 'Send to review →'}</Button></>} /><div className="fleet-task-detail"><section><h2>Description</h2><p>{selectedTask.description}</p>{selectedTask.blocked && <p className="fleet-warning">Blocked · {selectedTask.blocked}</p>}<h2>Work <span className="muted">{selectedTask.agents.length} agents</span></h2><Row title={`${selectedTask.name} · Room`} subtitle={selectedTask.closed ? 'Closed' : 'Shared room · Ready'} avatar="#" onClick={() => openRoom(selectedTask.id)} />{selectedTask.agents.map(id => { const a = agents.find(a => a.id === id); return a && <div key={id} className="fleet-member"><Row title={a.name} subtitle={a.state} onClick={() => openChat(a.id)} /><Button onClick={() => setModal({ kind: 'remove-agent', id: a.id })}>Remove</Button></div>; })}{!selectedTask.agents.length && <p>Add your first temporary task agent.</p>}<Button onClick={() => setModal({ kind: 'add-agent', id: selectedTask.id })}>＋ Agent</Button></section><aside><h2>Details</h2><Row title="List" subtitle={selectedTask.list} onClick={() => setModal({ kind: 'move-task', id: selectedTask.id })} /><Row title="Template" subtitle="Pair · v1" /><Row title="Created" subtitle="Today, 10:24" /><Row title="Updated" subtitle="2 minutes ago" /><p className="muted">Created from Work</p></aside></div></main> : <main className="fleet-page"><PageHeader title="Task no longer available" onBack={() => switchSection('tasks')} /></main>)}
      {(page.kind === 'profile' || page.kind === 'contacts') && <DialogShell title="Profile" onClose={closeProfile} className="fleet-modal fleet-profile-modal">{!modal && <ProfilePage page={page} agents={agents} go={go} back={backPage} openChat={openChat} openRoom={openRoom} modal={setModal} />}{dialogs}</DialogShell>}
      {displayPage.kind === 'settings' && <SettingsPage back={backPage} editor={displayPage.editor} go={go} notify={notify} />}
      {displayPage.kind === 'account' && <AccountPage step={displayPage.step} go={go} notify={notify} onComplete={completeOnboarding} />}
      {displayPage.kind === 'empty' && <main className="fleet-form-page"><PageHeader title="Your first agent session" subtitle="Start a focused conversation with an agent on Workstation." onBack={() => go({ kind: 'home' })} /><Row title="One agent" subtitle="Choose a template and host folder" onClick={newChat} /><Row title="A task with several agents" subtitle="Create a task session with a shared room" onClick={() => setModal({ kind: 'new-task' })} /><Row title="Persistent agents" subtitle="Configured agents appear here when available" onClick={() => switchSection('work')} /><Row title="Looking for someone?" subtitle="Open Messenger" onClick={() => switchSection('messenger')} /></main>}
    </div>
    {!isProfile(page) && dialogs}
    {toast && <div className="fleet-toast" role="status">{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}>×</button></div>}
  </div>;
}
