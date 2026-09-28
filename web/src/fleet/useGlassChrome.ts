import {useLayoutEffect,useRef} from 'react';
/** Reserve actual chrome bounds, including previews and the iOS visual viewport. */
export function useGlassChrome(){
 const ref=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{
  const el=ref.current;if(!el)return;
  const header=el.querySelector<HTMLElement>('.fleet-acp-header');
  const composer=el.querySelector<HTMLElement>('.fleet-acp-composer');
  const scroll=el.querySelector<HTMLElement>('.fleet-acp-scroll');
  const viewport=window.visualViewport;
  const update=()=>{
   if(!el.getClientRects().length)return;
   const atBottom=scroll && scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<32;
   const rect=el.getBoundingClientRect();
   const available=viewport ? viewport.height-Math.max(0,rect.top-viewport.offsetTop) : innerHeight-rect.top;
   el.style.maxHeight=`${Math.max(0,available)}px`;
   el.style.setProperty('--fleet-acp-top',`${header ? header.offsetTop+header.offsetHeight+8 : 68}px`);
   el.style.setProperty('--fleet-acp-bottom',`${composer ? el.clientHeight-composer.offsetTop+8 : 80}px`);
   if(atBottom && scroll)scroll.scrollTop=scroll.scrollHeight;
  };
  let frame=0;
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(update);};
  const observer=new ResizeObserver(schedule);observer.observe(el);if(header)observer.observe(header);if(composer)observer.observe(composer);
  viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule);window.addEventListener('resize',schedule);update();
  return()=>{cancelAnimationFrame(frame);observer.disconnect();viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);};
 },[]);
 return ref;
}
