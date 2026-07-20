import { describe, expect, it } from 'vitest';

import {
  advanceLocomotionPhase,
  damp,
  evaluateDirectionalGait,
  evaluateGrenade,
  evaluateLocomotionCycle,
  evaluateMelee,
  evaluateReload,
  evaluateSwap,
  evaluateWeaponReload,
  evaluateWeaponBob,
  normalizedTimer,
  saturate,
  smoothWindow,
  smootherstep01,
  smoothstep01,
  trianglePulse,
  type ActionPoseWeights,
} from './animationMath';

const evaluators = {
  reload: evaluateReload,
  swap: evaluateSwap,
  melee: evaluateMelee,
  grenade: evaluateGrenade,
};

const values = (weights: ActionPoseWeights): number[] => Object.values(weights);

describe('animation curve primitives', () => {
  it('saturates finite and non-finite input without producing NaN', () => {
    expect(saturate(-2)).toBe(0);
    expect(saturate(0.25)).toBe(0.25);
    expect(saturate(3)).toBe(1);
    expect(saturate(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(saturate(Number.POSITIVE_INFINITY)).toBe(1);
    expect(saturate(Number.NaN)).toBe(0);
  });

  it('damps independently of subdivision and handles neutral edge cases', () => {
    const oneStep = damp(0, 1, 8, 1 / 30);
    const twoSteps = damp(damp(0, 1, 8, 1 / 60), 1, 8, 1 / 60);
    expect(twoSteps).toBeCloseTo(oneStep, 12);
    expect(oneStep).toBeGreaterThan(0);
    expect(oneStep).toBeLessThan(1);
    expect(damp(0.4, 1, 0, 1)).toBe(0.4);
    expect(damp(Number.NaN, Number.NaN, Number.NaN, Number.NaN)).toBe(0);
    expect(Number.isFinite(damp(0, 1, Number.POSITIVE_INFINITY, 1))).toBe(true);
  });

  it('keeps smooth-step endpoints and monotonicity', () => {
    for (const curve of [smoothstep01, smootherstep01]) {
      expect(curve(-1)).toBe(0);
      expect(curve(0)).toBe(0);
      expect(curve(1)).toBe(1);
      expect(curve(2)).toBe(1);
      let previous = 0;
      for (let index = 1; index <= 100; index += 1) {
        const current = curve(index / 100);
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    }
  });

  it('creates a continuous pulse with exact endpoints and peak', () => {
    expect(trianglePulse(0.1, 0.1, 0.4, 0.8)).toBe(0);
    expect(trianglePulse(0.4, 0.1, 0.4, 0.8)).toBe(1);
    expect(trianglePulse(0.8, 0.1, 0.4, 0.8)).toBe(0);
    expect(trianglePulse(0.1 - 1e-6, 0.1, 0.4, 0.8)).toBeCloseTo(
      trianglePulse(0.1 + 1e-6, 0.1, 0.4, 0.8),
      8,
    );
    expect(trianglePulse(0.8 - 1e-6, 0.1, 0.4, 0.8)).toBeCloseTo(
      trianglePulse(0.8 + 1e-6, 0.1, 0.4, 0.8),
      8,
    );
    expect(trianglePulse(0.5, 0.4, 0.4, 0.8)).toBe(0);
  });

  it('keeps triangle pulses neutral for non-finite progress and boundaries in a normalized interval', () => {
    for (const progress of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(trianglePulse(progress, 0.1, 0.4, 0.8)).toBe(0);
    }

    const boundaries = [0.1, 0.4, 0.8];
    for (const invalid of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      for (let index = 0; index < boundaries.length; index += 1) {
        const candidate = [...boundaries];
        candidate[index] = invalid;
        expect(trianglePulse(0.4, candidate[0]!, candidate[1]!, candidate[2]!)).toBe(0);
      }
    }
  });

  it('rejects every collapsed, reversed or overlapping triangle interval', () => {
    for (const [start, peak, end] of [
      [0.4, 0.4, 0.8],
      [0.1, 0.8, 0.8],
      [0.8, 0.4, 0.1],
      [0.1, 0.9, 0.8],
    ]) {
      expect(trianglePulse(0.5, start!, peak!, end!)).toBe(0);
    }
  });

  it('creates a smooth held window with neutral endpoints', () => {
    expect(smoothWindow(0, 0, 0.2, 0.7, 1)).toBe(0);
    expect(smoothWindow(0.2, 0, 0.2, 0.7, 1)).toBe(1);
    expect(smoothWindow(0.45, 0, 0.2, 0.7, 1)).toBe(1);
    expect(smoothWindow(0.7, 0, 0.2, 0.7, 1)).toBe(1);
    expect(smoothWindow(1, 0, 0.2, 0.7, 1)).toBe(0);
    expect(smoothWindow(0.5, 0.4, 0.3, 0.7, 0.8)).toBe(0);
  });

  it('keeps smooth windows neutral for non-finite progress and boundaries in a normalized interval', () => {
    for (const progress of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(smoothWindow(progress, 0.1, 0.3, 0.7, 0.9)).toBe(0);
    }

    const boundaries = [0.1, 0.3, 0.7, 0.9];
    for (const invalid of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      for (let index = 0; index < boundaries.length; index += 1) {
        const candidate = [...boundaries];
        candidate[index] = invalid;
        expect(smoothWindow(
          0.5,
          candidate[0]!,
          candidate[1]!,
          candidate[2]!,
          candidate[3]!,
        )).toBe(0);
      }
    }
  });

  it('rejects invalid windows while allowing a zero-length hold at the shared join', () => {
    for (const [enterStart, enterEnd, exitStart, exitEnd] of [
      [0.2, 0.2, 0.7, 0.9],
      [0.1, 0.3, 0.8, 0.8],
      [0.1, 0.7, 0.6, 0.9],
      [0.9, 0.7, 0.3, 0.1],
    ]) {
      expect(smoothWindow(0.5, enterStart!, enterEnd!, exitStart!, exitEnd!)).toBe(0);
    }

    expect(smoothWindow(0.4, 0.1, 0.4, 0.4, 0.8)).toBe(1);
    expect(smoothWindow(0.4 - 1e-6, 0.1, 0.4, 0.4, 0.8)).toBeCloseTo(1, 8);
    expect(smoothWindow(0.4 + 1e-6, 0.1, 0.4, 0.4, 0.8)).toBeCloseTo(1, 8);
  });

  it('normalizes countdown timers and clamps overshoot', () => {
    expect(normalizedTimer(2, 2)).toBe(0);
    expect(normalizedTimer(1, 2)).toBe(0.5);
    expect(normalizedTimer(0, 2)).toBe(1);
    expect(normalizedTimer(3, 2)).toBe(0);
    expect(normalizedTimer(-1, 2)).toBe(1);
    expect(normalizedTimer(Number.NaN, 2)).toBe(0);
    expect(normalizedTimer(1, 0)).toBe(0);
  });
});

describe('action pose evaluators', () => {
  it.each(Object.entries(evaluators))('%s reuses an output object without changing its values', (_name, evaluate) => {
    const expected = evaluate(0.43);
    const out: ActionPoseWeights = { lower: -1, twist: -1, part: -1, hand: -1 };
    const result = evaluate(0.43, out);

    expect(result).toBe(out);
    expect(result).toEqual(expected);
  });

  it.each(Object.entries(evaluators))('%s has neutral endpoints and finite bounded output', (_name, evaluate) => {
    for (const progress of [-1, 0, 0.125, 0.33, 0.5, 0.75, 1, 2, Number.NaN]) {
      for (const weight of values(evaluate(progress))) {
        expect(Number.isFinite(weight)).toBe(true);
        expect(weight).toBeGreaterThanOrEqual(0);
        expect(weight).toBeLessThanOrEqual(1);
      }
    }
    expect(values(evaluate(0))).toEqual([0, 0, 0, 0]);
    expect(values(evaluate(1))).toEqual([0, 0, 0, 0]);
  });

  it.each(Object.entries(evaluators))('%s remains continuous across its timeline', (_name, evaluate) => {
    let previous = evaluate(0);
    for (let index = 1; index <= 1000; index += 1) {
      const current = evaluate(index / 1000);
      for (const key of Object.keys(current) as Array<keyof ActionPoseWeights>) {
        expect(Math.abs(current[key] - previous[key])).toBeLessThan(0.02);
      }
      previous = current;
    }
  });

  it.each(Object.entries(evaluators))('%s contains an expressive non-neutral middle pose', (_name, evaluate) => {
    let peak = 0;
    for (let index = 1; index < 100; index += 1) {
      peak = Math.max(peak, ...values(evaluate(index / 100)));
    }
    expect(peak).toBeGreaterThan(0.95);
  });
});

describe('weapon-specific reload animation', () => {
  const reloadValues = (progress: number): number[] => {
    const pose = evaluateWeaponReload(progress, 'sidearm');
    return [
      ...values(pose.action),
      pose.magazineOffsetX,
      pose.magazineOffsetY,
      pose.magazineOffsetZ,
      pose.magazineRoll,
      pose.slideOffsetZ,
    ];
  };

  it('stages the sidearm magazine before the slide and returns exactly to bind pose', () => {
    expect(reloadValues(0).every((value) => value === 0)).toBe(true);
    expect(reloadValues(1).every((value) => value === 0)).toBe(true);

    const magazinePhase = evaluateWeaponReload(0.4, 'sidearm');
    expect(magazinePhase.magazineOffsetY).toBeCloseTo(-0.29, 6);
    expect(magazinePhase.slideOffsetZ).toBe(0);

    const rackPhase = evaluateWeaponReload(0.8, 'sidearm');
    expect(rackPhase.magazineOffsetY).toBe(0);
    expect(rackPhase.slideOffsetZ).toBeCloseTo(0.085, 6);
  });

  it('has no discontinuity or exaggerated longitudinal magazine kick', () => {
    let previous = reloadValues(0);
    let maximumSlideTravel = 0;
    for (let index = 1; index <= 2000; index += 1) {
      const pose = evaluateWeaponReload(index / 2000, 'sidearm');
      const current = reloadValues(index / 2000);
      current.forEach((value, valueIndex) => {
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.abs(value - (previous[valueIndex] ?? 0))).toBeLessThan(0.006);
      });
      expect(pose.magazineOffsetZ).toBe(0);
      maximumSlideTravel = Math.max(maximumSlideTravel, pose.slideOffsetZ);
      previous = current;
    }
    expect(maximumSlideTravel).toBeLessThanOrEqual(0.085);
  });

  it('keeps the established long-gun mechanism trajectory unchanged', () => {
    const generic = evaluateReload(0.49);
    const rifle = evaluateWeaponReload(0.49, 'battle-rifle');
    expect(rifle.action).toEqual(generic);
    expect(rifle.magazineOffsetY).toBeCloseTo(-generic.part * 0.38, 8);
    expect(rifle.slideOffsetZ).toBe(0);
  });

  it('reuses both reload output levels without retaining values from the previous weapon', () => {
    const out = {
      action: { lower: -1, twist: -1, part: -1, hand: -1 },
      magazineOffsetX: -1,
      magazineOffsetY: -1,
      magazineOffsetZ: -1,
      magazineRoll: -1,
      slideOffsetZ: -1,
    };
    const action = out.action;
    const expectedSidearm = evaluateWeaponReload(0.8, 'sidearm');

    expect(evaluateWeaponReload(0.8, 'sidearm', out)).toBe(out);
    expect(out.action).toBe(action);
    expect(out).toEqual(expectedSidearm);

    const expectedRifle = evaluateWeaponReload(0.49, 'battle-rifle');
    expect(evaluateWeaponReload(0.49, 'battle-rifle', out)).toBe(out);
    expect(out.action).toBe(action);
    expect(out).toEqual(expectedRifle);
  });
});

describe('velocity-driven locomotion', () => {
  it('ties gait phase to actual distance and remains frame-rate independent', () => {
    const oneStep = evaluateLocomotionCycle(4.8, 4.8, 0, 1);
    const halfStep = evaluateLocomotionCycle(4.8, 4.8, 0, 0.5);
    expect(oneStep.phaseDelta).toBeCloseTo(halfStep.phaseDelta * 2, 12);
    expect(oneStep.cyclesPerSecond).toBeCloseTo(4.8 / oneStep.strideLength, 12);
    expect(oneStep.cyclesPerSecond).toBeLessThan(2.2);
    expect(evaluateLocomotionCycle(1.5, 1.5, 0, 1 / 60).moveBlend).toBe(1);
  });

  it('reverses a backward gait without changing its physical cadence', () => {
    const forward = evaluateLocomotionCycle(3.2, 3.2, 0, 1 / 60);
    const backward = evaluateLocomotionCycle(3.2, -3.2, 0, 1 / 60);
    expect(backward.phaseDelta).toBeCloseTo(-forward.phaseDelta, 12);
    expect(backward.forwardBlend).toBe(-1);
    expect(forward.forwardBlend).toBe(1);
  });

  it('wraps phase cleanly in either direction', () => {
    expect(advanceLocomotionPhase(Math.PI * 2 - 0.1, 0.2)).toBeCloseTo(0.1, 12);
    expect(advanceLocomotionPhase(0.1, -0.2)).toBeCloseTo(Math.PI * 2 - 0.1, 12);
    expect(advanceLocomotionPhase(Number.NaN, Number.NaN)).toBe(0);
  });

  it('uses sagittal leg swing forward and lateral articulation while strafing', () => {
    const base = { moveBlend: 1, runBlend: 0.6 };
    const forward = evaluateDirectionalGait(Math.PI / 2, {
      ...base,
      forwardBlend: 1,
      strafeBlend: 0,
    });
    const strafe = evaluateDirectionalGait(Math.PI / 2, {
      ...base,
      forwardBlend: 0,
      strafeBlend: 1,
    });
    expect(Math.abs(forward.leftHipPitch)).toBeGreaterThan(Math.abs(strafe.leftHipPitch) * 3);
    expect(Math.abs(forward.leftHipRoll)).toBe(0);
    expect(Math.abs(strafe.rightHipRoll)).toBeGreaterThan(0.1);
    expect(strafe.torsoRoll).toBeLessThan(0);
  });

  it('keeps weapon movement restrained and strongly steadies it while aiming', () => {
    const locomotion = evaluateLocomotionCycle(5.4, 5.4, 0, 1 / 60);
    const hip = evaluateWeaponBob(Math.PI / 2, locomotion, 1, 0);
    const aimed = evaluateWeaponBob(Math.PI / 2, locomotion, 1, 1);
    expect(Math.abs(hip.x)).toBeLessThan(0.015);
    expect(Math.abs(hip.y)).toBeLessThan(0.012);
    expect(Math.abs(aimed.x)).toBeLessThan(Math.abs(hip.x) * 0.1);
    expect(Object.values(evaluateWeaponBob(Number.NaN, locomotion, Number.NaN, Number.NaN)).every(Number.isFinite)).toBe(true);
  });
});
