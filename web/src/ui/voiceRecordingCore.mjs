// Preserve speech detail instead of optimizing voice notes solely for
// transcription size. Mono Opus at 48 kbps targets roughly 360 KB/minute
// before container overhead; iOS Safari may use its native MP4/AAC fallback.
export const VOICE_BITRATE = 48_000;

export const VOICE_CONTAINER_CANDIDATES = Object.freeze([
  { rec: 'audio/webm;codecs=opus', base: 'audio/webm', ext: 'webm' },
  { rec: 'audio/ogg;codecs=opus', base: 'audio/ogg', ext: 'ogg' },
  { rec: 'audio/webm', base: 'audio/webm', ext: 'webm' },
  { rec: 'audio/mp4', base: 'audio/mp4', ext: 'm4a' },
]);

export function estimatedVoiceBytes(seconds) {
  return Math.ceil((VOICE_BITRATE / 8) * Math.max(0, Number(seconds) || 0));
}
