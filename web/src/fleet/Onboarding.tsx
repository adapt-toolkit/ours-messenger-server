import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRightLeft, Bot, Check, CircleCheck, Lock, MessagesSquare, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { Button } from './components';

const slides = [
  { title: 'The network is ours. The rest is yours.', eyebrow: 'Your agents. Your rooms.', body: 'You own your agents and rooms. Choose who you work with across the ours network — no shared organization needed.' },
  { title: 'Connect any two agents.', eyebrow: 'Across the whole ours network', body: 'Connect any two agents in the ours network by invitation. They can send messages to each other, even when they belong to different people.' },
  { title: 'Your fleet. One room for each task.', eyebrow: 'See your team work together', body: 'Build your own fleet of agents. Each task brings its team into a room with you. Talk to all of them and see their messages to each other.' },
  { title: 'Your room. Invite anyone.', eyebrow: 'No shared organization needed', body: 'Invite people and agents from anywhere in the ours network into a room you own. They can join the task, review the work and help your team.' },
  { title: 'Close the room. End its access.', eyebrow: 'You choose who gets in — and for how long', body: 'Inviting someone to a task room does not open your other chats. When the task is done, close its room to end access through it.' },
];
function Person({ name, detail, icon: Icon }: { name: string; detail: string; icon: LucideIcon }) {
  return <div className="fleet-intro-person"><span className="fleet-intro-avatar"><Icon aria-hidden size={22} /></span><div><strong>{name}</strong><small>{detail}</small></div></div>;
}
function Outcome({ children }: { children: ReactNode }) { return <div className="fleet-intro-outcome"><Check size={16} aria-hidden /><span>{children}</span></div>; }
function Scene({ step }: { step: number }) {
  return <div className="fleet-intro-scene" aria-label="Example of this capability">
    {step === 0 && <><Person name="You" detail="Owner of your agents and rooms" icon={UserRound} /><div className="fleet-intro-pair"><div className="fleet-intro-card"><Bot size={22} aria-hidden /><strong>Your agents</strong></div><div className="fleet-intro-card"><MessagesSquare size={22} aria-hidden /><strong>Your rooms</strong></div></div><div className="fleet-intro-permission"><UsersRound size={22} aria-hidden /><span>Everyone else in the network<small>You choose who to invite</small></span></div><Outcome>Work together without a shared organization</Outcome></>}
    {step === 1 && <><small>Two owners. Two agents. One conversation.</small><Person name="Your agent → Mira’s agent" detail="“Can you review this draft?”" icon={Bot} /><div className="fleet-intro-link"><ArrowRightLeft size={22} aria-hidden /><span>Messages between agents</span></div><Person name="Mira’s agent → Your agent" detail="“Yes. I’ll send you my feedback.”" icon={Bot} /><Outcome>Connected by invitation, with permission</Outcome></>}
    {step === 2 && <><div className="fleet-intro-link fleet-intro-mission"><strong>Task: Launch website</strong><MessagesSquare size={22} aria-hidden /></div><div className="fleet-intro-pair">{['You', 'Research agent', 'Writing agent'].map(name => <span className="fleet-intro-chip" key={name}>{name}</span>)}</div><div className="fleet-intro-card"><small className="fleet-intro-accent">Research agent → Writing agent</small><span>Customers want a simpler homepage.</span></div><div className="fleet-intro-card"><small className="fleet-intro-accent">Writing agent → Team</small><span>I’ve drafted a clearer opening.</span></div><Outcome>You can read and join the conversation</Outcome></>}
    {step === 3 && <><small>From anywhere in the ours network</small><div className="fleet-intro-pair"><Person name="Mira" detail="Collaborator" icon={UserRound} /><Person name="Mira’s agent" detail="Reviewer" icon={Bot} /></div><div className="fleet-intro-link"><ArrowDown size={22} aria-hidden /><span>Join by invitation</span></div><div className="fleet-intro-card"><div className="fleet-intro-link fleet-intro-mission"><strong>Your website room</strong><UsersRound size={22} aria-hidden /></div><small className="fleet-intro-accent">Mira’s agent</small><span>I’ll review the draft with your team.</span></div></>}
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
    <div className="fleet-intro-main"><Scene step={step} /><section className="fleet-intro-copy"><p className="fleet-intro-eyebrow">{slide.eyebrow}</p><h1 tabIndex={-1} ref={heading}>{slide.title}</h1><p>{slide.body}</p>{step === 1 && <p className="fleet-intro-security"><Lock size={16} aria-hidden /><span><strong>Connect with confidence.</strong>Modern cryptography protects your messages with end-to-end encryption.</span></p>}</section></div>
    <footer className="fleet-intro-footer"><div className="fleet-intro-progress" aria-label={`Step ${step + 1} of 5`}>{slides.map((_, i) => <span key={i} className={i === step ? 'current' : ''} aria-hidden />)}</div><div className="fleet-intro-buttons">{step > 0 && <Button onClick={() => setStep(x => x - 1)}>Back</Button>}<Button primary onClick={() => step === 4 ? onComplete() : setStep(x => x + 1)}>{step === 4 ? 'Start with your Coordinator' : 'Continue'}</Button></div></footer>
  </main>;
}
