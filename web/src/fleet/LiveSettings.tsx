import { SlidersHorizontal, Users, Link, ScanLine, Archive, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fleet, messenger } from './live-api';
import { ConfigurationEditor } from './Configuration';
import type { Page, Modal, Task } from './model';
import { Button, PageHeader, Row, Property, MenuAction } from './components';
import type { Agent } from './model';
export function LiveSettings({ back, editor, go }: { back: () => void; editor?: string; go: (page: Page) => void }) {
  const [document, setDocument] = useState(''); const [revision, setRevision] = useState('');
  const [error, setError] = useState(''); const [preview, setPreview] = useState(''); const [busy, setBusy] = useState(false);
  const read = async () => { const value = await fleet('/configuration'); setDocument(JSON.stringify(value.model, null, 2)); setRevision(value.revision); };
  useEffect(() => { void read().catch(e => setError(e.message)); }, []);
  const save = async (commit: boolean) => {
    setBusy(true); setError('');
    try { const result = await fleet(`/configuration/${commit ? 'save' : 'preview'}`, { revision, model: JSON.parse(document) }); setPreview(JSON.stringify(result, null, 2)); if (commit) await read(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (editor && ['role', 'brain', 'template', 'tasks'].includes(editor.split('/')[0])) return <ConfigurationEditor key={editor} editor={editor} go={go} />;
  if (!editor) return <main className="fleet-form-page"><PageHeader title="Configuration" onBack={back} />{[['template','Agent Templates'],['role','Roles'],['brain','Brains'],['tasks','Task / room templates'],['advanced','Fleet manifest and agents']].map(([key,label]) => <MenuAction key={key} title={label} icon={SlidersHorizontal} onClick={() => go({ kind: 'settings', editor: key })} />)}<Button onClick={() => fleet('/auth/logout', {}).then(() => location.reload()).catch(e => setError(e.message))}>Sign out</Button>{error && <p role="alert">{error}</p>}</main>;
  return <main className="fleet-page"><PageHeader title="Fleet configuration" onBack={back} /><p>Edit the configuration on this host. Preview validates changes; save uses the loaded revision to prevent overwriting another edit.</p><textarea className="field fleet-config-json" aria-label="Fleet configuration JSON" value={document} onChange={e => { setDocument(e.target.value); setPreview(''); }} /><div className="fleet-actions"><Button disabled={busy || !revision} onClick={() => void save(false)}>Preview changes</Button><Button disabled={busy || !preview} onClick={() => void save(true)}>Save changes</Button><Button onClick={() => fleet('/auth/logout', {}).then(() => location.reload()).catch(e => setError(e.message))}>Sign out</Button></div>{error && <p role="alert">{error}</p>}{preview && <pre className="fleet-output">{preview}</pre>}</main>;
}
export function LiveProfile({ id, agents, go, modal, tasks }: { id: string; agents: Agent[]; go: (page: Page) => void; modal:(modal:Modal)=>void; tasks:Task[] }) {
  const [profile, setProfile] = useState<unknown>(); const [error, setError] = useState('');
  useEffect(() => { (id === 'human' ? messenger.identity() : agents.some(a => a.id === id) ? fleet(`/roles/${encodeURIComponent(id)}`) : messenger.contacts()).then(setProfile).catch(e => setError(e.message)); }, [id]);
  const value = profile as any;
  const agent = agents.find(a => a.id === id);
  const task=tasks.find(t=>t.agents.includes(id));
  const contact = value?.contacts?.find((c: any) => c.container_id === id);
  const name = agent?.name ?? contact?.display_name ?? contact?.name ?? value?.name ?? 'Identity';
  return <main className="fleet-page"><section className="fleet-profile"><div className="fleet-profile-avatar">{name.slice(0,2)}</div><h1>{name}</h1>{error ? <p role="alert">{error}</p> : !value ? <p>Loading…</p> : <><p>{agent ? `${agent.lifetime} agent · ${agent.state}` : value.cid ? 'Local Messenger identity' : 'Contact'}</p><p>{value.bio ?? agent?.role}</p>{(value.cid || contact?.container_id) && <small className="muted">{value.cid ?? contact.container_id}</small>}{agent && <><MenuAction title="Contacts & conversations" icon={Users} onClick={()=>go({kind:'contacts',id})}/><MenuAction title="Generate invite" icon={Link} onClick={()=>modal({kind:'agent-generate',id})}/><MenuAction title="Accept invite" icon={ScanLine} onClick={()=>modal({kind:'agent-accept',id})}/>{task?<p className="muted">This agent belongs to {task.name}. Finish its task to close the agent.</p>:<MenuAction title={agent.lifetime==='Temporary'?'Finish chat':'Stop agent'} icon={agent.lifetime==='Temporary'?Archive:Square} danger onClick={()=>modal({kind:agent.lifetime==='Temporary'?'finish-chat':'stop-agent',id})}/>}<Property title="Identity" subtitle={value.role?.config?.identity ?? agent.name}/><Property title="Working folder" subtitle={agent.folder} /><Property title="Runtime" subtitle={value.role?.config?.harness ?? value.role?.harness} />{agent.lifetime==='Temporary'&&<Property title="Auto-close" subtitle={value.chatIdle ? `After ${value.chatIdle.timeoutMs/3600000} hours without activity` : 'Not enabled for this session'}/> }</>}</>}</section></main>;
}
