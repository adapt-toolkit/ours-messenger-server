import { useState } from 'react';
import { Check, Terminal } from 'lucide-react';
import { Button } from './components';

/** Agent-only timeline entries; ordinary Messenger never supplies this content. */
export function AgentActivity({ onOpenOutput }: { onOpenOutput: () => void }) {
  const [permission, setPermission] = useState('Awaiting permission');
  return <section className="fleet-tool" aria-label="Agent activity">
    <details className="fleet-activity-entry">
      <summary><Check size={14} aria-hidden /><span>Read files · 3</span><small>Completed</small></summary>
      <div className="fleet-activity-output">
        <p>Read index.html, styles.css and app.tsx. Heading hierarchy and form labels checked.</p>
        <Button onClick={onOpenOutput}>Open full output</Button>
      </div>
    </details>
    <div className="fleet-activity-entry fleet-permission">
      <div className="fleet-activity-label"><Terminal size={14} aria-hidden /><span>Test command · {permission}</span></div>
      <small>npm test · /home/you/work/website</small>
      <div className="fleet-actions">
        {permission === 'Awaiting permission' && <><Button onClick={() => setPermission('Denied')}>Deny</Button><Button primary onClick={() => setPermission('Allowed once · Complete')}>Allow once</Button></>}
        {permission !== 'Stopped' && <Button onClick={() => setPermission('Stopped')}>Stop response</Button>}
      </div>
    </div>
  </section>;
}
