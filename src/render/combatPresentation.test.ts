import { describe, expect, it } from 'vitest';

import { WEAPONS } from '../game/weapons';
import {
  HIP_FIRE_FOV,
  hitVisualProfile,
  opticalZoomFov,
  visualRecoilImpulse,
} from './combatPresentation';

describe('combat presentation', () => {
  it('only changes FOV for weapons with an active optical zoom', () => {
    expect(opticalZoomFov(undefined, true, 0)).toBe(HIP_FIRE_FOV);
    expect(opticalZoomFov([53], false, 0)).toBe(HIP_FIRE_FOV);
    expect(opticalZoomFov([53], true, 0)).toBe(53);
    expect(opticalZoomFov([17.15, 8.62], true, 1)).toBe(8.62);
    expect(opticalZoomFov([17.15, 8.62], true, 99)).toBe(8.62);
  });

  it('preserves weapon recoil ordering instead of assigning one generic kick', () => {
    const automatic = visualRecoilImpulse(WEAPONS['pulse-rifle'].recoil);
    const sidearm = visualRecoilImpulse(WEAPONS.sidearm.recoil);
    const sniper = visualRecoilImpulse(WEAPONS.sniper.recoil);
    const rocket = visualRecoilImpulse(WEAPONS['rocket-launcher'].recoil);

    expect(automatic).toBeLessThan(sidearm);
    expect(sidearm).toBeLessThan(sniper);
    expect(sniper).toBeLessThan(rocket);
    expect(rocket).toBeLessThanOrEqual(1.35);
  });

  it('separates shield, health and fatal headshot responses', () => {
    const shield = hitVisualProfile({ type: 'hit', shieldDamage: 13, healthDamage: 0 });
    const health = hitVisualProfile({ type: 'hit', shieldDamage: 0, healthDamage: 13 });
    const headshot = hitVisualProfile({
      type: 'hit',
      headshot: true,
      fatal: true,
      shieldDamage: 0,
      healthDamage: 70,
    });

    expect(shield.color).not.toBe(health.color);
    expect(headshot.fatalHeadshot).toBe(true);
    expect(headshot.duration).toBeGreaterThan(health.duration);
    expect(headshot.endScale).toBeGreaterThan(health.endScale);
  });
});
