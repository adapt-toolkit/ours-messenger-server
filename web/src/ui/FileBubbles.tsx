// Conversation file UI: image bubbles, voice-note player, generic file cards,
// the pre-send attachment preview, and the voice recorder. Rendering is
// direction-agnostic (dir 'in'|'out') so inbound files light up unchanged
// when the Phase-B packet fix stops dropping them.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import {
  FileRecord,
  getFileBytes,
  getFileUrl,
  fmtSize,
  isVoiceNote,
  voiceMime,
  VOICE_FILE_PREFIX,
  MAX_FILE_BYTES,
  fetchFile,
} from './fileStore';
import { MessageReceipt, type MessageReceiptState } from './MessageReceipt';
import { isMarkdownFilename } from './markdownReviewCore.mjs';
import { attachmentBlobMime, isHtmlAttachment } from './htmlPreviewCore.mjs';
import { VOICE_BITRATE, VOICE_CONTAINER_CANDIDATES } from './voiceRecordingCore.mjs';
import { measureVoiceDuration, parseVoiceDuration, withVoiceDuration } from '../voice.js';
import {
  createLiveWaveformScaler, LIVE_WAVEFORM_BARS, peaksFromSamples, WAVEFORM_BARS, waveformBars,
} from './voiceWaveformCore.mjs';

// The playable mime = the base type (a voice note's mime is
// `<real container>; x-ours-kind=voice-message` — strip the marker param).
// HTML is the exception: a blob: URL inherits our origin, so those bytes are
// published under a neutral type that cannot render (attachmentBlobMime).
function playableMime(rec: { mime: string; filename: string }): string {
  return attachmentBlobMime(rec.mime, rec.filename);
}

