export const VOICE_BITRATE: 48000;
export const VOICE_CONTAINER_CANDIDATES: ReadonlyArray<{
  rec: string;
  base: string;
  ext: string;
}>;
export function estimatedVoiceBytes(seconds: number): number;
