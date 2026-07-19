import type { WeaponId } from '../game/types';

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

/**
 * Root-space mechanism offsets for a reload. Keeping these values in weapon
 * space is important for imported models: their authored node transforms can
 * otherwise rotate and amplify a small magazine movement into a large jump.
 */
export interface WeaponReloadPose {
  action: ActionPoseWeights;
  magazineOffsetX: number;
  magazineOffsetY: number;
  magazineOffsetZ: number;
  magazineRoll: number;
  slideOffsetZ: number;
}

/** Direction-aware locomotion values shared by the character and viewmodel. */
export interface LocomotionCycle {
  /** Visual transition from idle to moving. */
  moveBlend: number;
  /** Walk-to-run transition derived from actual world velocity. */
  runBlend: number;
  /** Signed, normalized velocity along the direction the character is facing. */
  forwardBlend: number;
  /** Signed, normalized velocity across the direction the character is facing. */
  strafeBlend: number;
  /** World metres covered by one complete left/right gait cycle. */
  strideLength: number;
  /** Complete gait cycles per second. Useful for footsteps and camera motion. */
  cyclesPerSecond: number;
  /** Frame-rate-independent phase increment, expressed in radians. */
  phaseDelta: number;
}

/** A lower-body pose in radians. It deliberately exposes both pitch and roll. */
export interface DirectionalGaitPose {
  leftHipPitch: number;
  rightHipPitch: number;
  leftHipRoll: number;
  rightHipRoll: number;
  leftKnee: number;
  rightKnee: number;
  leftFootPitch: number;
  rightFootPitch: number;
  pelvisRoll: number;
  torsoPitch: number;
  torsoRoll: number;
}

/** Small first-person offsets, kept separate from recoil and authored actions. */
export interface WeaponBobPose {
  x: number;
  y: number;
  pitch: number;
  roll: number;
}

const TAU = Math.PI * 2;

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
  if (!Number.isFinite(start) || !Number.isFinite(peak) || !Number.isFinite(end) || !(start < peak && peak < end)) return 0;
  const value = saturate(progress);
  if (value <= start || value >= end) return 0;
  if (value === peak) return 1;
  if (value < peak) return smootherstep01((value - start) / (peak - start));
  return 1 - smootherstep01((value - peak) / (end - peak));
};

