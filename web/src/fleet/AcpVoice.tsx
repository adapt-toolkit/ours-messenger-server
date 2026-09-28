import { useEffect, useRef, useState } from 'react';
import { Mic, AudioLines, Square, X, ArrowUp } from 'lucide-react';
import DialogShell from '../ui/DialogShell';
import { Button } from './components';
import { startVoiceRecording, type VoiceRecording } from '../voice';
import { transcribeAudio } from './live-api';

type Clip = Awaited<ReturnType<VoiceRecording['stop']>>;
export interface VoiceIntent { text: string; commandId: string; expectedSessionGeneration?: string }

/** A recording belongs to this mounted chat and the session present when recording began. */
export function AcpVoice({ active, disabled, generation, onSend, onBusy }: {
  active: boolean; disabled: boolean; generation?: string; onSend: (intent: VoiceIntent) => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const [mode, setMode] = useState<'idle'|'starting'|'recording'|'finishing'|'ready'|'transcribing'|'sending'>('idle');
  const [clip, setClip] = useState<Clip | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  useEffect(() => { onBusy(mode !== 'idle'); }, [mode, onBusy]);
  const audio = useRef<HTMLAudioElement>(null);
  const recorder = useRef<VoiceRecording>();
  const operation = useRef(0);
  const mounted = useRef(true);
  const currentActive = useRef(active); currentActive.current = active;
  const request = useRef<AbortController>();
  const boundGeneration = useRef<string>();
  const intent = useRef<VoiceIntent>();
  const uncertain = useRef(false);
  const limit = useRef<ReturnType<typeof setTimeout>>();
  const finishRef = useRef<() => Promise<void>>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current++; request.current?.abort(); recorder.current?.cancel(); clearTimeout(limit.current); };
  }, []);
  useEffect(() => {
    if (active) return;
    setLive(false); audio.current?.pause();
    // An admitted input cannot be cancelled. Keep its receipt path and stable intent.
    if (mode === 'sending') return;
    operation.current++; request.current?.abort(); recorder.current?.cancel(); recorder.current = undefined;
    clearTimeout(limit.current); setMode(clip ? 'ready' : 'idle');
  }, [active]);
  useEffect(() => { if (!clip) { setUrl(''); return; } const value = URL.createObjectURL(clip.blob); setUrl(value); return () => URL.revokeObjectURL(value); }, [clip]);
  const cancel = () => {
    if (uncertain.current || mode === 'sending') return;
    operation.current++; request.current?.abort(); recorder.current?.cancel(); recorder.current = undefined;
    clearTimeout(limit.current); intent.current = undefined; setClip(null); setError(''); setMode('idle');
  };
  const start = async () => {
    if (mode !== 'idle' || disabled || !active) return;
    const token = ++operation.current; boundGeneration.current = generation; setMode('starting'); setError('');
    try {
      const recording = await startVoiceRecording();
      if (!mounted.current || token !== operation.current || !currentActive.current) { recording.cancel(); return; }
      recorder.current = recording; setMode('recording');
      limit.current = setTimeout(() => { void finishRef.current?.(); }, 295_000);
    } catch (e) { if (mounted.current && token === operation.current) { setError((e as Error).message); setMode('idle'); } }
  };
  const finish = async () => {
    const recording = recorder.current; if (!recording) return;
    recorder.current = undefined; clearTimeout(limit.current); const token = operation.current; setMode('finishing');
    try {
      const result = await recording.stop();
      if (!mounted.current || token !== operation.current) return;
      setClip(result); setMode('ready');
      if (result.blob.size > 5 * 1024 * 1024) setError('Recording exceeds 5 MiB. Cancel and record a shorter message.');
    } catch (e) { if (mounted.current && token === operation.current) { setError((e as Error).message); setMode('idle'); } }
  };
  finishRef.current = finish;
  const send = async () => {
    if (!clip || mode !== 'ready' || disabled || !active) return;
    if (clip.blob.size > 5 * 1024 * 1024) return;
    // Permit a stable retry after a lost response; the server may already have admitted it.
    if (!uncertain.current && generation !== boundGeneration.current) { setError('Agent session changed. Cancel and record a new message.'); return; }
    const token = ++operation.current; const aborter = new AbortController(); request.current = aborter;
    const timeout = setTimeout(() => aborter.abort(), 95_000); setError('');
    try {
      if (!intent.current) {
        setMode('transcribing');
        const transcript = await transcribeAudio(clip.blob, clip.seconds, aborter.signal);
        if (!mounted.current || token !== operation.current || !currentActive.current) return;
        // Prefix guarantees recognized slash commands remain ordinary prompt text.
        intent.current = { text: 'Voice message:\n' + transcript, commandId: crypto.randomUUID(),
          ...(boundGeneration.current ? { expectedSessionGeneration: boundGeneration.current } : {}) };
      }
      setMode('sending'); uncertain.current = true;
      await onSend(intent.current);
      if (!mounted.current || token !== operation.current) return;
      uncertain.current = false; intent.current = undefined; setClip(null); setMode('idle');
    } catch (e) {
      if (mounted.current && token === operation.current) {
        if ((e as {accepted?:boolean}).accepted === false || ['stale_state','conflict','invalid_request','capability_unavailable','rejected'].includes((e as {code?:string}).code ?? '')) uncertain.current = false;
        setError((e as Error).name === 'AbortError' ? 'Transcription timed out. Your recording is kept for retry.' : (e as Error).message);
        setMode('ready');
      }
    } finally { clearTimeout(timeout); }
  };
  return <>
    <Button type="button" className="fleet-acp-send" aria-label="Record voice message" title="Record voice message" disabled={disabled || mode !== 'idle' || !active} onClick={() => void start()}><Mic size={20}/></Button>
    <Button type="button" className="fleet-acp-send" aria-label="Live voice mode" title="Live voice mode" onClick={() => setLive(true)}><AudioLines size={20}/></Button>
    {(mode !== 'idle' || error) && <div className="fleet-voice-panel" aria-label="Voice message">
      <div role="status">{({ idle:'', starting:'Waiting for microphone…', recording:'Recording · up to 5 minutes', finishing:'Preparing recording…', ready:'Voice message ready', transcribing:'Recognizing speech…', sending:'Sending voice message…' })[mode]}</div>
      {url && <audio ref={audio} aria-label="Recording preview" controls src={url}/>}
      {intent.current && <p className="fleet-voice-transcript">{intent.current.text}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="fleet-actions">
        {mode === 'recording' && <Button type="button" aria-label="Stop recording" onClick={() => void finish()}><Square size={18}/> Stop recording</Button>}
        {mode === 'ready' && <Button type="button" disabled={disabled || !active || (clip?.blob.size ?? 0) > 5 * 1024 * 1024} onClick={() => void send()}><ArrowUp size={18}/>{intent.current ? 'Retry voice message' : 'Send voice message'}</Button>}
        <Button type="button" aria-label="Cancel voice message" disabled={uncertain.current || mode === 'sending'} onClick={cancel}><X size={18}/> Cancel</Button>
      </div>
    </div>}
    {live && <DialogShell title="Live voice" description="Talk with your agent" onClose={() => setLive(false)}>
      <div className="fleet-live-voice"><AudioLines size={56} aria-hidden="true"/><h4>Live voice is not available yet</h4><p>You can still record and send a voice message.</p><Button type="button" onClick={() => setLive(false)}>Got it</Button></div>
    </DialogShell>}
  </>;
}
