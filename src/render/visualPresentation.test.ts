import { describe, expect, it } from 'vitest';
import {
  computeGroundTextureRepeat,
  computeSurfaceUvTransform,
  evaluateExplosionVisual,
  evaluateSurfaceTint,
} from './visualPresentation';

describe('visual presentation helpers', () => {
  it('keeps ground texels at a stable scale instead of forcing small arenas to repeat excessively', () => {
    expect(computeGroundTextureRepeat(64, 48)).toEqual({ x: 4, y: 3.5 });
    expect(computeGroundTextureRepeat(320, 240)).toEqual({ x: 9, y: 9 });
  });

  it('gives equally sized surfaces deterministic but distinct UV offsets', () => {
    const repeat = computeGroundTextureRepeat(96, 72);
    const first = computeSurfaceUvTransform(12, 7, repeat, 41);
    const same = computeSurfaceUvTransform(12, 7, repeat, 41);
    const other = computeSurfaceUvTransform(12, 7, repeat, 42);

    expect(first).toEqual(same);
    expect(first.offsetU).not.toBe(other.offsetU);
    expect(first.offsetV).not.toBe(other.offsetV);
    expect(first.scaleU * repeat.x).toBeGreaterThan(0.6);
    expect(first.scaleU * repeat.x).toBeLessThan(1.1);
  });

  it('adds bounded broad-scale colour variation across a surface', () => {
    const samples = [
      evaluateSurfaceTint(-22, 8, 7),
      evaluateSurfaceTint(0, 0, 7),
      evaluateSurfaceTint(31, -14, 7),
    ];

    expect(new Set(samples.map((sample) => sample.g.toFixed(4))).size).toBeGreaterThan(1);
    for (const sample of samples) {
      expect(sample.r).toBeGreaterThanOrEqual(0.88);
      expect(sample.g).toBeLessThanOrEqual(1.1);
      expect(sample.b).toBeGreaterThanOrEqual(0.86);
    }
  });

  it('front-loads explosion light while smoke blooms after the flash', () => {
    const initial = evaluateExplosionVisual(0);
    const middle = evaluateExplosionVisual(0.38);
    const end = evaluateExplosionVisual(1);

    expect(initial.lightIntensity).toBeGreaterThan(60);
    expect(middle.lightIntensity).toBeLessThan(initial.lightIntensity);
    expect(middle.smokeOpacity).toBeGreaterThan(initial.smokeOpacity);
    expect(end.smokeOpacity).toBe(0);
    expect(end.sparkOpacity).toBe(0);
    expect(end.shockScale).toBeGreaterThan(initial.shockScale);
  });

  it('clamps explosion profiles for out-of-range progress values', () => {
    expect(evaluateExplosionVisual(-3)).toEqual(evaluateExplosionVisual(0));
    expect(evaluateExplosionVisual(4)).toEqual(evaluateExplosionVisual(1));
  });
});
