import { useRef, useState } from 'react';
import type { Task } from './model';
import { fleet, taskView } from './live-api';

export function TaskDescription({ task, onSaved }: { task: Task; onSaved(task: Task): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await fleet(`/tasks/${encodeURIComponent(task.id)}/description`, { brief: draft, expectedBrief: base }, 'PATCH');
      onSaved(taskView(result.task)); setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save description'); }
    finally { saving.current = false; setBusy(false); }
  }
  return <section aria-label="Task description">
    <div className="fleet-description-heading"><h2>Description</h2>{!editing && <button onClick={() => {
      setDraft(task.description); setBase(task.description); setError(''); setEditing(true);
    }}>Edit description</button>}</div>
    {editing ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <textarea aria-label="Description" autoFocus rows={8} maxLength={100000} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)} />
      {error && <p role="alert">{error}</p>}
      <div className="fleet-description-actions"><button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
    </form> : <p className={task.description ? 'fleet-task-description' : 'muted'}>{task.description || 'No description yet.'}</p>}
  </section>;
}