/** Smooth attack, optional hold, and smooth release with stationary joins. */
export const smoothWindow = (
  progress: number,
  enterStart: number,
  enterEnd: number,
  exitStart: number,
  exitEnd: number,
): number => {
  if (
    !Number.isFinite(enterStart)
    || !Number.isFinite(enterEnd)
    || !Number.isFinite(exitStart)
    || !Number.isFinite(exitEnd)
    || !(enterStart < enterEnd && enterEnd <= exitStart && exitStart < exitEnd)
  ) return 0;
  const value = saturate(progress);
  if (value <= enterStart || value >= exitEnd) return 0;
  if (value < enterEnd) return smootherstep01((value - enterStart) / (enterEnd - enterStart));
  if (value <= exitStart) return 1;
  return 1 - smootherstep01((value - exitStart) / (exitEnd - exitStart));
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

/**
 * Produces a gait clock from metres travelled instead of elapsed time. This is
 * what keeps the feet visually planted when movement speeds are tuned: a full
 * cycle covers roughly 1.55 m while walking and 2.8 m while running.
 */
export const evaluateLocomotionCycle = (
  horizontalSpeed: number,
  forwardSpeed: number,
  strafeSpeed: number,
  delta: number,
  out?: LocomotionCycle,
): LocomotionCycle => {
  const speed = Number.isFinite(horizontalSpeed) ? Math.max(0, horizontalSpeed) : 0;
  const safeDelta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
  const safeForward = Number.isFinite(forwardSpeed) ? forwardSpeed : 0;
  const safeStrafe = Number.isFinite(strafeSpeed) ? strafeSpeed : 0;
  // Leg articulation should be fully established at an ordinary walking pace;
  // speed itself already controls the cycle frequency.
  const moveBlend = smootherstep01((speed - 0.08) / 1.35);
  const runBlend = smootherstep01((speed - 2.35) / 3.05);
  const strideLength = 1.55 + (2.8 - 1.55) * runBlend;
  const cyclesPerSecond = speed / strideLength;
  const inverseSpeed = speed > 0.001 ? 1 / speed : 0;
  const forwardBlend = Math.max(-1, Math.min(1, safeForward * inverseSpeed));
  const strafeBlend = Math.max(-1, Math.min(1, safeStrafe * inverseSpeed));
  // Walking backwards reverses the gait, but diagonal strafing does not cause
  // the phase direction to flicker as the dominant input axis changes.
  const phaseDirection = safeForward < -Math.abs(safeStrafe) * 0.45 ? -1 : 1;

  const result = out ?? {
    moveBlend: 0,
    runBlend: 0,
    forwardBlend: 0,
    strafeBlend: 0,
    strideLength: 0,
    cyclesPerSecond: 0,
    phaseDelta: 0,
  };
  result.moveBlend = moveBlend;
  result.runBlend = runBlend;
  result.forwardBlend = forwardBlend;
  result.strafeBlend = strafeBlend;
  result.strideLength = strideLength;
  result.cyclesPerSecond = cyclesPerSecond;
  result.phaseDelta = cyclesPerSecond * safeDelta * TAU * phaseDirection;
  return result;
};

/** Keeps a continuously accumulated locomotion phase numerically well behaved. */
export const advanceLocomotionPhase = (phase: number, phaseDelta: number): number => {
  const safePhase = Number.isFinite(phase) ? phase : 0;
  const safeDelta = Number.isFinite(phaseDelta) ? phaseDelta : 0;
  const wrapped = (safePhase + safeDelta) % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
};

/**
 * Builds distinct forward/backward and lateral stepping poses. Forward motion
 * primarily swings the thighs in pitch. Strafing shortens that swing and uses
 * hip roll plus alternating knee compression, avoiding the old moon-walk look.
 */
export const evaluateDirectionalGait = (
  phase: number,
  locomotion: Pick<LocomotionCycle, 'moveBlend' | 'runBlend' | 'forwardBlend' | 'strafeBlend'>,
  out?: DirectionalGaitPose,
): DirectionalGaitPose => {
  const safePhase = Number.isFinite(phase) ? phase : 0;
  const move = saturate(locomotion.moveBlend);
  const run = saturate(locomotion.runBlend);
  const forward = Math.max(-1, Math.min(1, Number.isFinite(locomotion.forwardBlend) ? locomotion.forwardBlend : 0));
  const strafe = Math.max(-1, Math.min(1, Number.isFinite(locomotion.strafeBlend) ? locomotion.strafeBlend : 0));
  const directionTotal = Math.abs(forward) + Math.abs(strafe);
  const forwardWeight = directionTotal > 0.001 ? Math.abs(forward) / directionTotal : 1;
  const strafeWeight = directionTotal > 0.001 ? Math.abs(strafe) / directionTotal : 0;
  const backwardScale = forward < -0.05 ? 0.78 : 1;
  const strafeSign = strafe < 0 ? -1 : 1;
  const cycle = Math.sin(safePhase);
  const opposite = -cycle;
  const forwardAmplitude = (0.3 + run * 0.33) * move * forwardWeight * backwardScale;
  const lateralPitchAmplitude = (0.055 + run * 0.035) * move * strafeWeight;
  const lateralRollAmplitude = (0.12 + run * 0.11) * move * strafeWeight;

  const leftHipPitch = cycle * forwardAmplitude + cycle * lateralPitchAmplitude;
  const rightHipPitch = opposite * forwardAmplitude + opposite * lateralPitchAmplitude;
  const leftHipRoll = strafeSign
    * (0.035 + Math.max(0, -cycle) * lateralRollAmplitude)
    * strafeWeight
    * move;
  const rightHipRoll = strafeSign
    * (0.035 + Math.max(0, cycle) * lateralRollAmplitude)
    * strafeWeight
    * move;

  const recovery = (0.34 + run * 0.34) * move;
  const lateralCompression = (0.18 + run * 0.2) * move * strafeWeight;
  const leftKnee = Math.max(0, -cycle) * recovery * forwardWeight
    + Math.max(0, cycle * strafeSign) * lateralCompression;
  const rightKnee = Math.max(0, cycle) * recovery * forwardWeight
    + Math.max(0, -cycle * strafeSign) * lateralCompression;

  const result = out ?? {
    leftHipPitch: 0,
    rightHipPitch: 0,
    leftHipRoll: 0,
    rightHipRoll: 0,
    leftKnee: 0,
    rightKnee: 0,
    leftFootPitch: 0,
    rightFootPitch: 0,
    pelvisRoll: 0,
    torsoPitch: 0,
    torsoRoll: 0,
  };
  result.leftHipPitch = leftHipPitch;
  result.rightHipPitch = rightHipPitch;
  result.leftHipRoll = leftHipRoll;
  result.rightHipRoll = rightHipRoll;
  result.leftKnee = leftKnee;
  result.rightKnee = rightKnee;
  result.leftFootPitch = -leftHipPitch + leftKnee * 0.76;
  result.rightFootPitch = -rightHipPitch + rightKnee * 0.76;
  result.pelvisRoll = -strafe * (0.045 + run * 0.025) * move + Math.cos(safePhase) * 0.012 * move;
  result.torsoPitch = -forward * (0.038 + run * 0.035) * move;
  result.torsoRoll = -strafe * (0.065 + run * 0.035) * move;
  return result;
};

/**
 * Restrained viewmodel motion: aiming damps it almost completely and lateral
 * movement favours side-to-side sway instead of a rapid vertical shake.
 */
export const evaluateWeaponBob = (
  phase: number,
  locomotion: Pick<LocomotionCycle, 'moveBlend' | 'runBlend' | 'forwardBlend' | 'strafeBlend'>,
  groundBlend: number,
  aimBlend: number,
  out?: WeaponBobPose,
): WeaponBobPose => {
  const safePhase = Number.isFinite(phase) ? phase : 0;
  const move = saturate(locomotion.moveBlend) * saturate(groundBlend);
  const run = saturate(locomotion.runBlend);
  const steadying = 1 - saturate(aimBlend) * 0.92;
  const forward = Math.abs(Number.isFinite(locomotion.forwardBlend) ? locomotion.forwardBlend : 0);
  const strafe = Math.abs(Number.isFinite(locomotion.strafeBlend) ? locomotion.strafeBlend : 0);
  const xAmplitude = 0.0065 + run * 0.0045 + strafe * 0.003;
  const yAmplitude = 0.0055 + run * 0.0035 + forward * 0.0015;
  const horizontal = Math.sin(safePhase);
  const vertical = 0.5 - 0.5 * Math.cos(safePhase * 2);

  const result = out ?? { x: 0, y: 0, pitch: 0, roll: 0 };
  result.x = horizontal * xAmplitude * move * steadying;
  result.y = vertical * yAmplitude * move * steadying;
  result.pitch = vertical * (0.004 + run * 0.004) * move * steadying;
  result.roll = -horizontal * (0.005 + strafe * 0.004) * move * steadying;
  return result;
};

/** Magazine/energy-cell manipulation with a long support-hand release. */
export const evaluateReload = (progress: number): ActionPoseWeights => ({
  lower: trianglePulse(progress, 0, 0.24, 1),
  twist: trianglePulse(progress, 0.04, 0.31, 0.94),
  part: trianglePulse(progress, 0.2, 0.49, 0.8),
  hand: trianglePulse(progress, 0.09, 0.3, 0.89),
});

/**
 * A pistol reload is deliberately staged instead of reusing the long-gun
 * pulse. The weapon settles first, the magazine clears and seats, then the
 * slide is racked before the whole pose recovers. All joins use quintic curves
 * so neither the weapon nor a mechanism part can snap between phases.
 */
export const evaluateWeaponReload = (
  progress: number,
  weaponId: WeaponId | null,
): WeaponReloadPose => {
  if (weaponId !== 'sidearm') {
    const action = evaluateReload(progress);
    return {
      action,
      magazineOffsetX: action.part > 0 ? -action.part * 0.06 : 0,
      magazineOffsetY: action.part > 0 ? -action.part * 0.38 : 0,
      magazineOffsetZ: 0,
      magazineRoll: action.part * 0.18,
      slideOffsetZ: 0,
    };
  }

  const magazineDrop = smoothWindow(progress, 0.14, 0.34, 0.47, 0.68);
  const magazineSweep = trianglePulse(progress, 0.2, 0.43, 0.67);
  const slideRack = smoothWindow(progress, 0.7, 0.79, 0.81, 0.92);
  const action: ActionPoseWeights = {
    lower: smoothWindow(progress, 0, 0.2, 0.82, 1),
    twist: smoothWindow(progress, 0.04, 0.24, 0.8, 0.97),
    part: magazineDrop,
    hand: smoothWindow(progress, 0.08, 0.27, 0.76, 0.95),
  };

  return {
    action,
    // The magazine follows the grip axis. In particular, it never receives a
    // positive Z kick toward the camera, which was the conspicuous old jump.
    magazineOffsetX: magazineSweep > 0 ? -magazineSweep * 0.035 : 0,
    magazineOffsetY: magazineDrop > 0 ? -magazineDrop * 0.29 : 0,
    magazineOffsetZ: 0,
    magazineRoll: magazineSweep * 0.1,
    slideOffsetZ: slideRack * 0.085,
  };
};

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
