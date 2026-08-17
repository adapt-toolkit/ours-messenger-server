export const VOICE_MARKER = 'x-ours-kind=voice-message';

/**
 * THE RECORDED LENGTH, CARRIED AS A MIME PARAMETER.
 *
 * A MediaRecorder started with a timeslice produces a STREAMED container, and a
 * streamed WebM/Opus has no duration in its header: `<audio>.duration` reads
 * `Infinity` at `loadedmetadata` and only becomes a real number after the element
 * has been made to scan the whole stream. So the length is not something the
 * renderer failed to read — it was never captured, never uploaded and never
 * stored, and no amount of work in the bubble can recover it for a peer.
 *
 * It is measured ONCE, by the sender, from the FINALISED blob, and travels beside
 * the existing voice marker in the same mime string. That keeps it in the
 * vocabulary this codebase already uses for voice metadata and needs no protocol
 * change; the server's mime validator already permits a decimal parameter value.
 *
 * ABSENCE IS PERMANENT, NOT TRANSITIONAL. Every voice message sent before this
 * existed has no duration and never will, and a browser that cannot measure one
 * still sends the message. Readers must degrade, never guess.
 */
export const VOICE_DURATION_PARAM = 'x-ours-duration';

/** Bound on the measurement: a send must not hang because an element never settles. */
export const VOICE_DURATION_TIMEOUT_MS = 4_000;

/** Serialise seconds for the mime parameter. Centiseconds is past display precision. */
export function formatVoiceDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return String(Math.round(seconds * 100) / 100);
}

/** Append the measured length to an ours voice mime. Unmeasured stays untouched. */
export function withVoiceDuration(oursMime: string, seconds: number | null): string {
  const value = seconds === null ? null : formatVoiceDuration(seconds);
  return value === null ? oursMime : `${oursMime};${VOICE_DURATION_PARAM}=${value}`;
}

/**
 * Read it back. Returns null for absent, malformed, zero, negative and
 * non-finite alike — every one of those means "no duration to show", and a
 * caller that has to tell them apart would be inventing a distinction the
 * display does not have.
 */
export function parseVoiceDuration(mime: string | undefined | null): number | null {
  if (!mime) return null;
  const match = new RegExp(`${VOICE_DURATION_PARAM}\\s*=\\s*([0-9]*\\.?[0-9]+)`, 'i').exec(mime);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface VoiceFormat {
  readonly recorderMime: string;
  readonly extension: 'ogg' | 'webm' | 'm4a';
  readonly oursMime: string;
}

export const VOICE_FORMATS: readonly VoiceFormat[] = [
  {
    recorderMime: 'audio/ogg;codecs=opus',
    extension: 'ogg',
    oursMime: `audio/ogg;codecs=opus;${VOICE_MARKER}`,
  },
  {
    recorderMime: 'audio/webm;codecs=opus',
    extension: 'webm',
    oursMime: `audio/webm;codecs=opus;${VOICE_MARKER}`,
  },
  {
    recorderMime: 'audio/mp4;codecs=mp4a.40.2',
    extension: 'm4a',
    oursMime: `audio/mp4;codecs=mp4a.40.2;${VOICE_MARKER}`,
  },
];

export function selectVoiceFormat(supported: (mime: string) => boolean): VoiceFormat | null {
  return VOICE_FORMATS.find((format) => supported(format.recorderMime)) ?? null;
}

export interface VoiceRecording {
  readonly recorder: MediaRecorder;
  readonly format: VoiceFormat;
  /** Resolves only once the blob is FINALISED and its length measured. */
  stop(): Promise<{ blob: Blob; filename: string; mime: string; seconds: number | null }>;
  cancel(): void;
}

/**
 * Measure a finalised recording by playing metadata, not by counting wall clock.
 *
 * Wall clock is the tempting shortcut and it is wrong: it counts the time the UI
 * was in a recording state, which includes the gap before the first sample and
 * anything the encoder dropped. This asks the same decoder the reader will use.
 *
 * `loadedmetadata` answers directly when the container carries a duration.
 * A streamed one reports `Infinity`; seeking past the end forces the element to
 * scan and emit a real `durationchange`. Both paths are bounded, and both may
 * legitimately give up — a null here is a message sent without a duration, not
 * a failed send.
 */
export function measureVoiceDuration(
  blob: Blob,
  timeoutMs = VOICE_DURATION_TIMEOUT_MS,
): Promise<number | null> {
  if (typeof Audio !== 'function' || typeof URL?.createObjectURL !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();
    let settled = false;
    const finish = (seconds: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(seconds) && (seconds ?? 0) > 0 ? seconds : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    audio.addEventListener('loadedmetadata', () => {
      // A USABLE duration is finite AND positive. Two containers fail that in
      // two different ways and both need the same treatment: a streamed WebM
      // reports Infinity, and MediaRecorder's fragmented MP4 — the iOS path —
      // commonly reports 0. Seeking past the end makes the element scan the
      // stream and emit a real durationchange in either case.
      if (Number.isFinite(audio.duration) && audio.duration > 0) finish(audio.duration);
      else audio.currentTime = Number.MAX_SAFE_INTEGER;
    }, { once: true });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) finish(audio.duration);
    });
    audio.addEventListener('error', () => finish(null), { once: true });
    audio.preload = 'metadata';
    audio.src = url;
  });
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
    throw new Error('Voice recording is not supported by this browser.');
  }
  const format = selectVoiceFormat((mime) => MediaRecorder.isTypeSupported(mime));
  if (!format) {
    throw new Error('This browser exposes no supported OGG/Opus, WebM/Opus, or MP4/AAC recorder.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { mimeType: format.recorderMime });
  const chunks: Blob[] = [];
  let cancelled = false;
  recorder.addEventListener('dataavailable', (event) => {
    if (!cancelled && event.data.size > 0) chunks.push(event.data);
  });
  const closeTracks = () => stream.getTracks().forEach((track) => track.stop());
  recorder.start(250);

  return {
    recorder,
    format,
    stop: () => new Promise((resolve, reject) => {
      recorder.addEventListener('error', () => {
        closeTracks();
        reject(new Error('The browser could not finish the voice recording.'));
      }, { once: true });
      recorder.addEventListener('stop', () => {
        closeTracks();
        const blob = new Blob(chunks, { type: format.recorderMime });
        if (blob.size === 0) {
          reject(new Error('The voice recording was empty.'));
          return;
        }
        const stamp = new Date().toISOString().replaceAll(':', '-');
        // FINALISE BEFORE SEND. The duration does not exist until the blob is
        // complete, so it is measured here, once, and carried with the message
        // rather than left for every reader to fail to recover.
        void measureVoiceDuration(blob).then((seconds) => {
          resolve({
            blob,
            seconds,
            filename: `voice-message-${stamp}.${format.extension}`,
            mime: withVoiceDuration(format.oursMime, seconds),
          });
        });
      }, { once: true });
      recorder.stop();
    }),
    cancel() {
      cancelled = true;
      chunks.length = 0;
      if (recorder.state !== 'inactive') recorder.stop();
      closeTracks();
    },
  };
}
