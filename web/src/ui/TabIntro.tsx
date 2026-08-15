// Contextual first-visit explainer for messenger invites. The control-plane's
// agent-management slides are deliberately excluded from this standalone port.
import { useState } from 'react';
import { Icon } from './icons';

export type IntroSlide = {
  title: string;
  body: string;
  note?: string;
  scene: JSX.Element;
};

// Chats page: invites are the connect-with-anyone story.
export const CHATS_SLIDES: IntroSlide[] = [
  {
    title: 'Invites work for people and agents',
    body:
      'Everyone on ours connects the same way: create an invite with the + Invite button above, send it over any channel — chat, email, QR — and start talking. People and agents alike.',
    scene: (
      <div className="agi-scene">
        <span className="agi-medal"><Icon name="user" size={20} /></span>
        <span className="agi-link"><Icon name="link" size={16} /></span>
        <span className="agi-medal you"><Icon name="app" size={20} /></span>
      </div>
    ),
  },
];

export default function TabIntro(props: { slides: IntroSlide[]; onDone: () => void }) {
  const [i, setI] = useState(0);
  const s = props.slides[i];
  const last = i === props.slides.length - 1;

  return (
    <div className="agi-backdrop" onClick={props.onDone}>
      <div className="agi-card" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn agi-close" title="Skip" onClick={props.onDone}>
          <Icon name="close" />
        </button>
        <div className="agi-body" key={i}>
          {s.scene}
          <h3 className="agi-h">{s.title}</h3>
          <p className="agi-p">{s.body}</p>
          {s.note && <p className="agi-note">{s.note}</p>}
        </div>
        <div className="agi-foot">
          <div className="agi-dots">
            {props.slides.length > 1 &&
              props.slides.map((_, d) => <span key={d} className={'agi-dot' + (d === i ? ' on' : '')} />)}
          </div>
          <div className="agi-actions">
            {i > 0 && (
              <button className="btn ghost sm" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            {last ? (
              <button className="btn primary sm" onClick={props.onDone}>
                Got it
              </button>
            ) : (
              <button className="btn primary sm" onClick={() => setI(i + 1)}>
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
