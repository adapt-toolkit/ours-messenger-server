import { useState } from 'react';
import { Button, PageHeader, Row, SearchField } from './components';
import type { Agent, Modal, Page, Task } from './model';

/** Preview peer history is separate from the owner's Messenger and runtime chats. */
export function AgentConversations({ agent, agents, tasks, peer, go, modal }: {
  agent?: Agent; agents: Agent[]; tasks: Task[]; peer?: string;
  go: (page: Page) => void; modal: (modal: Modal) => void;
}) {
  const [search, setSearch] = useState('');
  if (!agent) return <p>Agent unavailable. Conversation history cannot be shown.</p>;
  const contacts = [
    ...agents.filter(a => a.id !== agent.id).map(a => ({ id: a.id, name: a.name, room: false })),
    ...tasks.filter(t => t.agents.includes(agent.id)).map(t => ({ id: `room-${t.id}`, name: t.name, room: true })),
  ];
  const selected = contacts.find(c => c.id === peer);
  const open = (peer?: string) => go({ kind: 'contacts', id: agent.id, peer });
  if (peer && !selected) return <><Button onClick={() => open()}>‹ {agent.name}’s contacts</Button><p>Contact unavailable.</p></>;
  if (selected) return <section className="fleet-correspondence" aria-label={`${agent.name}’s conversation with ${selected.name}`}>
    <Button onClick={() => open()}>‹ {agent.name}’s contacts</Button>
    <small className="fleet-correspondence-context">{agent.name}’s conversations</small>
    <h1>{agent.name} ↔ {selected.name}</h1>
    <p className="muted">Your agent · View only</p>
    <Button onClick={() => selected.room ? modal({ kind: 'members', id: selected.id.slice(5) }) : go({ kind: 'profile', id: selected.id })}>{selected.room ? 'Room details' : `${selected.name}’s profile`} ›</Button>
    {selected.room ? <div className="fleet-correspondence-empty"><h2>No messages yet</h2><p>{agent.name} is connected to this room. Messages will appear here when the conversation begins.</p></div> : <ol className="fleet-correspondence-history" aria-label="Message history">
      <li className="fleet-correspondence-date">Today · 17 September</li>
      {[
        { sender: selected.name, time: '14:28', text: 'Please check the website before the review.', own: false },
        { sender: agent.name, time: '14:30', text: 'The mobile layout and navigation checks have passed.', own: true },
        { sender: selected.name, time: '14:31', text: 'Great. Is the updated preview ready?', own: false },
        { sender: agent.name, time: '14:32', text: 'Ready for review. I’ve shared the preview with the team.', own: true },
      ].map(message => <li key={message.time} className={'fleet-correspondence-message' + (message.own ? ' sent' : '')}><small>{message.sender} · <time>{message.time}</time></small><p>{message.text}</p></li>)}
    </ol>}
    <p className="fleet-correspondence-notice">Viewing agent history · Read only</p>
  </section>;
  const visible = contacts.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  return <section className="fleet-agent-contacts">
    <Button onClick={() => go({ kind: 'profile', id: agent.id })}>‹ {agent.name} profile</Button>
    <PageHeader title="Contacts & conversations" subtitle={`${agent.name} · Your agent · View only`} />
    <SearchField value={search} onChange={setSearch} placeholder="Search agent’s contacts" />
    {visible.map(c => <Row key={c.id} title={c.name + (c.room ? ' · Room' : '')} subtitle={c.room ? 'No messages yet' : `${agent.name}: Ready for review · 14:32`} onClick={() => open(c.id)} />)}
    {!visible.length && <p className="fleet-correspondence-empty">{search ? 'No matching contacts.' : 'No contacts yet. Invite a contact to start connecting this agent.'}</p>}
    <div className="fleet-actions"><Button primary onClick={() => modal({ kind: 'generate', actor: agent.id, locked: true })}>Invite contact to {agent.name}</Button><Button onClick={() => modal({ kind: 'accept', actor: agent.id, locked: true })}>Accept invite</Button></div>
  </section>;
}
