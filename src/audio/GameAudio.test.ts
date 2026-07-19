import { describe, expect, it } from 'vitest';

import type { WeaponId } from '../game/types';
import { WEAPON_SOUND_PROFILES } from './GameAudio';

const weaponIds: WeaponId[] = [
  'pulse-rifle',
  'sidearm',
  'battle-rifle',
  'sniper',
  'shotgun',
  'rocket-launcher',
];

describe('procedural weapon sound profiles', () => {
  it('defines safe attack, body, tail and mechanism layers for every weapon', () => {
    expect(Object.keys(WEAPON_SOUND_PROFILES).sort()).toEqual([...weaponIds].sort());
    for (const profile of Object.values(WEAPON_SOUND_PROFILES)) {
      for (const layer of [profile.attack, profile.body, profile.tail, profile.mechanism]) {
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.duration).toBeLessThan(0.5);
        expect(layer.volume).toBeGreaterThan(0);
        expect(layer.volume).toBeLessThanOrEqual(1);
        expect(layer.from).toBeGreaterThanOrEqual(20);
        expect(layer.to).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('gives every weapon a distinct spectral and temporal signature', () => {
    const signatures = weaponIds.map((id) => {
      const profile = WEAPON_SOUND_PROFILES[id];
      return [
        profile.attack.duration,
        profile.attack.from,
        profile.body.from,
        profile.body.to,
        profile.tail.duration,
        profile.mechanism.delay,
      ].join(':');
    });
    expect(new Set(signatures).size).toBe(weaponIds.length);
  });

  it('uses a heavier low-frequency body for rockets and shotguns', () => {
    const rifle = WEAPON_SOUND_PROFILES['pulse-rifle'];
    const shotgun = WEAPON_SOUND_PROFILES.shotgun;
    const rocket = WEAPON_SOUND_PROFILES['rocket-launcher'];
    expect(shotgun.body.to).toBeLessThan(rifle.body.to);
    expect(rocket.body.from).toBeLessThan(shotgun.body.from);
    expect(rocket.tail.duration).toBeGreaterThan(shotgun.tail.duration);
  });
});
