import { describe, expect, it } from 'vitest';

import { damageScaleAtDistance, sampleDirectionInCone, shotSpread } from './gunplay';
import { dot } from './math';
import { createWeaponState, WEAPONS } from './weapons';

describe('authoritative gunplay math', () => {
  it('samples a circular cone without changing direction at zero spread', () => {
    const forward = { x: 0, y: 0, z: -1 };
    expect(sampleDirectionInCone(forward, 0, 0.8, 0.2)).toEqual(forward);

    const halfAngle = 0.08;
    for (let index = 0; index < 32; index += 1) {
      const direction = sampleDirectionInCone(forward, halfAngle, index / 31, (index * 0.37) % 1);
      const angle = Math.acos(dot(forward, direction));
      expect(angle).toBeLessThanOrEqual(halfAngle + 1e-9);
    }
  });

  it('expands automatic spread with bloom and honors authored BR burst error', () => {
    const rifle = createWeaponState('pulse-rifle');
    expect(shotSpread(WEAPONS['pulse-rifle'], rifle)).toBeCloseTo(WEAPONS['pulse-rifle'].spread, 8);
    rifle.bloom = 1;
    expect(shotSpread(WEAPONS['pulse-rifle'], rifle)).toBeCloseTo(WEAPONS['pulse-rifle'].maxSpread, 8);

    const battleRifle = createWeaponState('battle-rifle');
    expect(shotSpread(WEAPONS['battle-rifle'], battleRifle, 0)).toBeLessThan(
      shotSpread(WEAPONS['battle-rifle'], battleRifle, 2),
    );
  });

  it('keeps shotgun lethality close and tapers pellets toward max range', () => {
    expect(damageScaleAtDistance(WEAPONS.shotgun, 2)).toBe(1);
    expect(damageScaleAtDistance(WEAPONS.shotgun, 10)).toBeGreaterThan(0.32);
    expect(damageScaleAtDistance(WEAPONS.shotgun, 16)).toBeCloseTo(0.32, 8);
  });
});
