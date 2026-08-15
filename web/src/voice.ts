export const VOICE_MARKER = 'x-ours-kind=voice-message';

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
  stop(): Promise<{ blob: Blob; filename: string; mime: string }>;
  cancel(): void;
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
        resolve({
          blob,
          filename: `voice-message-${stamp}.${format.extension}`,
          mime: format.oursMime,
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
