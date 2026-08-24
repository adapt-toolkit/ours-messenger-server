// THE MEASUREMENT ITSELF, ON A REAL RECORDING, IN A REAL BROWSER.
//
// The unit test pins the carrying and the absent case. This pins the part that
// can only be answered by a decoder: that `measureVoiceDuration` gets a true
// length out of a blob MediaRecorder just produced, and that the length it
// reports matches the audio rather than the wall clock.
//
// The module under test is the real web/src/voice.ts, bundled with esbuild and
// injected — not a copy of its logic re-typed into the page, which would pass
// forever after the source changed.
//
// WHAT THIS DOES NOT COVER, stated rather than implied: WebKit recordings whose
// fragmented MP4 container can report 0. This Chromium gate exercises that case
// only through the unit test's parsing of a zero, not a real MP4 recording.

import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const RECORD_MS = 3000;

const bundled = await build({
  entryPoints: [new URL('../web/src/voice.ts', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  globalName: 'oursVoice',
  write: false,
  platform: 'browser',
});
const source = bundled.outputFiles[0].text;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
await page.goto('about:blank');
await page.addScriptTag({ content: source });

const measured = await page.evaluate(async (recordMs) => {
  const { measureVoiceDuration, withVoiceDuration, parseVoiceDuration } = window.oursVoice;

  // VOICE_CONTAINER_CANDIDATES order, and the app's own recorder call: no
  // timeslice, which is what makes this a non-streamed container on Chromium.
  const CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
  const chosen = CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime));

  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const recorder = new MediaRecorder(dest.stream, { mimeType: chosen, audioBitsPerSecond: 48000 });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, recordMs));
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.stop();
  await stopped;
  osc.stop();
  await ctx.close();

  const base = chosen.split(';')[0];
  const blob = new Blob(chunks, { type: base });
  const seconds = await measureVoiceDuration(blob);
  const mime = withVoiceDuration(`${base}; x-ours-kind=voice-message`, seconds);

  // A STREAMED container, which is what the same recorder produces with a
  // timeslice, takes the Infinity path instead. Measuring it too proves the
  // seek-to-end branch is live rather than dead code on this engine.
  const streamedChunks = [];
  const ctx2 = new AudioContext();
  const osc2 = ctx2.createOscillator();
  const dest2 = ctx2.createMediaStreamDestination();
  osc2.connect(dest2);
  osc2.start();
  const streaming = new MediaRecorder(dest2.stream, { mimeType: chosen, audioBitsPerSecond: 48000 });
  streaming.ondataavailable = (event) => { if (event.data.size > 0) streamedChunks.push(event.data); };
  streaming.start(250);
  await new Promise((resolve) => setTimeout(resolve, recordMs));
  const stopped2 = new Promise((resolve) => { streaming.onstop = resolve; });
  streaming.stop();
  await stopped2;
  osc2.stop();
  await ctx2.close();
  const streamedBlob = new Blob(streamedChunks, { type: base });
  const rawStreamedDuration = await new Promise((resolve) => {
    const audio = new Audio();
    audio.addEventListener('loadedmetadata', () => resolve(String(audio.duration)), { once: true });
    audio.addEventListener('error', () => resolve('error'), { once: true });
    setTimeout(() => resolve('timeout'), 4000);
    audio.src = URL.createObjectURL(streamedBlob);
  });
  const streamedSeconds = await measureVoiceDuration(streamedBlob);

  return {
    chosen,
    seconds,
    mime,
    roundTripped: parseVoiceDuration(mime),
    emptyBlob: await measureVoiceDuration(new Blob([], { type: base })),
    rawStreamedDuration,
    streamedSeconds,
  };
}, RECORD_MS);

const expected = RECORD_MS / 1000;

assert.ok(typeof measured.seconds === 'number' && measured.seconds > 0,
  `a finalised recording yields a real length (got ${measured.seconds})`);
assert.ok(Math.abs(measured.seconds - expected) < 0.5,
  `and it is the length of the AUDIO, not of the UI state: ${measured.seconds}s for a ${expected}s take`);
assert.match(measured.mime, /x-ours-kind=voice-message/, 'the voice marker survives');
assert.equal(measured.roundTripped, Math.round(measured.seconds * 100) / 100,
  'and the value reads back off the mime unchanged');

// The streamed case: the container reports nothing usable, and the measurement
// recovers it anyway. If this ever starts reporting a finite duration directly,
// the assertion below tells us rather than the branch silently going unused.
assert.equal(measured.rawStreamedDuration, 'Infinity',
  'a streamed container still reports no duration of its own — the seek path is still needed');
assert.ok(typeof measured.streamedSeconds === 'number' && Math.abs(measured.streamedSeconds - expected) < 0.5,
  `and the measurement recovers it: ${measured.streamedSeconds}s`);

// Failure is a message without a duration, never a rejected send.
assert.equal(measured.emptyBlob, null, 'an unmeasurable blob resolves null rather than throwing or hanging');

await browser.close();
console.log('browser-voice-duration OK — measured from the finalised take, streamed containers recovered, failure resolves null');
