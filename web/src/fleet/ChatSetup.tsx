import { useState } from 'react';
import { Bot, Brain, UserRound, Lock, SlidersHorizontal } from 'lucide-react';
import DialogShell from '../ui/DialogShell';
import { Button, Field } from './components';
import { FolderPicker } from './FolderPicker';
export interface DraftAgent { id: string; name: string; role: string; brain: string; permissions: string; folder: string }
export function ChatSetup({ draft, onChange, locked = false }: { draft: DraftAgent; onChange?: (next: DraftAgent) => void; locked?: boolean }) {
  const [options, setOptions] = useState(false);
  const [folder, setFolder] = useState(false);
  const change = (key: keyof DraftAgent, value: string) => { if(!locked) onChange?.({ ...draft, [key]: value }); };
  const fields = <div className="fleet-setup-fields"><label><Bot size={19} /><span>Name<input aria-label="Agent name" value={draft.name} onChange={e => change('name', e.target.value)} /></span></label><label><UserRound size={19} /><span>Role<select aria-label="Role" value={draft.role} onChange={e => change('role', e.target.value)}>{['Assistant', 'Researcher', 'Developer', 'Critic', 'Writer'].map(x => <option key={x}>{x}</option>)}</select></span></label><label><Brain size={19} /><span>Brain<select aria-label="Brain" value={draft.brain} onChange={e => change('brain', e.target.value)}><option>Codex</option><option>Claude Code</option></select></span></label></div>;
  if(locked) return <details className="fleet-locked-setup"><summary><Lock size={14} /> Session settings · Locked</summary><dl>{[['Name', draft.name], ['Role', draft.role], ['Brain', draft.brain], ['Folder', draft.folder], ['Permissions', draft.permissions]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>;
  return <section className="fleet-chat-setup" aria-label="New chat settings"><h2>New chat</h2><p>Send a message to start your agent.</p>{!options && fields}<Button onClick={() => setOptions(true)}><SlidersHorizontal size={16} /> More options</Button><small>Settings lock after your first message.</small>
    {options && <DialogShell title={folder ? 'Choose folder' : 'Make it yours'} className="fleet-modal" onClose={() => folder ? setFolder(false) : setOptions(false)}>{folder ? <FolderPicker value={draft.folder} onCancel={() => setFolder(false)} onSelect={value => { change('folder', value); setFolder(false); }} /> : <div className="fleet-dialog-content">{fields}<Button onClick={() => setFolder(true)}>Folder · {draft.folder.split('/').pop()}</Button><Field label="Permissions"><select value={draft.permissions} onChange={e => change('permissions', e.target.value)}><option>Ask before changes</option><option>Read only</option><option>Workspace edits</option></select></Field><Button primary onClick={() => setOptions(false)}>Done</Button></div>}</DialogShell>}
  </section>;
}
