// WHETHER QUIET SPEECH MOVES.
//
// The owner asked for bigger waveforms. Height alone would not have delivered
// it: conversational speech sits around 0.05–0.15 RMS against a full scale of
// 1.0, so a linear bar lives in the bottom tenth of whatever track it is given
// and reads as a flat line at any size. These assertions are about the shaping,
// which is the half that decides legibility; the pixel heights are asserted in
// the browser gate.

import assert from 'node:assert/strict';
import {
  BAR_FLOOR,
  barHeight,
  createLiveWaveformScaler,
  peaksFromSamples,
  WAVEFORM_BARS,
  waveformBars,
} from '../src/ui/voiceWaveformCore.mjs';

// ---- bucketing -------------------------------------------------------------
const silence = new Float32Array(4800);
assert.equal(peaksFromSamples(silence, 40).length, 40, 'the requested number of buckets comes back');
assert.equal(peaksFromSamples(silence, 40).every((peak) => peak === 0), true, 'silence measures zero');
assert.equal(peaksFromSamples(new Float32Array(0), 40).length, 40, 'an empty recording still yields a full set of bars');
assert.equal(peaksFromSamples(null, 12).length, 12, 'and so does no recording at all, rather than throwing');

// RMS, not peak: one click must not flatten everything around it.
const clicky = new Float32Array(4000);
for (let i = 0; i < clicky.length; i++) clicky[i] = 0.2;
clicky[10] = 1;
const clickyPeaks = peaksFromSamples(clicky, 4);
const spread = Math.max(...clickyPeaks) / Math.min(...clickyPeaks);
assert.ok(spread < 1.6,
  `a single spike must not own the waveform: loudest bucket is only ${spread.toFixed(2)}x the quietest`);

// ---- THE REPORTED DEFECT: quiet input flatlining ---------------------------
// A quiet recording that varies. Under the old linear map (level = rms * 3.2,
// floored at 0.06) every one of these would have drawn between 6% and 26% of the
// track — visually a straight line.
// Syllables and pauses, at conversational level: an envelope running between
// 0.005 and 0.09 RMS. That dynamic range is the point — a waveform exists to
// show it, and the old scaling could not.
const quiet = new Float32Array(48_000);
for (let i = 0; i < quiet.length; i++) {
  const syllable = Math.max(0, Math.sin((i / quiet.length) * Math.PI * 7));
  quiet[i] = Math.sin(i / 8) * (0.005 + 0.085 * syllable * syllable);
}
const quietPeaks = peaksFromSamples(quiet, WAVEFORM_BARS);
const quietBars = waveformBars(quietPeaks);
const quietRange = Math.max(...quietBars) - Math.min(...quietBars);
assert.ok(Math.max(...quietBars) > 0.85,
  `a quiet recording still reaches the top of its track (peak bar ${Math.max(...quietBars).toFixed(2)})`);
assert.ok(quietRange > 0.5,
  `AND IT VARIES rather than flatlining: range ${quietRange.toFixed(2)} of the track`);

// The map this replaced, run on the same samples, so the improvement is a
// measurement in this file rather than a claim in a commit message.
const LEGACY = (rms: number) => Math.max(0.06, Math.min(1, rms * 3.2));
const legacyBars = quietPeaks.map(LEGACY);
const legacyRange = Math.max(...legacyBars) - Math.min(...legacyBars);
assert.ok(legacyRange < 0.25,
  `the old linear scaling drew this same speech within ${legacyRange.toFixed(2)} of the track — a flat line, which is the report`);
assert.ok(quietRange > legacyRange * 2,
  `and the new shaping spreads it over ${(quietRange / legacyRange).toFixed(1)}x as much of the track`);

// The same shape recorded loudly must look the same. Normalising against the
// recording's own maximum is what makes distance from the microphone irrelevant.
const loud = new Float32Array(quiet.length);
for (let i = 0; i < loud.length; i++) loud[i] = quiet[i] * 12;
const loudBars = waveformBars(peaksFromSamples(loud, WAVEFORM_BARS));
for (let i = 0; i < loudBars.length; i++) {
  assert.ok(Math.abs(loudBars[i] - quietBars[i]) < 0.02,
    `bar ${i} is the same shape at 12x the level (${quietBars[i].toFixed(3)} vs ${loudBars[i].toFixed(3)})`);
}
assert.ok(Math.max(...loudBars) <= 1.0001, 'and nothing clips past the top of the track');

// ---- silence, which must not be amplified into noise -----------------------
const silentBars = waveformBars(peaksFromSamples(silence, WAVEFORM_BARS));
assert.equal(silentBars.every((bar) => bar === BAR_FLOOR), true,
  'a silent recording renders the floor, not garbage from dividing by a silent maximum');
assert.ok(BAR_FLOOR > 0.1, 'and the floor is visible — a zero-height bar reads as a broken recorder, not as a pause');

// ---- shaping ---------------------------------------------------------------
assert.equal(barHeight(0), BAR_FLOOR, 'no signal draws the floor');
assert.ok(barHeight(1) > 0.999, 'full scale draws the full track');
assert.ok(barHeight(0.1) > 0.35,
  `a tenth of full scale must be plainly visible, not a tenth of the track (got ${barHeight(0.1).toFixed(2)})`);
assert.ok(barHeight(0.5) > barHeight(0.25) && barHeight(0.25) > barHeight(0.1), 'and the curve stays monotonic');
assert.equal(barHeight(Number.NaN), BAR_FLOOR, 'a NaN reading draws the floor rather than disappearing');
assert.equal(barHeight(-5), BAR_FLOOR, 'and so does a negative one');

// ---- the live strip, which has no future to normalise against --------------
const scaler = createLiveWaveformScaler();
let loudRun = 0;
for (let i = 0; i < 40; i++) loudRun = scaler.push(0.3);
assert.ok(loudRun > 0.9, 'sustained loud input settles at the top of the strip');
let quietAfterLoud = 0;
for (let i = 0; i < 400; i++) quietAfterLoud = scaler.push(0.02);
assert.ok(quietAfterLoud > 0.3,
  `a quiet passage after a loud one still moves (${quietAfterLoud.toFixed(2)}) — the reference decays instead of pinning to the loudest moment of the take`);
assert.equal(scaler.push(0), BAR_FLOOR, 'and a gap draws the floor');

console.log('voice-waveform OK — quiet speech reaches the track, loud does not clip, silence stays silent');
