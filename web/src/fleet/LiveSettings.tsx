import { useEffect, useState } from 'react';
import { fleet, messenger } from './live-api';
import { ConfigurationEditor } from './Configuration';
import type { Page } from './model';
import { Button, PageHeader, Row } from './components';
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
  if (!editor) return <main className="fleet-form-page"><PageHeader title="Configuration" onBack={back} />{[['template','Agent Templates'],['role','Roles'],['brain','Brains'],['tasks','Task / room templates'],['advanced','Fleet manifest and agents']].map(([key,label]) => <Row key={key} title={label} onClick={() => go({ kind: 'settings', editor: key })} />)}<Button onClick={() => fleet('/auth/logout', {}).then(() => location.reload()).catch(e => setError(e.message))}>Sign out</Button>{error && <p role="alert">{error}</p>}</main>;
  return <main className="fleet-page"><PageHeader title="Fleet configuration" onBack={back} /><p>Edit the configuration on this host. Preview validates changes; save uses the loaded revision to prevent overwriting another edit.</p><textarea className="field fleet-config-json" aria-label="Fleet configuration JSON" value={document} onChange={e => { setDocument(e.target.value); setPreview(''); }} /><div className="fleet-actions"><Button disabled={busy || !revision} onClick={() => void save(false)}>Preview changes</Button><Button disabled={busy || !preview} onClick={() => void save(true)}>Save changes</Button><Button onClick={() => fleet('/auth/logout', {}).then(() => location.reload()).catch(e => setError(e.message))}>Sign out</Button></div>{error && <p role="alert">{error}</p>}{preview && <pre className="fleet-output">{preview}</pre>}</main>;
}
export function LiveProfile({ id, agents }: { id: string; agents: Agent[] }) {
  const [profile, setProfile] = useState<unknown>(); const [error, setError] = useState('');
  useEffect(() => { (id === 'human' ? messenger.identity() : agents.some(a => a.id === id) ? fleet(`/roles/${encodeURIComponent(id)}`) : messenger.contacts()).then(setProfile).catch(e => setError(e.message)); }, [id]);
  const value = profile as any;
  const agent = agents.find(a => a.id === id);
  const contact = value?.contacts?.find((c: any) => c.container_id === id);
  const name = agent?.name ?? contact?.display_name ?? contact?.name ?? value?.name ?? 'Identity';
  return <main className="fleet-page"><section className="fleet-profile"><div className="fleet-profile-avatar">{name.slice(0,2)}</div><h1>{name}</h1>{error ? <p role="alert">{error}</p> : !value ? <p>Loading…</p> : <><p>{agent ? `${agent.lifetime} agent · ${agent.state}` : value.cid ? 'Local Messenger identity' : 'Contact'}</p><p>{value.bio ?? agent?.role}</p>{(value.cid || contact?.container_id) && <small className="muted">{value.cid ?? contact.container_id}</small>}{agent && <><Row title="Working folder" subtitle={agent.folder} /><Row title="Runtime" subtitle={value.role?.config?.harness} /></>}</>}</section></main>;
}
