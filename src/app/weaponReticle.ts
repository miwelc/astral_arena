import type { WeaponId } from '../game/types';

export type WeaponReticle = 'precision' | 'automatic' | 'shotgun' | 'explosive';

const RETICLES: Readonly<Record<WeaponId, WeaponReticle>> = Object.freeze({
  'pulse-rifle': 'automatic',
  sidearm: 'precision',
  'battle-rifle': 'precision',
  sniper: 'precision',
  shotgun: 'shotgun',
  'rocket-launcher': 'explosive',
});

export const weaponReticle = (weaponId: WeaponId | undefined): WeaponReticle =>
  weaponId ? RETICLES[weaponId] : 'precision';
