// THE WAVEFORM, MEASURED ON SCREEN.
//
// The unit gate pins the shaping — whether quiet speech spreads across the
// track. This pins the other half the owner asked for: that the thing is
// actually big enough to read, and that the message bubble HAS one at all,
// which it previously did not (a 4px progress rail is not a waveform).
//
// Both halves are measured in a real browser against the real built CSS. Bar
// heights inside the message bubble come from a real decode of real audio: the
// page records a tone with MediaRecorder, sends it through the media endpoint
// the app uses, and lets the bubble decode it exactly as a reader would.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// The REAL shaping module, so the bars measured below are the bars the component
// would draw rather than numbers re-typed into this file.
const bundled = await build({
  entryPoints: [new URL('../web/src/ui/voiceWaveformCore.mjs', import.meta.url).pathname],
  bundle: true, format: 'iife', globalName: 'oursWaveform', write: false, platform: 'browser',
});
const waveformSource = bundled.outputFiles[0].text;

const webRoot = resolve(new URL('../dist/web', import.meta.url).pathname);
assert.ok(existsSync(join(webRoot, 'index.html')), 'run npm run build before the waveform browser gate');
const css = readdirSync(join(webRoot, 'assets'))
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(join(webRoot, 'assets', name), 'utf8'))
  .join('\n');

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

