export const WAVEFORM_BARS: number;
export const LIVE_WAVEFORM_BARS: number;
export const BAR_FLOOR: number;
export const BAR_GAMMA: number;

export interface BarShapeOptions {
  floor?: number;
  gamma?: number;
  silenceFloor?: number;
}

export function barHeight(level: number, options?: BarShapeOptions): number;
export function peaksFromSamples(samples: ArrayLike<number> | null | undefined, bars?: number): number[];
export function waveformBars(peaks: readonly number[], options?: BarShapeOptions): number[];
export function createLiveWaveformScaler(options?: { decay?: number; minReference?: number }): {
  push(rms: number): number;
  readonly reference: number;
};
