import {useEffect, useRef, useState} from 'react';
import {Paperclip, File as FileIcon, X} from 'lucide-react';
import {Button} from './components';
import {fleet} from './live-api';
export interface AttachmentItem {key:string;name:string;size:number;mimeType:string;file?:File;url?:string;id?:string;generation?:string}
const limit=20*1024*1024;
export function useAgentAttachments(intentKey?:string) {
 const [items,setItems]=useState<AttachmentItem[]>(()=>{try{return intentKey?JSON.parse(sessionStorage.getItem(intentKey)??'{}').attachmentDetails??[]:[];}catch{return [];}});
 const current=useRef(items);current.current=items;
 const replace=(next:AttachmentItem[])=>{current.current=next;setItems(next);};
 const [error,setError]=useState('');
 useEffect(()=>()=>{for(const item of current.current)if(item.url)URL.revokeObjectURL(item.url);},[]);
 const remove=(key:string)=>{const item=current.current.find(x=>x.key===key);if(item?.url)URL.revokeObjectURL(item.url);replace(current.current.filter(x=>x.key!==key));};
 const add=(files:File[],generation?:string)=>{
  if(current.current.length+files.length>5){setError('Choose up to 5 files.');return;}
  if(files.some(f=>f.size>limit)){setError('Each file must be 20 MiB or smaller.');return;}
  setError('');replace([...current.current,...files.map(file=>({key:crypto.randomUUID(),name:file.name,size:file.size,mimeType:file.type||'application/octet-stream',file,generation,...(/^image\/(png|jpeg|gif|webp|avif)$/.test(file.type)?{url:URL.createObjectURL(file)}:{})}))]);
 };
 const upload=async(role:string,generation:string)=>{
  if(!generation)throw new Error('Agent session is not ready.');
  const uploaded:AttachmentItem[]=[];
  for(const item of current.current){
   if(item.generation&&item.generation!==generation)throw new Error('Agent session changed. Remove the attachments and select them again.');
   if(item.id){uploaded.push(item);continue;}
   if(!item.file)throw new Error('Select this file again: '+item.name);
   const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('Could not read '+item.name));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(item.file!);});
   const result=await fleet<{id:string}>(`/roles/${encodeURIComponent(role)}/attachments`,{name:item.name,mimeType:item.mimeType,data,expectedSessionGeneration:generation});
   const next={...item,id:result.id,generation};uploaded.push(next);replace(current.current.map(x=>x.key===item.key?next:x));
  }
  return uploaded.map(({file,url,...item})=>item);
 };
 const clear=()=>{for(const item of current.current)if(item.url)URL.revokeObjectURL(item.url);replace([]);setError('');};
 return {items,error,add,remove,upload,clear,has:items.length>0};
}
export function AttachmentPicker({attachments,disabled,generation}:{attachments:ReturnType<typeof useAgentAttachments>;disabled?:boolean;generation?:string}) {
 const input=useRef<HTMLInputElement>(null);
 const selectionGeneration=useRef<{value?:string}>();
 return <><input ref={input} type="file" multiple hidden aria-label="Choose photos or files" disabled={disabled} onChange={e=>{attachments.add(Array.from(e.target.files??[]),selectionGeneration.current?selectionGeneration.current.value:generation);selectionGeneration.current=undefined;e.target.value='';}}/><Button aria-label="Attach photos or files" title="Attach photos or files" disabled={disabled} onClick={()=>{selectionGeneration.current={value:generation};input.current?.click();}}><Paperclip size={19}/></Button></>;
}
export function AttachmentPreviews({attachments,disabled}:{attachments:ReturnType<typeof useAgentAttachments>;disabled?:boolean}) {
 return <>{attachments.error&&<p role="alert">{attachments.error}</p>}{attachments.has&&<ul className="fleet-attachment-previews" aria-label="Attached files">{attachments.items.map(item=><li key={item.key}>{item.url?<a href={item.url} target="_blank" rel="noreferrer" aria-label={'Preview '+item.name}><img src={item.url} alt={item.name}/></a>:<FileIcon size={24}/>}<span title={item.name}>{item.name}<small>{Math.ceil(item.size/1024)} KB</small></span><Button aria-label={'Remove '+item.name} disabled={disabled} onClick={()=>attachments.remove(item.key)}><X size={16}/></Button></li>)}</ul>}</>;
}
