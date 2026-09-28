import {useLayoutEffect,useRef} from 'react';
/** Keep first/last content reachable beneath floating chrome, including a growing composer. */
export function useGlassChrome(){
 const ref=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{const el=ref.current;if(!el)return;const header=el.querySelector<HTMLElement>('.fleet-acp-header');const composer=el.querySelector<HTMLElement>('.fleet-acp-composer');
 const update=()=>{el.style.setProperty('--fleet-acp-top',`${(header?.offsetHeight??56)+20}px`);el.style.setProperty('--fleet-acp-bottom',`${(composer?.offsetHeight??88)+24}px`);};const observer=new ResizeObserver(update);if(header)observer.observe(header);if(composer)observer.observe(composer);update();return()=>observer.disconnect();},[]);
 return ref;
}
