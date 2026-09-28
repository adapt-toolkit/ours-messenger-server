import { useEffect, useRef, useState } from 'react';
import { AudioLines } from 'lucide-react';
import DialogShell from '../ui/DialogShell';
import { AttachPreview, VoiceComposer, type PendingAttachment } from '../ui/FileBubbles';
import { Button } from './components';
import { parseVoiceDuration } from '../voice';
import { transcribeAudio } from './live-api';

export interface VoiceIntent { text: string; commandId: string; expectedSessionGeneration?: string }
export function appendTranscript(text: string, transcript: string): string {
  return text + (text && !/\s$/.test(text) ? '\n' : '') + transcript.trim();
}

/** Shared Messenger recorder; recognition only edits the draft, never sends it. */
export function AcpVoice({ active, disabled, sessionGeneration, onTranscript, onBusy }: {
  active: boolean; disabled: boolean; sessionGeneration?: string; onTranscript: (text: string, generation?: string) => void; onBusy: (busy: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [clip, setClip] = useState<PendingAttachment | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const takeGeneration = useRef<string>();
  const recordingActive = useRef(false);
  const request = useRef<AbortController>();
  const operation = useRef(0);
  const mounted = useRef(true);
  const currentGeneration = useRef(sessionGeneration); currentGeneration.current = sessionGeneration;
  const currentActive = useRef(active); currentActive.current = active;
  const add = useRef(onTranscript); add.current = onTranscript;
  useEffect(() => { onBusy(recording || !!clip || transcribing); }, [recording, clip, transcribing, onBusy]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current++; request.current?.abort(); }; }, []);
  useEffect(() => {
    if (active) return;
    operation.current++; request.current?.abort(); request.current = undefined; setTranscribing(false); recordingActive.current = false; setRecording(false); setLive(false);
  }, [active]);
  const discard = () => { operation.current++; request.current?.abort(); request.current = undefined; setTranscribing(false); setClip(null); setError(''); };
  const recognize = async (take = clip) => {
    if (!take || request.current || disabled || !currentActive.current) return;
    if (take.bytes.length > 5 * 1024 * 1024) { setError('Recording exceeds 5 MiB. Discard and record a shorter message.'); return; }
    const token = ++operation.current; const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 95_000);
    setError(''); setTranscribing(true);
    try {
      const text = await transcribeAudio(new Blob([take.bytes as BlobPart], { type: take.mime.split(';')[0] }), parseVoiceDuration(take.mime), controller.signal);
      if (!mounted.current || token !== operation.current || !currentActive.current) return;
      if (takeGeneration.current !== currentGeneration.current) throw new Error("Agent session changed. Discard this recording and record again in the current session.");
      add.current(text, takeGeneration.current); setClip(null);
    } catch (e) {
      if (mounted.current && token === operation.current) setError((e as Error).name === 'AbortError' ? 'Transcription timed out. Your recording is kept for retry.' : (e as Error).message);
    } finally { clearTimeout(timeout); if (token === operation.current) { request.current = undefined; if (mounted.current) setTranscribing(false); } }
  };
  return <>
    {active && <VoiceComposer disabled={disabled || !!clip || transcribing} onReady={att => { if (!mounted.current || !currentActive.current) return; setClip(att); setError(''); void recognize(att); }} onError={setError} onActiveChange={value => { if (value && !recordingActive.current) takeGeneration.current = sessionGeneration; recordingActive.current = value; setRecording(value); }}/>}
    <Button type="button" className="fleet-acp-send fleet-live-voice-trigger" aria-label="Live voice mode" title="Live voice mode" onClick={() => setLive(true)}><AudioLines size={20}/></Button>
    {(clip || error) && active && <div className="fleet-voice-panel" aria-label="Voice message">
      {clip && <AttachPreview compact att={clip} sending={transcribing} actionLabel="Retry" busyLabel="Recognizing speech…" allowDiscardWhileBusy onSend={() => void recognize()} onDiscard={discard}/>}
      {error && <p role="alert">{error}</p>}
    </div>}
    {live && <DialogShell title="Live voice" description="Talk with your agent" onClose={() => setLive(false)}>
      <div className="fleet-live-voice"><AudioLines size={56} aria-hidden="true"/><h4>Live voice is not available yet</h4><p>You can still record and transcribe a voice message.</p><Button type="button" onClick={() => setLive(false)}>Got it</Button></div>
    </DialogShell>}
  </>;
}
