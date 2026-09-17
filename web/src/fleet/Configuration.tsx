import { createContext, useContext, useState, type ReactNode } from 'react';
import { Button, Field, PageHeader, Row, SearchField } from './components';
import { catalog, effortChoices, initialConfiguration, validateDefinition, type Configuration, type ConfigKind, type Definition } from './configuration';
import type { Page } from './model';
const Context = createContext({ data: initialConfiguration(), save: (_kind: ConfigKind, _id: string, _value: Definition) => {} });
export function ConfigurationProvider({children}: {children: ReactNode}) {
  const [data,setData] = useState(initialConfiguration);
  return <Context.Provider value={{data, save: (kind,id,value) => setData(d => ({...d,[kind]:{...d[kind],[id]:structuredClone(value)}}))}}>{children}</Context.Provider>;
}
const titles: Record<ConfigKind,string> = {role:'Roles',brain:'Brains',template:'Agent Templates',tasks:'Room Templates'};
const singular: Record<ConfigKind,string> = {role:'role',brain:'brain',template:'agent template',tasks:'room template'};
export function ConfigurationEditor({editor,go}: {editor:string;go:(page:Page)=>void}) {
  const {data,save}=useContext(Context);
  const [kindPart,id]=editor.split('/'); const kind=kindPart as ConfigKind;
  const [search,setSearch]=useState('');
  const list=()=>go({kind:'settings',editor:kind});
  if(!titles[kind]) return null;
  if(id) return <DefinitionEditor key={editor} kind={kind} id={id} existing={data[kind][id]} data={data} cancel={list} save={(name,value)=>{save(kind,name,value);list();}} />;
  return <main className="fleet-form-page"><PageHeader title={titles[kind]} subtitle="Reusable definitions · Changes stay in this preview" onBack={()=>go({kind:'settings'})} actions={<Button primary onClick={()=>go({kind:'settings',editor:kind+'/new'})}>New {singular[kind]}</Button>} /><SearchField value={search} onChange={setSearch} placeholder={`Search ${titles[kind].toLowerCase()}`} /><div className="fleet-config-list">{Object.entries(data[kind]).filter(([name])=>name.toLowerCase().includes(search.toLowerCase())).map(([name,d])=><Row key={name} title={name} subtitle={kind==='brain' ? `${d.harness} · ${d.model ?? 'Harness default'}${d.effort ? ' · '+d.effort : ''}` : kind==='template' ? `${d.role?.ref} · ${d.brain?.ref}` : kind==='tasks' ? `${d.members?.length ?? 0} member slots · v${d.version}` : d.bio || d.mission?.split('\n')[0]} onClick={()=>go({kind:'settings',editor:kind+'/'+encodeURIComponent(name)})} />)}</div></main>;
}
function DefinitionEditor({kind,id,existing,data,cancel,save}: {kind:ConfigKind;id:string;existing?:Definition;data:Configuration;cancel:()=>void;save:(id:string,d:Definition)=>void}) {
 const defaults: Record<ConfigKind,Definition>={role:{mission:'',persona:'',bio:''},brain:{harness:'codex',session:'acp',model:null},template:{role:{ref:''},brain:{ref:''},permissions:{approval:'ask',filesystem:'workspace',unattended:'deny'}},tasks:{version:1,description:'',contract:'',members:[],room:{quiet_membership:false,anonymous:false}}};
 const [name,setName]=useState(id==='new'?'':decodeURIComponent(id));
 const [d,setD]=useState<Definition>(()=>structuredClone(existing ?? defaults[kind]));
 const [error,setError]=useState('');
 const [custom,setCustom]=useState(!!d.model && !catalog.models.some(m=>m.harness===d.harness && m.model===d.model));
 const set=(patch:Partial<Definition>)=>setD(x=>({...x,...patch}));
 const text=(label:string,key:'mission'|'persona'|'bio'|'briefing_file'|'cwd'|'coordinator'|'description'|'contract',multiline=false)=><Field label={label}>{multiline?<textarea value={d[key]??''} onChange={e=>set({[key]:e.target.value})} rows={5}/>:<input value={d[key]??''} onChange={e=>set({[key]:e.target.value})}/>}</Field>;
 const select=(label:string,value:string,change:(s:string)=>void,values:string[],empty='Select…')=><Field label={label}><select value={value} onChange={e=>change(e.target.value)}><option value="">{empty}</option>{values.map(v=><option key={v} value={v}>{v}</option>)}</select></Field>;
 if(id!=='new' && !existing) return <main className="fleet-form-page"><PageHeader title="Definition not found" onBack={cancel}/></main>;
 return <main className="fleet-form-page"><PageHeader title={`${id==='new'?'New':'Edit'} ${singular[kind]}`} subtitle="Changes apply to definitions; current sessions keep their snapshots." onBack={cancel}/><form className="fleet-config-form" onSubmit={e=>{e.preventDefault();const n=name.trim();if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(n)||n==='new'){setError('Use a unique name with letters, numbers, hyphens or underscores.');return;}if(id==='new' && Object.hasOwn(data[kind],n)){setError('This name already exists.');return;}const issue=validateDefinition(kind,d,data);if(issue){setError(issue);return;}save(n,d);}}>
 <Field label="Definition name"><input required value={name} readOnly={id!=='new'} onChange={e=>setName(e.target.value)}/></Field>
 {kind==='role' && <>{text('Mission','mission',true)}{text('Instructions / persona','persona',true)}{text('Bio','bio',true)}{text('Briefing file','briefing_file')}</>}
 {kind==='brain' && <>
 {select('Harness',d.harness??'',h=>{set({harness:h,session:'acp',model:null,effort:undefined});setCustom(false);},['codex','claude-code'])}
 <Field label="Session"><select value={d.session??'acp'} onChange={e=>set({session:e.target.value})}><option value="acp">acp</option>{d.harness==='codex' && <option value="codex-app-server">codex-app-server</option>}</select></Field>
 <Field label="Model"><select value={custom?'__custom':d.model??''} onChange={e=>{const value=e.target.value;setCustom(value==='__custom');set({model:value==='__custom'?'':value||null,effort:undefined});}}><option value="">Harness default</option>{catalog.models.filter(m=>m.harness===d.harness).map(m=><option key={m.model}>{m.model}</option>)}<option value="__custom">Custom model…</option></select></Field>
 {custom && <Field label="Custom model ID"><input required value={d.model??''} onChange={e=>set({model:e.target.value})}/></Field>}
 {select('Reasoning effort',d.effort??'',effort=>set({effort:effort||undefined}),effortChoices(d.harness,d.model),'Harness default')}
 <details><summary>Runtime options</summary><Field label="Max tokens"><input type="number" min="1" value={d.max_tokens??''} onChange={e=>set({max_tokens:e.target.value?Number(e.target.value):undefined})}/></Field><Field label="Autocompact percent"><input type="number" min="1" max="100" value={d.autocompact_pct??''} onChange={e=>set({autocompact_pct:e.target.value?Number(e.target.value):undefined})}/></Field><JsonOptions label="Harness options" value={d.harness_options} onChange={v=>set({harness_options:v})}/><JsonOptions label="Session options" value={d.session_options} onChange={v=>set({session_options:v})}/></details>
 </>}
 {kind==='template' && <>
 {select('Role',d.role?.ref??'',ref=>set({role:{ref}}),Object.keys(data.role))}
 {select('Brain',d.brain?.ref??'',ref=>set({brain:{ref}}),Object.keys(data.brain))}
 <p className="muted">Create custom roles and brains in their own lists first, then select them here.</p>
 {text('Working folder','cwd')}{text('Coordinator','coordinator')}
 {select('Approval',d.permissions?.approval??'',v=>set({permissions:{...d.permissions,approval:v||undefined}}),['ask','auto','allow','deny'],'Default')}
 {select('Unattended',d.permissions?.unattended??'',v=>set({permissions:{...d.permissions,unattended:v||undefined}}),['deny','wait'],'Default')}
 {select('Filesystem',d.permissions?.filesystem??'',v=>set({permissions:{...d.permissions,filesystem:v||undefined}}),['read-only','workspace','unrestricted'],'Default')}
 </>}
 {kind==='tasks' && <>{text('Description','description',true)}<Field label="Version"><input required type="number" min="1" value={d.version??1} onChange={e=>set({version:Number(e.target.value)})}/></Field>{text('Collaboration contract','contract',true)}
 {(d.members??[]).map((m,i)=><fieldset className="fleet-config-member" key={i}><legend>Member {i+1}</legend><Field label={`Slot ${i+1}`}><input required value={m.slot} onChange={e=>set({members:d.members!.map((x,j)=>j===i?{...x,slot:e.target.value}:x)})}/></Field><Field label={`Room role ${i+1}`}><input required value={m.role} onChange={e=>set({members:d.members!.map((x,j)=>j===i?{...x,role:e.target.value}:x)})}/></Field>{select(`Agent template ${i+1}`,m.agent_template,v=>set({members:d.members!.map((x,j)=>j===i?{...x,agent_template:v}:x)}),Object.keys(data.template))}<Field label={`Count ${i+1}`}><input required type="number" min="1" value={m.count} onChange={e=>set({members:d.members!.map((x,j)=>j===i?{...x,count:Number(e.target.value)}:x)})}/></Field><Button onClick={()=>set({members:d.members!.filter((_,j)=>j!==i)})}>Remove member {i+1}</Button></fieldset>)}
 <Button onClick={()=>set({members:[...(d.members??[]),{slot:'',role:'',count:1,agent_template:''}]})}>Add member</Button>
 <label className="fleet-check"><input type="checkbox" checked={!!d.room?.anonymous} onChange={e=>set({room:{...d.room,anonymous:e.target.checked}})}/>Anonymous room</label><label className="fleet-check"><input type="checkbox" checked={!!d.room?.quiet_membership} onChange={e=>set({room:{...d.room,quiet_membership:e.target.checked}})}/>Quiet membership</label></>}
 {error && <p role="alert">{error}</p>}<div className="fleet-actions"><Button onClick={cancel}>Cancel</Button><Button primary type="submit">Save {singular[kind]}</Button></div>
 </form></main>;
}
function JsonOptions({label,value,onChange}:{label:string;value?:Record<string,unknown>;onChange:(v:Record<string,unknown>)=>void}) {
 const [raw,setRaw]=useState(JSON.stringify(value??{},null,2));
 return <Field label={label}><textarea rows={4} value={raw} onChange={e=>{setRaw(e.target.value);try {const parsed=JSON.parse(e.target.value);if(!parsed||Array.isArray(parsed)||typeof parsed!=='object')throw new Error();onChange(parsed);e.target.setCustomValidity('');}catch{e.target.setCustomValidity('Enter a JSON object.');}}}/></Field>;
}
