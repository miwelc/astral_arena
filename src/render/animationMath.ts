/**
 * Pure, frame-rate independent curves shared by first- and third-person
 * animation. Every evaluator accepts normalized action progress and returns
 * additive pose weights; consequently all weights return to zero at both
 * endpoints and can be layered safely over the bind pose.
 */

export interface ActionPoseWeights {
  /** Lowers or compresses the weapon/body before recovering. */
  lower: number;
  /** Rolls the upper body or weapon away from its neutral orientation. */
  twist: number;
  /** Drives the action-specific part: magazine, weapon arc, strike or throw. */
  part: number;
  /** Releases/repositions the support hand while the action is active. */
  hand: number;
}

/** Clamps a number to [0, 1]. NaN is treated as the neutral value, zero. */
export const saturate = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
};

/**
 * Exponential damping expressed in seconds. Unlike a linear lerp, applying
 * this twice with half the delta gives the same result as one full step.
 */
export const damp = (current: number, target: number, lambda: number, delta: number): number => {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeTarget = Number.isFinite(target) ? target : safeCurrent;
  if (lambda <= 0 || delta <= 0 || Number.isNaN(lambda) || Number.isNaN(delta)) return safeCurrent;
  if (!Number.isFinite(lambda) || !Number.isFinite(delta)) return safeTarget;
  return safeTarget + (safeCurrent - safeTarget) * Math.exp(-lambda * delta);
};

/** Cubic ease with zero velocity at zero and one. */
export const smoothstep01 = (value: number): number => {
  const progress = saturate(value);
  return progress * progress * (3 - 2 * progress);
};

/** Quintic ease with zero velocity and acceleration at zero and one. */
export const smootherstep01 = (value: number): number => {
  const progress = saturate(value);
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10);
};

/**
 * Smooth pulse that rises from zero at `start`, reaches one at `peak`, and
 * returns to zero at `end`. Invalid or collapsed intervals are neutral.
 */
export const trianglePulse = (progress: number, start: number, peak: number, end: number): number => {
  if (![start, peak, end].every(Number.isFinite) || !(start < peak && peak < end)) return 0;
  const value = saturate(progress);
  if (value <= start || value >= end) return 0;
  if (value === peak) return 1;
  if (value < peak) return smootherstep01((value - start) / (peak - start));
  return 1 - smootherstep01((value - peak) / (end - peak));
};

/**
 * Converts a countdown timer into normalized action progress: duration maps
 * to zero and no remaining time maps to one.
 */
export const normalizedTimer = (remaining: number, duration: number): number => {
  if (Number.isNaN(remaining) || !Number.isFinite(duration) || duration <= 0) return 0;
  if (remaining === Number.POSITIVE_INFINITY) return 0;
  if (remaining === Number.NEGATIVE_INFINITY) return 1;
  return saturate(1 - remaining / duration);
};

/** Magazine/energy-cell manipulation with a long support-hand release. */
export const evaluateReload = (progress: number): ActionPoseWeights => ({
  lower: trianglePulse(progress, 0, 0.24, 1),
  twist: trianglePulse(progress, 0.04, 0.31, 0.94),
  part: trianglePulse(progress, 0.2, 0.49, 0.8),
  hand: trianglePulse(progress, 0.09, 0.3, 0.89),
});

/** Fast down/up weapon swap; `part` peaks while the weapon is concealed. */
export const evaluateSwap = (progress: number): ActionPoseWeights => ({
  lower: trianglePulse(progress, 0, 0.48, 1),
  twist: trianglePulse(progress, 0.04, 0.42, 0.96),
  part: trianglePulse(progress, 0.16, 0.5, 0.84),
  hand: trianglePulse(progress, 0.07, 0.37, 0.91),
});

/** Short wind-up and decisive forward strike, followed by a longer recovery. */
export const evaluateMelee = (progress: number): ActionPoseWeights => ({
  lower: trianglePulse(progress, 0, 0.2, 0.7),
  twist: trianglePulse(progress, 0.04, 0.32, 0.92),
  part: trianglePulse(progress, 0.18, 0.38, 0.64),
  hand: trianglePulse(progress, 0, 0.34, 1),
});

/** Support-hand release and throw impulse with enough time for follow-through. */
export const evaluateGrenade = (progress: number): ActionPoseWeights => ({
  lower: trianglePulse(progress, 0, 0.27, 1),
  twist: trianglePulse(progress, 0.06, 0.36, 0.93),
  part: trianglePulse(progress, 0.2, 0.4, 0.68),
  hand: trianglePulse(progress, 0.04, 0.29, 0.76),
});
