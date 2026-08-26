export interface SwipeSample { x: number; time: number }

export const SWIPE_ACTIVATE_PX = 10;
export const SWIPE_DISTANCE_PX = 56;
export const SWIPE_FLICK_MIN_PX = 18;
export const SWIPE_FLICK_VELOCITY = 650;

export function classifyReplyIntent(dx: number, dy: number): 'pending' | 'drag' | 'reject' {
  if (Math.abs(dx) < SWIPE_ACTIVATE_PX && Math.abs(dy) < SWIPE_ACTIVATE_PX) return 'pending';
  return Math.abs(dx) > Math.abs(dy) && dx > 0 ? 'drag' : 'reject';
}

export function replyReleaseVelocity(samples: SwipeSample[]): number {
  const last = samples.at(-1);
  const previous = last
    ? samples.slice(0, -1).reverse().find((sample) => sample.x !== last.x && last.time - sample.time <= 100)
    : undefined;
  return previous && last && last.time > previous.time
    ? ((last.x - previous.x) / (last.time - previous.time)) * 1_000
    : 0;
}

export function shouldCommitReply(distance: number, samples: SwipeSample[]): boolean {
  const velocity = replyReleaseVelocity(samples);
  return velocity >= 0
    && (distance >= SWIPE_DISTANCE_PX
      || (distance >= SWIPE_FLICK_MIN_PX && velocity >= SWIPE_FLICK_VELOCITY));
}
