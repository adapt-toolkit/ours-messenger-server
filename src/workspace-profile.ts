import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface HumanProfile { name:string; surname:string }
export function profileName(value:unknown):string {if(typeof value!=='string' || !value.trim() || value.length>100 || /[\x00-\x1f\x7f]/.test(value))throw Error('Name and Surname require printable text');return value.trim();}
function path(dir:string,cid:string){if(!/^[a-f0-9]{64}$/i.test(cid))throw Error('Invalid identity');return join(dir,'human-'+cid.toLowerCase()+'.json');}
export function readHumanProfile(dir:string,cid:string):HumanProfile|undefined {if(!/^[a-f0-9]{64}$/i.test(cid))return;const file=path(dir,cid);if(!existsSync(file))return;const stat=lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0)throw Error('Private profile path required');const row=JSON.parse(readFileSync(file,'utf8'));return {name:profileName(row.name),surname:profileName(row.surname)};}
export function writeHumanProfile(dir:string,cid:string,value:HumanProfile):HumanProfile {
  const row={name:profileName(value.name),surname:profileName(value.surname)};mkdirSync(dir,{recursive:true,mode:0o700});
  const directory=lstatSync(dir);if(!directory.isDirectory() || directory.isSymbolicLink() || directory.uid!==process.getuid?.() || (directory.mode&0o077)!==0)throw Error('Private profile directory required');
  const file=path(dir,cid);if(existsSync(file)){const stat=lstatSync(file);if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.uid!==process.getuid?.() || (stat.mode&0o077)!==0)throw Error('Private profile path required');}
  const temporary=file+'.'+randomUUID();writeFileSync(temporary,JSON.stringify(row)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);return row;
}
