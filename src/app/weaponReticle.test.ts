import { describe, expect, it } from 'vitest';

import type { WeaponId } from '../game/types';
import { WEAPONS } from '../game/weapons';
import { weaponReticle } from './weaponReticle';

describe('weapon-specific reticles', () => {
  it('does not present automatic or pellet weapons as pixel-precise', () => {
    expect(weaponReticle('pulse-rifle')).toBe('automatic');
    expect(weaponReticle('shotgun')).toBe('shotgun');
  });

  it('keeps precision weapons on the fine reticle', () => {
    for (const weapon of ['sidearm', 'battle-rifle', 'sniper'] satisfies WeaponId[]) {
      expect(weaponReticle(weapon)).toBe('precision');
    }
  });

  it('gives explosive launchers an unambiguous diamond sight', () => {
    expect(weaponReticle('rocket-launcher')).toBe('explosive');
  });

  it('matches wide sights to the authoritative projectile cone', () => {
    expect(WEAPONS.shotgun.pellets).toBe(12);
    expect(WEAPONS.shotgun.spread).toBeGreaterThan(WEAPONS['pulse-rifle'].spread);
    expect(WEAPONS['pulse-rifle'].maxSpread).toBeGreaterThan(WEAPONS.sidearm.maxSpread);
    expect(WEAPONS.sniper.spread).toBeLessThan(0.001);
  });
});
