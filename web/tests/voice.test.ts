import assert from 'node:assert/strict';
import { selectVoiceFormat, VOICE_FORMATS, VOICE_MARKER } from '../src/voice.js';

assert.equal(selectVoiceFormat((mime) => mime.startsWith('audio/ogg'))?.recorderMime, 'audio/ogg;codecs=opus',
  'OGG/Opus is the deterministic first choice');
assert.equal(selectVoiceFormat((mime) => mime.startsWith('audio/webm'))?.recorderMime, 'audio/webm;codecs=opus',
  'WebM/Opus is the deterministic fallback when OGG is unavailable');
assert.equal(selectVoiceFormat((mime) => mime.startsWith('audio/mp4'))?.extension, 'm4a',
  'Safari-compatible MP4/AAC is the final explicit browser fallback');
assert.equal(selectVoiceFormat(() => false), null, 'unsupported browsers fail closed instead of lying about the container');
for (const format of VOICE_FORMATS) {
  assert.ok(format.oursMime.includes(VOICE_MARKER), `${format.recorderMime} carries the exact ours voice marker`);
  assert.ok(format.recorderMime.includes('codecs='), `${format.recorderMime} asserts its codec rather than relying on a browser default`);
}

console.log('voice OK — deterministic format priority and exact ours voice metadata marker');