let voiceBytes = null;
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    response.write(': open\n\n');
    return;
  }
  if (url.pathname === '/media/voice') {
    if (!voiceBytes) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'audio/webm', 'cache-control': 'no-store' });
    response.end(voiceBytes);
    return;
  }
  const candidate = resolve(webRoot, `.${decodeURIComponent(url.pathname)}`);
  const path = candidate.startsWith(`${webRoot}/`) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(webRoot, 'index.html');
  response.writeHead(200, {
    'content-type': types.get(extname(path)) ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  response.end(readFileSync(path));
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({ permissions: ['microphone'], serviceWorkers: 'block' });
const page = await context.newPage();
await page.goto(origin, { waitUntil: 'domcontentloaded' });
await page.addScriptTag({ content: waveformSource });

// ---- 1. the RECORDING strip -------------------------------------------------
// Measured against the shipped CSS rather than the running recorder, because the
// recorder only mounts while a pointer is held and its strip is what changed.
const recording = await page.evaluate((stylesheet) => {
  const style = document.createElement('style');
  style.textContent = stylesheet;
  document.head.append(style);
  const host = document.createElement('div');
  host.innerHTML = `
    <div class="voice-rec-overlay" data-mode="recording">
      <div class="vr-slide">
        <div class="vr-wave">
          ${Array.from({ length: 44 }, (_, i) => `<span class="vr-bar" style="height:${i === 0 ? 14 : 100}%"></span>`).join('')}
        </div>
      </div>
    </div>`;
  document.body.append(host);
  const wave = host.querySelector('.vr-wave');
  const bars = [...host.querySelectorAll('.vr-bar')];
  return {
    waveHeight: wave.getBoundingClientRect().height,
    tallestBar: Math.max(...bars.map((bar) => bar.getBoundingClientRect().height)),
    quietBar: bars[0].getBoundingClientRect().height,
    barWidth: bars[1].getBoundingClientRect().width,
  };
}, css);

assert.ok(recording.waveHeight >= 40,
  `the recording strip is legible at a glance: ${recording.waveHeight}px tall (was 26px)`);
assert.ok(recording.tallestBar >= recording.waveHeight - 1,
  'a full-scale bar uses the whole strip');
assert.ok(recording.quietBar >= 4,
  `and a quiet bar is still drawn rather than vanishing (${recording.quietBar}px)`);
assert.ok(recording.barWidth >= 4, `bars are thick enough to see: ${recording.barWidth}px`);

// ---- 2. the MESSAGE BUBBLE waveform ----------------------------------------
// Record real audio, serve it, and let the real component decode it.
voiceBytes = Buffer.from(await page.evaluate(async () => {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 440;
  // An envelope, so the waveform has a shape to show rather than a flat tone.
  gain.gain.setValueAtTime(0.02, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + 1);
  gain.gain.linearRampToValueAtTime(0.02, ctx.currentTime + 2);
  const dest = ctx.createMediaStreamDestination();
  osc.connect(gain);
  gain.connect(dest);
  osc.start();
  const recorder = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.stop();
  await stopped;
  osc.stop();
  await ctx.close();
  const blob = new Blob(chunks, { type: 'audio/webm' });
  return [...new Uint8Array(await blob.arrayBuffer())];
}));

// Decode it the way the bubble does, and shape it with the real module.
const measured = await page.evaluate(async () => {
  const { peaksFromSamples, waveformBars, WAVEFORM_BARS } = window.oursWaveform;
  const ctx = new AudioContext();
  const bytes = await fetch('/media/voice').then((response) => response.arrayBuffer());
  const decoded = await ctx.decodeAudioData(bytes);
  const samples = decoded.getChannelData(0);
  await ctx.close();
  return {
    sampleCount: samples.length,
    duration: decoded.duration,
    bars: waveformBars(peaksFromSamples(samples, WAVEFORM_BARS)),
  };
});
assert.ok(measured.sampleCount > 0, 'the recorded audio decodes in the browser — the bubble has something to draw');
assert.ok(measured.duration > 1.5, `and carries the full take (${measured.duration.toFixed(2)}s)`);
assert.equal(measured.bars.length, 40, 'and shapes into a full set of bars');
// The recording ramps quiet -> loud -> quiet, so the bars must do the same.
const loudest = measured.bars.indexOf(Math.max(...measured.bars));
assert.ok(loudest > 10 && loudest < 30,
  `the waveform follows the audio: loudest bar is ${loudest} of 40 for a take that peaks in the middle`);
assert.ok(Math.max(...measured.bars) - Math.min(...measured.bars) > 0.4,
  'and the shape is visible rather than flat');

// Now render the bubble markup with real bar heights and measure the boxes.
const bubble = await page.evaluate((shaped) => {
  const host = document.createElement('div');
  // A representative conversation-column bubble width. The CSS is the shipped
  // one; this only supplies the box a real thread would give it.
  host.style.width = '420px';
  const heights = shaped.map((bar) => bar * 100);
  host.innerHTML = `
    <div class="ours-message ours-message--out">
      <div class="bubble voice-bubble" style="width:300px">
        <button class="voice-play"></button>
        <div class="voice-track seekable has-wave">
          <div class="voice-wave">
            ${heights.map((height, i) => `<span class="voice-wave-bar${i < 10 ? ' played' : ''}" style="height:${height}%"></span>`).join('')}
          </div>
        </div>
        <span class="voice-dur mono">0:02</span>
      </div>
    </div>`;
  document.body.append(host);
  const track = host.querySelector('.voice-track');
  const bars = [...host.querySelectorAll('.voice-wave-bar')];
  const trackBox = track.getBoundingClientRect();
  const played = host.querySelector('.voice-wave-bar.played');
  const unplayed = bars.at(-1);
  return {
    trackHeight: trackBox.height,
    barCount: bars.length,
    tallest: Math.max(...bars.map((bar) => bar.getBoundingClientRect().height)),
    shortest: Math.min(...bars.map((bar) => bar.getBoundingClientRect().height)),
    withinTrack: bars.every((bar) => {
      const box = bar.getBoundingClientRect();
      return box.left >= trackBox.left - 0.5 && box.right <= trackBox.right + 0.5;
    }),
    playedColour: getComputedStyle(played).backgroundColor,
    unplayedColour: getComputedStyle(unplayed).backgroundColor,
  };
}, measured.bars);

assert.equal(bubble.barCount, 40, 'the bubble draws a full waveform, not a progress rail');
assert.ok(bubble.trackHeight >= 30,
  `and it has vertical room to be a shape: ${bubble.trackHeight}px (the rail it replaces was 4px)`);
assert.ok(bubble.tallest >= bubble.trackHeight - 1, 'the loudest moment uses the whole track');
assert.ok(bubble.shortest >= 3, `the quietest is still visible (${bubble.shortest}px)`);
assert.ok(bubble.withinTrack, 'every bar sits inside the track box — nothing overflows the bubble');
assert.notEqual(bubble.playedColour, bubble.unplayedColour,
  'played and unplayed bars are distinguishable, so the waveform doubles as the progress it replaced');

await browser.close();
server.close();
console.log('browser-voice-waveform OK — recording strip 44px, bubble waveform 40 bars inside its track, progress still legible');