// Lazy object-URL + byte size for a stored blob; revoked on unmount. Bytes are
// keyed by rec.id (the message wire_id for conversation-rendered files); a null
// url means "bytes not on this device yet" (e.g. a restored history entry).
// `loaded` flips true once the byte lookup RESOLVES — so `loaded && !url` means
// "bytes are genuinely not on this device" (a restored-history / cross-device
// entry: metadata survives a restore, bytes are device-local), distinct from
// the transient "still loading" before it resolves. Bubbles show a calm
// "available on your original device" state for the former.
function useFileBlob(rec: FileRecord): { url: string | null; size: number; loaded: boolean } {
  const [state, setState] = useState<{ url: string | null; size: number; loaded: boolean }>({ url: null, size: 0, loaded: false });
  useEffect(() => {
    let revoke: string | null = null;
    let dead = false;
    setState({ url: null, size: 0, loaded: false });
    const directUrl = rec.available ? getFileUrl(rec.id) : null;
    if (directUrl) {
      setState({ url: directUrl, size: rec.size, loaded: true });
      return () => {};
    }
    void getFileBytes(rec.id).then((bytes) => {
      if (dead) return;
      if (!bytes) { setState({ url: null, size: 0, loaded: true }); return; }
      const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: playableMime(rec) }));
      revoke = u;
      setState({ url: u, size: bytes.byteLength, loaded: true });
    });
    return () => {
      dead = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [rec.id, rec.available]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

// Shared "bytes live on the sender's original device" degraded row — kept calm
// and legible (not an error), since this is expected after a cross-device
// restore where only the file's metadata came along.
function OriginalDeviceNote({ label }: { label: string }) {
  return (
    <div className="file-offdevice">
      <div className="file-offdevice-ic"><Icon name="inbox" size={16} /></div>
      <div className="filecard-meta">
        <div className="filecard-name" title={label}>{label}</div>
        <div className="filecard-sub">Available on your original device</div>
      </div>
    </div>
  );
}

function bubbleTime(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function VoiceTranscript({ rec }: { rec: FileRecord }) {
  if (!rec.transcription) return null;
  const text = rec.transcription.text?.trim();
  return (
    <div className="voice-transcript">
      {text || `Transcription ${rec.transcription.status ?? 'unavailable'}${rec.transcription.error_category ? ` · ${rec.transcription.error_category}` : ''}`}
    </div>
  );
}

export function FileBubble({
  rec,
  receipt,
  receiptless,
  onPreview,
  onFetch,
}: {
  rec: FileRecord;
  receipt?: MessageReceiptState;
  receiptless?: boolean;
  onPreview?: (rec: FileRecord) => void;
  onFetch?: (wireId: string) => Promise<void>;
}) {
  const me = rec.dir === 'out';
  const cls = `bubble file-bubble${me ? ' me' : ''}`;
  const receiptContent = isVoiceNote(rec.mime, rec.filename) ? 'Voice message' : 'File';
  const footer = (
    <div className="bubble-at">
      {bubbleTime(rec.date)}
      {me && <MessageReceipt receipt={receipt} content={receiptContent} receiptless={receiptless} />}
    </div>
  );
  if (rec.mime.startsWith('image/')) return <ImageBubble rec={rec} cls={cls} footer={footer} onFetch={onFetch} />;
  if (isVoiceNote(rec.mime, rec.filename)) return <VoiceBubble rec={rec} cls={cls} footer={footer} onFetch={onFetch} />;
  return <FileCardBubble rec={rec} cls={cls} footer={footer} onPreview={onPreview} onFetch={onFetch} />;
}

function FetchMedia({ rec, onFetch }: { rec: FileRecord; onFetch?: (wireId: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <div className="file-offdevice">
      <div className="file-offdevice-ic"><Icon name="inbox" size={16} /></div>
      <div className="filecard-meta">
        <div className="filecard-name" title={rec.filename}>{isVoiceNote(rec.mime, rec.filename) ? 'Voice message' : rec.filename}</div>
        <div className="filecard-sub">{error ? 'Could not fetch media' : 'Available after explicit fetch'}</div>
      </div>
      <button className="btn sm" disabled={busy} onClick={() => {
        setBusy(true); setError(false);
        void (onFetch?.(rec.id) ?? fetchFile(rec.id)).catch(() => setError(true)).finally(() => setBusy(false));
      }}>{busy ? 'Fetching…' : 'Fetch'}</button>
    </div>
  );
}

function ImageBubble({ rec, cls, footer, onFetch }: { rec: FileRecord; cls: string; footer: ReactNode; onFetch?: (wireId: string) => Promise<void> }) {
  const { url, loaded } = useFileBlob(rec);
  if (loaded && !url) {
    return (
      <div className={cls + ' filecard-bubble file-offdevice-bubble'}>
        {rec.available === false ? <FetchMedia rec={rec} onFetch={onFetch} /> : <OriginalDeviceNote label={rec.filename && rec.filename !== 'file' ? rec.filename : 'Photo'} />}
        {footer}
      </div>
    );
  }
  return (
    <div className={cls + ' image-bubble'}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" title={rec.filename}>
          <img src={url} alt={rec.filename} />
        </a>
      ) : (
        <div className="file-loading">loading…</div>
      )}
      {footer}
    </div>
  );
}

function VoiceBubble({ rec, cls, footer, onFetch }: { rec: FileRecord; cls: string; footer: ReactNode; onFetch?: (wireId: string) => Promise<void> }) {
  const { url, loaded } = useFileBlob(rec);
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  // The length the SENDER measured from the finalised blob, carried in the mime.
  // It is the only source that works for a peer: a streamed container reports no
  // duration, so an element on this device has nothing to read. Absent for every
  // voice message sent before that was captured, and for a sender whose browser
  // could not measure one — permanently, not transitionally. Absent stays null,
  // and the bubble shows '·:··' rather than inventing 0:00.
  const [dur, setDur] = useState<number | null>(() => parseVoiceDuration(rec.mime));
  const [scrubbing, setScrubbing] = useState(false);
  // The shape of the recording, decoded once from the bytes already fetched for
  // playback. Null until it is known — the thin track is the honest fallback for
  // a note whose bytes are still on the other device, or whose container this
  // browser cannot decode. Nothing here is invented: every bar is measured off
  // the actual samples.
  const [bars, setBars] = useState<number[] | null>(null);

  if (loaded && !url) {
    return (
      <div className={cls + ' filecard-bubble file-offdevice-bubble'}>
        {rec.available === false ? <FetchMedia rec={rec} onFetch={onFetch} /> : <OriginalDeviceNote label="Voice message" />}
        {footer}
        <VoiceTranscript rec={rec} />
      </div>
    );
  }

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const Ctx = typeof window === 'undefined'
      ? undefined
      : window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void (async () => {
      try {
        const bytes = await fetch(url, { cache: 'force-cache' }).then((response) => response.arrayBuffer());
        const decoded = await ctx.decodeAudioData(bytes);
        if (cancelled) return;
        setBars(waveformBars(peaksFromSamples(decoded.getChannelData(0), WAVEFORM_BARS)));
      } catch {
        // Decoding is presentation only. A container this browser cannot read
        // must still play through the element and must not break the bubble.
      } finally {
        void ctx.close().catch(() => {});
      }
    })();
    return () => { cancelled = true; void ctx.close().catch(() => {}); };
  }, [url]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) a.pause();
    else void a.play();
  };

  // Scrub/seek: map a pointer x on the track to a fraction and set currentTime.
  // Pointer capture lets the drag continue outside the thin track.
  const fracFromEvent = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const seekTo = (frac: number) => {
    const a = audioRef.current;
    setProgress(frac);
    if (a && dur && isFinite(dur)) a.currentTime = frac * dur;
  };
  const onScrubDown = (e: React.PointerEvent) => {
    if (!url) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setScrubbing(true);
    seekTo(fracFromEvent(e.clientX));
  };
  const onScrubMove = (e: React.PointerEvent) => {
    if (!scrubbing) return;
    seekTo(fracFromEvent(e.clientX));
  };
  const onScrubUp = (e: React.PointerEvent) => {
    if (!scrubbing) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    setScrubbing(false);
  };

  return (
    <div className={cls + ' voice-bubble'}>
      <button className="voice-play" onClick={toggle} disabled={!url} title={playing ? 'Pause' : 'Play'}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div
        className={'voice-track' + (url ? ' seekable' : '') + (scrubbing ? ' scrubbing' : '') + (bars ? ' has-wave' : '')}
        ref={trackRef}
        onPointerDown={onScrubDown}
        onPointerMove={onScrubMove}
        onPointerUp={onScrubUp}
        onPointerCancel={onScrubUp}
        role={url ? 'slider' : undefined}
        aria-label={url ? 'Seek' : undefined}
        aria-valuenow={Math.round(progress * 100)}
      >
        {bars ? (
          <div className="voice-wave" aria-hidden>
            {bars.map((height, index) => (
              <span
                key={index}
                className={'voice-wave-bar' + (index / bars.length < progress ? ' played' : '')}
                style={{ height: `${Math.round(height * 100)}%` }}
              />
            ))}
          </div>
        ) : (
          <div className="voice-track-fill" style={{ width: `${progress * 100}%` }} />
        )}
        {url && <span className="voice-track-knob" style={{ left: `${progress * 100}%` }} />}
      </div>
      <span className="voice-dur mono">
        {dur !== null ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}` : '·:··'}
      </span>
      {url && (
        <audio
          ref={audioRef}
          src={url}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => { setPlaying(false); setProgress(0); }}
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            if (!scrubbing && a.duration > 0 && isFinite(a.duration)) setProgress(a.currentTime / a.duration);
          }}
          onLoadedMetadata={(e) => {
            // Only when the container actually carries one — a real value here
            // is at least as good as the sender's, and Infinity is what a
            // streamed container reports. Never downgrade a carried duration.
            const d = e.currentTarget.duration;
            if (isFinite(d) && d > 0) setDur(d);
          }}
        />
      )}
      {footer}
      <VoiceTranscript rec={rec} />
    </div>
  );
}

function FileCardBubble({
  rec,
  cls,
  footer,
  onPreview,
  onFetch,
}: {
  rec: FileRecord;
  cls: string;
  footer: ReactNode;
  onPreview?: (rec: FileRecord) => void;
  onFetch?: (wireId: string) => Promise<void>;
}) {
  const { url, size, loaded } = useFileBlob(rec);
  if (loaded && !url) {
    return (
      <div className={cls + ' filecard-bubble file-offdevice-bubble'}>
        {rec.available === false ? <FetchMedia rec={rec} onFetch={onFetch} /> : <OriginalDeviceNote label={rec.filename} />}
        {footer}
      </div>
    );
  }
  return (
    <div className={cls + ' filecard-bubble'}>
      <div className="filecard">
        <div className="filecard-ic">
          <Icon name="copy" size={18} />
        </div>
        <div className="filecard-meta">
          <div className="filecard-name" title={rec.filename}>{rec.filename}</div>
          <div className="filecard-sub">{size ? fmtSize(size) : rec.size ? fmtSize(rec.size) : ''}</div>
        </div>
        {isMarkdownFilename(rec.filename) && url && onPreview && (
          <button className="icon-btn" onClick={() => onPreview(rec)} title="Preview markdown">
            <Icon name="monitor" size={16} />
          </button>
        )}
        {isHtmlAttachment(rec.filename, rec.mime) && url && onPreview && (
          <button className="icon-btn" onClick={() => onPreview(rec)} title="Preview HTML">
            <Icon name="monitor" size={16} />
          </button>
        )}
        <a
          className={'icon-btn' + (url ? '' : ' disabled')}
          href={url ?? undefined}
          download={rec.filename}
          title="Download"
        >
          <Icon name="download" size={16} />
        </a>
      </div>
      {footer}
    </div>
  );
}

// ---- pre-send attachment (picked file or finished voice note) --------------

export interface PendingAttachment {
  filename: string;
  mime: string;
  bytes: Uint8Array;
  voice?: boolean;
  originalSize?: number;
}

export function AttachPreview(props: {
  att: PendingAttachment;
  sending: boolean;
  onSend: () => void;
  onDiscard: () => void;
}) {
  const { att } = props;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const type = playableMime({ mime: att.mime, filename: att.filename });
    const u = URL.createObjectURL(new Blob([att.bytes as BlobPart], { type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [att]);

  return (
    <div className="attach-preview">
      {att.mime.startsWith('image/') && url ? (
        <img className="attach-thumb" src={url} alt={att.filename} />
      ) : att.voice && url ? (
        <audio className="attach-audio" src={url} controls />
      ) : (
        <div className="filecard-ic"><Icon name="copy" size={16} /></div>
      )}
      <div className="filecard-meta">
        <div className="filecard-name" title={att.filename}>{att.voice ? 'Voice message' : att.filename}</div>
        <div className="filecard-sub">
          {fmtSize(att.bytes.length)}
          {att.originalSize && att.originalSize > att.bytes.length
            ? ` · optimized from ${fmtSize(att.originalSize)}`
            : ''}
        </div>
      </div>
      <button className="btn primary sm" disabled={props.sending} onClick={props.onSend}>
        {props.sending ? 'Sending…' : 'Send'}
      </button>
      <button className="icon-btn" title="Discard" disabled={props.sending} onClick={props.onDiscard}>
        <Icon name="close" />
      </button>
    </div>
  );
}

// ---- voice recorder ---------------------------------------------------------

// Container preference by what MediaRecorder supports. Opus is first because
// it preserves speech intelligibility at a much lower bitrate than the old
// default recording. iOS Safari falls through to its native MP4/AAC container.
// The declared base mime is always the REAL recorded container, so the
// bytes play back cross-platform and Dev-8's parameter rides truthfully.
// Capture hints for speech. All PLAIN values (never `{ exact: … }`) so a device
// that cannot honour one degrades instead of failing getUserMedia outright.
// sampleRate is deliberately left unconstrained — iOS Safari rejects takes that
// pin it, and the encoder resamples anyway.
const VOICE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// Telegram-style voice input: the mic button IS the recorder. Press-and-HOLD to
// record; RELEASE = ready-to-send (never auto-sent — onReady hands a pending
// attachment to the composer's Send). While holding, slide UP past a threshold
// to LOCK (hands-free, finger can lift) and slide LEFT past a threshold to
// cancel. A live waveform (Web Audio analyser) runs during hold and lock.
// Gesture is Pointer Events + a window move/up capture so the finger can leave
// the button — verified on Chromium; owner's iPhone is the WebKit gate.
const LOCK_DIST = 84; // px upward to lock hands-free
const CANCEL_DIST = 120; // px leftward to cancel
const MIN_MS = 550; // shorter than this on release = a mis-tap, discarded
// How long a take the byte cap can actually carry, at the rate we encode at.
// DERIVED from MAX_FILE_BYTES on purpose: a hand-tuned duration that outgrew the
// byte cap is exactly how the 6 MB note got through the UI and died in the VM.
const VOICE_MAX_SECONDS_BY_BYTES = Math.floor(MAX_FILE_BYTES / (VOICE_BITRATE / 8));
// 5 min is the PRODUCT cap (a voice note, not a podcast); the byte cap is the
// transport truth. Take whichever binds first so the two can never disagree.
const MAX_SECONDS = Math.min(300, VOICE_MAX_SECONDS_BY_BYTES);
const WAVE_BARS = LIVE_WAVEFORM_BARS;

export function VoiceComposer(props: {
  disabled?: boolean;
  onReady: (att: PendingAttachment) => void;
  onError: (msg: string) => void;
  onActiveChange?: (active: boolean) => void;
}) {
  type Mode = 'idle' | 'arming' | 'recording' | 'locked';
  const [mode, setMode] = useState<Mode>('idle');
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [slideLock, setSlideLock] = useState(0); // 0..1 progress toward lock
  const [slideCancel, setSlideCancel] = useState(0); // 0..1 progress toward cancel

  // Everything the async recorder + window handlers touch lives in refs so the
  // shell's 5s notify re-render never tears the take down (the bug that stuck
  // the old recorder's discard flag). Props are inline arrows → keep in refs.
  const modeRef = useRef<Mode>('idle');
  const recRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const extRef = useRef('webm');
  const baseRef = useRef('audio/webm');
  const discardRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });
  const t0Ref = useRef(0);
  const releasedEarlyRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onReadyRef = useRef(props.onReady);
  const onErrorRef = useRef(props.onError);
  const onActiveRef = useRef(props.onActiveChange);
  onReadyRef.current = props.onReady;
  onErrorRef.current = props.onError;
  onActiveRef.current = props.onActiveChange;

  const setModeBoth = (m: Mode) => {
    modeRef.current = m;
    setMode(m);
    onActiveRef.current?.(m === 'recording' || m === 'locked' || m === 'arming');
  };

  const teardownAudio = () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const removeWinListeners = () => {
    window.removeEventListener('pointermove', winMove);
    window.removeEventListener('pointerup', winUp);
    window.removeEventListener('pointercancel', winUp);
  };

  // stop → produce (or discard) the take; reset UI
  const finish = (discard: boolean) => {
    discardRef.current = discard;
    const rec = recRef.current;
    if (rec && rec.state !== 'inactive') rec.stop(); // onstop fires onReady
    else afterStop(); // no recorder yet (arming) — just reset
    removeWinListeners();
  };

  const afterStop = () => {
    teardownAudio();
    setModeBoth('idle');
    setSeconds(0);
    setLevels([]);
    setSlideLock(0);
    setSlideCancel(0);
  };

  const lock = () => {
    if (modeRef.current !== 'recording') return;
    removeWinListeners(); // finger is free now
    setSlideCancel(0);
    setModeBoth('locked');
  };

  function winMove(e: PointerEvent) {
    if (modeRef.current !== 'recording') return;
    const up = startRef.current.y - e.clientY; // + when moving up
    const left = startRef.current.x - e.clientX; // + when moving left
    const lockP = Math.max(0, Math.min(1, up / LOCK_DIST));
    const cancelP = Math.max(0, Math.min(1, left / CANCEL_DIST));
    setSlideLock(lockP);
    setSlideCancel(cancelP);
    if (up >= LOCK_DIST) lock();
    else if (left >= CANCEL_DIST) finish(true);
  }
  function winUp() {
    if (modeRef.current === 'arming') {
      releasedEarlyRef.current = true; // released before the mic opened → cancel
      removeWinListeners();
      return;
    }
    if (modeRef.current !== 'recording') return;
    const short = Date.now() - t0Ref.current < MIN_MS;
    finish(short); // hold too short → discard (a mis-tap)
  }

  const beginHold = (e: React.PointerEvent) => {
    if (props.disabled || modeRef.current !== 'idle') return;
    e.preventDefault(); // no focus/selection flicker on press
    startRef.current = { x: e.clientX, y: e.clientY };
    releasedEarlyRef.current = false;
    discardRef.current = false;
    chunksRef.current = [];
    setSlideLock(0);
    setSlideCancel(0);
    setModeBoth('arming');
    window.addEventListener('pointermove', winMove);
    window.addEventListener('pointerup', winUp);
    window.addEventListener('pointercancel', winUp);
    void startRecording();
  };

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: VOICE_CONSTRAINTS });
    } catch {
      onErrorRef.current('Microphone unavailable — check the browser permission.');
      removeWinListeners();
      setModeBoth('idle');
      return;
    }
    if (releasedEarlyRef.current || modeRef.current === 'idle') {
      stream.getTracks().forEach((t) => t.stop()); // released during the permission prompt
      setModeBoth('idle');
      return;
    }
    streamRef.current = stream;
    const pick = VOICE_CONTAINER_CANDIDATES.find(
      (c) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.rec),
    );
    extRef.current = pick?.ext ?? 'webm';
    baseRef.current = pick?.base ?? 'audio/webm';
    const rec = pick
      ? new MediaRecorder(stream, { mimeType: pick.rec, audioBitsPerSecond: VOICE_BITRATE })
      : new MediaRecorder(stream, { audioBitsPerSecond: VOICE_BITRATE });
    recRef.current = rec;
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      const discard = discardRef.current;
      if (discard) { afterStop(); return; }
      // TYPED, because the length is measured off this blob through an <audio>
      // element and an untyped one gives the decoder nothing to go on.
      const blob = new Blob(chunksRef.current, { type: baseRef.current });
      void Promise.all([blob.arrayBuffer(), measureVoiceDuration(blob)]).then(([buf, seconds]) => {
        afterStop();
        if (buf.byteLength === 0) return;
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
        onReadyRef.current({
          // the LOCKED Dev-8 marker: real container base + x-ours-kind param,
          // now with the length measured from the FINALISED take beside it.
          filename: `${VOICE_FILE_PREFIX}${stamp}.${extRef.current}`,
          mime: withVoiceDuration(voiceMime(baseRef.current), seconds),
          bytes: new Uint8Array(buf),
          voice: true,
        });
      });
    };
    rec.start();
    t0Ref.current = Date.now();
    setModeBoth('recording');
    setSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const n = s + 1;
        if (n >= MAX_SECONDS) finish(false); // auto-stop at the cap → ready
        return n;
      });
    }, 1000);
    startWaveform(stream);
  }

  function startWaveform(stream: MediaStream) {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      // Speech sits near the bottom of a linear scale, so a linear bar flatlines
      // however tall the strip is. The scaler tracks a decaying running maximum
      // and curves the result, which keeps a quiet passage moving.
      const scaler = createLiveWaveformScaler();
      let last = 0;
      const tick = (ts: number) => {
        rafRef.current = requestAnimationFrame(tick);
        if (ts - last < 80) return; // ~12 fps of bars
        last = ts;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const level = scaler.push(rms);
        setLevels((prev) => {
          const next = prev.length >= WAVE_BARS ? prev.slice(1) : prev.slice();
          next.push(level);
          return next;
        });
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      /* waveform is decorative — a failed AudioContext must not break recording */
    }
  }

  // clean up if the component ever unmounts mid-take (e.g. contact switch)
  useEffect(() => () => { discardRef.current = true; recRef.current?.stop(); removeWinListeners(); teardownAudio(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const active = mode === 'recording' || mode === 'locked' || mode === 'arming';

  const wave = (
    <div className="vr-wave" aria-hidden>
      {levels.map((l, i) => (
        <span key={i} className="vr-bar" style={{ height: `${Math.round(l * 100)}%` }} />
      ))}
    </div>
  );

  return (
    <>
      <button
        className="icon-btn composer-tool vr-mic"
        title="Hold to record a voice message"
        disabled={props.disabled}
        onPointerDown={beginHold}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name="mic" size={18} />
      </button>
      {active && (
        <div className="voice-rec-overlay" data-mode={mode}>
          {mode === 'recording' && (
            <div className="vr-lock" style={{ ['--p' as string]: slideLock }} aria-hidden>
              <Icon name="lock" size={13} />
              <Icon name="chevronDown" size={12} />
            </div>
          )}
          <span className="voice-rec-dot" />
          <span className="vr-time mono">{fmtClock(seconds)}</span>
          {mode === 'locked' ? (
            <>
              {wave}
              <button className="icon-btn vr-trash" title="Cancel" onClick={() => finish(true)}>
                <Icon name="trash" size={16} />
              </button>
              <button className="btn primary sm vr-stop" onClick={() => finish(false)}>
                <Icon name="check" size={13} />
                Stop
              </button>
            </>
          ) : (
            <div className="vr-slide" style={{ opacity: 1 - slideCancel }}>
              {wave}
              <span className="vr-hint">‹ slide to cancel · slide up to lock</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
