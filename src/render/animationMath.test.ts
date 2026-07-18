import { describe, expect, it } from 'vitest';

import {
  damp,
  evaluateGrenade,
  evaluateMelee,
  evaluateReload,
  evaluateSwap,
  normalizedTimer,
  saturate,
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
