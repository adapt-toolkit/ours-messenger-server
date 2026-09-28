import { Field } from './components';
export type InviteMode = 'one_time' | 'public';
export function InviteType({value,onChange,disabled}:{value:InviteMode;onChange:(value:InviteMode)=>void;disabled:boolean}) {
  return <><Field label="Invitation type"><select value={value} disabled={disabled} onChange={e=>onChange(e.target.value as InviteMode)}><option value="one_time">One-time</option><option value="public">Reusable</option></select></Field><p>{value==='one_time'?'One connection.':'Multiple people can use the same code.'} Share the code yourself.</p></>;
}
