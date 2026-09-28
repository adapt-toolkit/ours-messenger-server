import {SegmentedSwitch} from '../ui/SegmentedSwitch';
import {NotificationBadge} from './Notifications';
export function LifetimeSwitch({value,change}:{value:string;change:(value:string)=>void}){return <SegmentedSwitch label="Agent lifetime" value={value} onChange={change} options={['Persistent','Temporary'].map(id=>({id,label:id,badge:<NotificationBadge node={'lifetime:'+id}/>}))}/>;}
