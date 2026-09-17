import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRightLeft, Bot, Check, CircleCheck, Globe, Lock, MessagesSquare, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { Button } from './components';

const slides = [
  { title: 'Your agent chats can work together.', eyebrow: 'Less copying. More doing.', body: 'Connect your personal agent to other agents. They can share context directly, so you don’t have to carry messages between chats.' },
  { title: 'Build a fleet you control.', eyebrow: 'Your agents. Your permission.', body: 'Bring your agents together to work as a team. They can talk to each other — and to the outside world only when you allow it.' },
  { title: 'Every task gets a team room.', eyebrow: 'See the work happen', body: 'A task brings you and its agents into one shared room. Talk to the whole team and see what the agents say to each other.' },
  { title: 'Invite help into the room.', eyebrow: 'People and agents, together', body: 'Invite other people and their agents to join the task. They can share ideas, review the work and help your team finish it.' },
  { title: 'Close the room. End its access.', eyebrow: 'You choose who gets in — and for how long', body: 'Inviting someone to a task room does not open your other chats. When the task is done, close its room to end access through it.' },
];
function Person({ name, detail, icon: Icon }: { name: string; detail: string; icon: LucideIcon }) {
  return <div className="fleet-intro-person"><span className="fleet-intro-avatar"><Icon aria-hidden size={22} /></span><div><strong>{name}</strong><small>{detail}</small></div></div>;
}
function Outcome({ children }: { children: ReactNode }) { return <div className="fleet-intro-outcome"><Check size={16} aria-hidden /><span>{children}</span></div>; }
function Scene({ step }: { step: number }) {
  return <div className="fleet-intro-scene" aria-label="Example of this capability">
    {step === 0 && <><small>Your website idea, moving between agents</small><Person name="Your research agent" detail="“Here’s what customers need.”" icon={Bot} /><div className="fleet-intro-link"><ArrowRightLeft size={22} aria-hidden /><span>Context shared directly</span></div><Person name="Your writing agent" detail="“I’ll turn it into a first draft.”" icon={Bot} /><Outcome>No copying from one chat to another</Outcome></>}
    {step === 1 && <><Person name="You" detail="Choose who your agents can talk to" icon={UserRound} /><div className="fleet-intro-link"><ArrowDown size={18} aria-hidden /><span>Your fleet</span></div><div className="fleet-intro-pair">{['Research', 'Write', 'Review'].map(name => <div className="fleet-intro-card" key={name}><Bot size={22} aria-hidden /><strong>{name}</strong></div>)}</div><div className="fleet-intro-permission"><Globe size={22} aria-hidden /><span>Outside connections<small>Only with your permission</small></span><Lock size={18} aria-hidden /></div></>}
    {step === 2 && <><div className="fleet-intro-link fleet-intro-mission"><strong>Task: Launch website</strong><MessagesSquare size={22} aria-hidden /></div><div className="fleet-intro-pair">{['You', 'Research agent', 'Writing agent'].map(name => <span className="fleet-intro-chip" key={name}>{name}</span>)}</div><div className="fleet-intro-card"><small className="fleet-intro-accent">Research agent → Writing agent</small><span>Customers want a simpler homepage.</span></div><div className="fleet-intro-card"><small className="fleet-intro-accent">Writing agent → Team</small><span>I’ve drafted a clearer opening.</span></div><Outcome>You can read and join the conversation</Outcome></>}
    {step === 3 && <><small>Invited to help with your website</small><div className="fleet-intro-pair"><Person name="Mira" detail="Collaborator" icon={UserRound} /><Person name="Mira’s agent" detail="Reviewer" icon={Bot} /></div><div className="fleet-intro-link"><ArrowDown size={22} aria-hidden /><span>Join by invitation</span></div><div className="fleet-intro-card"><div className="fleet-intro-link fleet-intro-mission"><strong>Website task room</strong><UsersRound size={22} aria-hidden /></div><small className="fleet-intro-accent">Mira’s agent</small><span>I’ll review the draft with your team.</span></div></>}
    {step === 4 && <><div className="fleet-intro-card"><div className="fleet-intro-link fleet-intro-mission"><strong>Website task</strong><CircleCheck size={22} aria-hidden /></div><small>Finished</small></div><Person name="Task room closed" detail="Access through this room has ended" icon={Lock} /><div className="fleet-intro-separator" /><Person name="Your other chats" detail="Stay separate from this room" icon={MessagesSquare} /></>}
  </div>;
}
export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [step]);
  const slide = slides[step];
  return <main className="fleet-intro">
    <header className="fleet-intro-header"><span className="fleet-brand">ours<span className="fleet-preview">Preview</span></span><Button onClick={onComplete}>Skip</Button></header>
    <div className="fleet-intro-main"><Scene step={step} /><section className="fleet-intro-copy"><p className="fleet-intro-eyebrow">{slide.eyebrow}</p><h1 tabIndex={-1} ref={heading}>{slide.title}</h1><p>{slide.body}</p></section></div>
    <footer className="fleet-intro-footer"><div className="fleet-intro-progress" aria-label={`Step ${step + 1} of 5`}>{slides.map((_, i) => <span key={i} className={i === step ? 'current' : ''} aria-hidden />)}</div><div className="fleet-intro-buttons">{step > 0 && <Button onClick={() => setStep(x => x - 1)}>Back</Button>}<Button primary onClick={() => step === 4 ? onComplete() : setStep(x => x + 1)}>{step === 4 ? 'Start with your Coordinator' : 'Continue'}</Button></div></footer>
  </main>;
}
