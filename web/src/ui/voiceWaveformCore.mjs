// Waveform shaping, kept pure so the part that decides whether quiet speech is
// visible can be tested without a microphone or a browser.
//
// THE PROBLEM THIS SOLVES IS NOT "the bars are short". It is that a linear map
// from amplitude to height flatlines ordinary speech. Conversational level sits
// around 0.05–0.15 RMS against a full scale of 1.0, so a linear bar spends its
// life in the bottom tenth of the track and reads as a straight line no matter
// how tall the track is. Making the track taller alone multiplies the empty space
// above the bars, which is why the fix here is a curve and a normalisation rather
// than a pixel bump.

/** Bars in a message-bubble waveform. Enough to show shape, few enough to stay legible small. */
export const WAVEFORM_BARS = 40;

/** Bars kept in the live recording strip. */
export const LIVE_WAVEFORM_BARS = 44;

/**
 * Never let a bar vanish. A bar at zero reads as "the recorder is broken"; a
 * short one reads as "quiet", which is the truth during a pause.
 */
export const BAR_FLOOR = 0.14;

/**
 * Perceptual curve. Loudness is roughly a power law, so a square root spreads the
 * quiet end — where speech actually lives — across most of the track instead of
 * compressing it into the bottom. 0.5 is the plain square root; lower is more
 * aggressive.
 */
export const BAR_GAMMA = 0.5;

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Shape one already-normalised 0..1 level into a bar height fraction. */
export function barHeight(level, { floor = BAR_FLOOR, gamma = BAR_GAMMA } = {}) {
  const shaped = Math.pow(clamp01(Number.isFinite(level) ? level : 0), gamma);
  return floor + (1 - floor) * shaped;
}

/**
 * RMS per bucket over a mono sample array.
 *
 * RMS rather than peak: a single click would own a peak-based bar and make the
 * rest of the waveform look silent next to it.
 */
export function peaksFromSamples(samples, bars = WAVEFORM_BARS) {
  const count = Math.max(1, Math.floor(bars));
  const peaks = new Array(count).fill(0);
  if (!samples || samples.length === 0) return peaks;
  const per = samples.length / count;
  for (let bar = 0; bar < count; bar++) {
    const start = Math.floor(bar * per);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((bar + 1) * per)));
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    peaks[bar] = Math.sqrt(sum / (end - start));
  }
  return peaks;
}

/**
 * Scale a set of peaks to bar heights.
 *
 * NORMALISED AGAINST THE RECORDING'S OWN LOUDEST MOMENT, not against full scale:
 * a note recorded at arm's length and one recorded close up should both show
 * their shape. The alternative — absolute scaling — renders every quiet
 * recording as the same flat line, which is the reported bug.
 *
 * A recording with no signal at all normalises to the floor rather than to
 * garbage: dividing by a silent maximum is the one case that must not amplify.
 */
export function waveformBars(peaks, options = {}) {
  const { silenceFloor = 1e-4 } = options;
  const max = peaks.reduce((best, value) => (value > best ? value : best), 0);
  if (!(max > silenceFloor)) return peaks.map(() => BAR_FLOOR);
  return peaks.map((value) => barHeight(value / max, options));
}

/**
 * The live strip during recording has no future to normalise against, so it
 * tracks a decaying running maximum instead: loud passages set the reference and
 * it relaxes back so a quiet passage after a loud one still moves.
 */
export function createLiveWaveformScaler({ decay = 0.995, minReference = 0.02 } = {}) {
  let reference = minReference;
  return {
    /** Feed one RMS reading, get the bar height fraction to draw. */
    push(rms) {
      const value = Number.isFinite(rms) && rms > 0 ? rms : 0;
      reference = Math.max(minReference, reference * decay, value);
      return barHeight(value / reference);
    },
    get reference() { return reference; },
  };
}
