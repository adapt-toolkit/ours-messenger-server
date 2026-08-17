// DIAGNOSIS ONLY for "voice messages render duration 0".
//
// Answers ONE question before any code changes: does the duration exist upstream
// and get misread, or is it absent from the artefact the recorder produces?
//
// It drives a real Chromium, records a real MediaRecorder stream of a known
// length using the app's own format selection (web/src/voice.ts order), and then
// reads the blob back exactly the way FileBubbles' VoiceBubble does — via an
// <audio> element's loadedmetadata duration. It also checks what happens after a
// seek-to-end, which is the standard workaround for a container with no duration
// in its header, so we learn whether the value is recoverable at all.

import { chromium } from '@playwright/test';

const RECORD_MS = Number(process.env.REPRO_RECORD_MS ?? 3000);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', (m) => console.log('  [page]', m.text()));
await page.goto('about:blank');

const variants = [];
for (const variant of [
  { label: 'start(250) + Blob(chunks,{type})', timeslice: 250, typed: true },
  { label: 'start()      + Blob(chunks,{type})', timeslice: 0, typed: true },
  { label: 'start()      + Blob(chunks)  [what the app does today]', timeslice: 0, typed: false },
]) {
  variants.push({ variant: variant.label, ...(await page.evaluate(async ({ recordMs, timeslice, typed }) => {
  // The app's own candidate order, from web/src/voice.ts.
  const FORMATS = [
    { recorderMime: 'audio/ogg;codecs=opus', extension: 'ogg' },
    { recorderMime: 'audio/webm;codecs=opus', extension: 'webm' },
    { recorderMime: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  ];
  const support = FORMATS.map((f) => ({ mime: f.recorderMime, supported: MediaRecorder.isTypeSupported(f.recorderMime) }));
  const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.recorderMime));
  if (!format) return { error: 'no supported recorder mime', support };

  // A deterministic, non-silent source: a tone through a MediaStream destination.
  // Using a real oscillator rather than the fake mic keeps the amplitude known,
  // which matters for the waveform item as well.
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();

  const recorder = new MediaRecorder(dest.stream, { mimeType: format.recorderMime });
  const chunks = [];
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size > 0) chunks.push(e.data); });
  // recorder.start(250) — the timeslice the app uses. It is what makes the output
  // a STREAMED container, which is the usual reason a duration header is absent.
  if (timeslice) recorder.start(timeslice); else recorder.start();
  const startedAt = performance.now();
  await new Promise((r) => setTimeout(r, recordMs));
  const stopped = new Promise((r) => recorder.addEventListener('stop', r, { once: true }));
  recorder.stop();
  await stopped;
  const wallClockMs = Math.round(performance.now() - startedAt);
  osc.stop();
  await ctx.close();

  // Exactly what web/src/voice.ts builds.
  const blob = typed ? new Blob(chunks, { type: format.recorderMime }) : new Blob(chunks);

  const readDuration = (url) => new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (stage, value) => { if (!settled) { settled = true; resolve({ stage, value }); } };
    audio.addEventListener('loadedmetadata', () => done('loadedmetadata', audio.duration), { once: true });
    audio.addEventListener('error', () => done('error', null), { once: true });
    setTimeout(() => done('timeout', audio.duration), 4000);
    audio.src = url;
  });

  // And the standard recovery: seek past the end, which forces the element to
  // scan the stream and compute a real duration.
  const readAfterSeek = (url) => new Promise((resolve) => {
    const audio = new Audio();
    let settled = false;
    const done = (stage, value) => { if (!settled) { settled = true; resolve({ stage, value }); } };
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = 1e101; }, { once: true });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) done('durationchange-after-seek', audio.duration);
    });
    audio.addEventListener('error', () => done('error', null), { once: true });
    setTimeout(() => done('timeout', audio.duration), 6000);
    audio.src = url;
  });

  const url = URL.createObjectURL(blob);
  const direct = await readDuration(url);
  const seeked = await readAfterSeek(url);
  URL.revokeObjectURL(url);

  return {
    support,
    chosen: format.recorderMime,
    blobBytes: blob.size,
    chunkCount: chunks.length,
    wallClockMs,
    direct: { stage: direct.stage, value: String(direct.value) },
    seeked: { stage: seeked.stage, value: String(seeked.value) },
  };
}, { recordMs: RECORD_MS, timeslice: variant.timeslice, typed: variant.typed })) });
}

console.log('\n--- voice duration diagnosis ---');
for (const row of variants) {
  console.log(`\n${row.variant}`);
  console.log(`  chosen=${row.chosen} bytes=${row.blobBytes} chunks=${row.chunkCount} recorded=${row.wallClockMs}ms`);
  console.log(`  loadedmetadata duration = ${String(row.direct.value)} (${row.direct.stage})`);
  console.log(`  after seek-to-end       = ${String(row.seeked.value)} (${row.seeked.stage})`);
}

await browser.close();
process.exit(0);
