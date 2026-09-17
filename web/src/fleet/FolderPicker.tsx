import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Check, FolderPlus } from 'lucide-react';
import { Button, Field } from './components';
const root = '/home/you/work';
const seed = [root, `${root}/website`, `${root}/website/assets`, `${root}/website/src`, `${root}/research`, `${root}/shared`];
export function FolderPicker({ value, onSelect, onCancel }: { value: string; onSelect: (path: string) => void; onCancel: () => void }) {
  const [paths, setPaths] = useState(() => { const ancestors = []; for(let path = value; path.startsWith(root); path = path.slice(0, path.lastIndexOf('/'))) ancestors.push(path); return [...new Set([...seed, ...ancestors])]; });
  const [selected, setSelected] = useState(value);
  const [expanded, setExpanded] = useState(new Set([root, `${root}/website`]));
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const readonly = selected.startsWith(`${root}/research`);
  const tree = (path: string) => {
    const children = paths.filter(x => x.slice(0, x.lastIndexOf('/')) === path);
    const open = expanded.has(path);
    const Icon = open ? FolderOpen : Folder;
    return <li key={path}><div className={'fleet-folder-row' + (selected === path ? ' selected' : '')}>{children.length ? <button className="icon-btn" aria-label={`${open ? 'Collapse' : 'Expand'} ${path.split('/').pop()}`} aria-expanded={open} onClick={() => setExpanded(x => { const next = new Set(x); if(next.has(path)) next.delete(path); else next.add(path); return next; })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="fleet-folder-spacer" />}<button aria-pressed={selected === path} onClick={() => setSelected(path)}><Icon size={18} /><span>{path.split('/').pop()}</span>{path.endsWith('/research') && <small>Read only</small>}{selected === path && <Check size={16} />}</button></div>{open && children.length > 0 && <ul>{children.map(tree)}</ul>}</li>;
  };
  return <div className="fleet-folder-picker"><p className="muted">Workstation · Online</p><ul className="fleet-folder-tree" aria-label="Host folders">{tree(root)}</ul>
    {creating ? <form onSubmit={e => { e.preventDefault(); const child = `${selected}/${name.trim()}`; if(!name.trim() || /[/.\\]/.test(name) || paths.includes(child) || readonly) return; setPaths(x => [...x, child]); setExpanded(x => new Set([...x, selected])); setSelected(child); setCreating(false); setName(''); }}><Field label="Folder name"><input autoFocus value={name} onChange={e => setName(e.target.value)} /></Field><div className="fleet-actions"><Button onClick={() => setCreating(false)}>Cancel new folder</Button><Button primary type="submit" disabled={!name.trim() || /[/.\\]/.test(name) || paths.includes(`${selected}/${name.trim()}`)}>Create folder</Button></div></form> : <Button disabled={readonly} onClick={() => setCreating(true)}><FolderPlus size={18} /> New folder in {selected.split('/').pop()}</Button>}
    <div className="fleet-folder-selection"><small>Selected folder</small><code>{selected}</code>{readonly && <small>Read only</small>}</div><div className="fleet-dialog-actions"><Button onClick={onCancel}>Cancel</Button><Button primary onClick={() => onSelect(selected)}>Select folder</Button></div>
  </div>;
}
