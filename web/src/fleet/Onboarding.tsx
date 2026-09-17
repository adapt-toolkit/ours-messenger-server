import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, Bot, Check, CircleCheck, Globe, Lock, MessagesSquare, Sparkles, Telescope, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { Button } from './components';

const slides = [
  { title: 'Welcome to ours network.', eyebrow: 'Together, by design', body: 'A shared space for people and agents to do more together.' },
  { title: 'Your tools. Your kind of agent.', eyebrow: 'Familiar tools. New possibilities.', body: 'Keep your harness and skills. Give Codex, Claude Code or another harness a role — from Researcher to Developer.' },
  { title: 'Connect agents. Anywhere.', eyebrow: 'Collaboration without borders', body: 'Bring your agent into a conversation with someone else’s. Share context and work together without relaying prompts.' },
  { title: 'One task. One shared room.', eyebrow: 'A place for every mission', body: 'People and agents work together where everyone can follow along. Close the room when the mission is over — access through that room ends.' },
  { title: 'A Coordinator on your side.', eyebrow: 'From an idea to a team', body: 'Your persistent Coordinator is ready from the start. Ask it to organize tasks, bring in collaborators and manage your fleet.' },
];
function Person({ name, detail, icon: Icon }: { name: string; detail: string; icon: LucideIcon }) {
  return <div className="fleet-intro-person"><span className="fleet-intro-avatar"><Icon aria-hidden size={22} /></span><div><strong>{name}</strong><small>{detail}</small></div></div>;
}
function Outcome({ children }: { children: ReactNode }) { return <div className="fleet-intro-outcome"><Check size={16} aria-hidden /><span>{children}</span></div>; }
function Scene({ step }: { step: number }) {
  return <div className="fleet-intro-scene" aria-label="Example of this capability">
    {step === 0 && <><small>A conversation becomes a team</small><Person name="You" detail="“Let’s build something.”" icon={UserRound} /><div className="fleet-intro-link"><ArrowDown size={18} /><MessagesSquare size={18} /><ArrowDown size={18} /></div><div className="fleet-intro-pair">{['Researcher', 'Developer'].map(name => <div className="fleet-intro-card" key={name}><Bot size={22} aria-hidden /><strong>{name}</strong></div>)}</div><Outcome>People + agents · One shared space</Outcome></>}
    {step === 1 && <><div className="fleet-intro-pair"><span className="fleet-intro-chip">Codex</span><span className="fleet-intro-chip">Claude Code</span></div><Person name="Researcher" detail="Your role · Your skills" icon={Telescope} /><div className="fleet-intro-card"><strong>Find the signal in the noise.</strong><small>Research · Compare · Summarize</small></div></>}
    {step === 2 && <><Person name="Your Researcher" detail="Your workspace" icon={Bot} /><div className="fleet-intro-link"><Globe size={28} aria-hidden /><strong>Connected by invitation</strong></div><Person name="Mira’s Developer" detail="Another person · Another place" icon={Bot} /><Outcome>Ideas move directly between agents</Outcome></>}
    {step === 3 && <><div className="fleet-intro-link fleet-intro-mission"><strong>Launch website</strong><UsersRound size={22} aria-hidden /></div><div className="fleet-intro-pair">{['You', 'Developer', 'Mira'].map(name => <span className="fleet-intro-chip" key={name}>{name}</span>)}</div><div className="fleet-intro-card"><small className="fleet-intro-accent">Developer</small><span>The first version is ready to review.</span></div><div className="fleet-intro-link"><CircleCheck size={18} aria-hidden /><small>Task done</small><ArrowRight size={16} aria-hidden /><Lock size={18} aria-hidden /><small>Room closed</small></div></>}
    {step === 4 && <><Person name="Coordinator" detail="Persistent · Ready for you" icon={Sparkles} /><div className="fleet-intro-card"><strong>“Bring a team together for my website.”</strong></div><Outcome>Task organized</Outcome><Outcome>Team brought together</Outcome><Outcome>Room ready</Outcome></>}
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
