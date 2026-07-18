import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { WeaponId } from '../game/types';
import {
  createWeaponModel,
  type WeaponAnimationRole,
} from './weaponModels';

const EXPECTED_ROLES: Readonly<Record<WeaponId, readonly WeaponAnimationRole[]>> = {
  'pulse-rifle': ['energy-cell'],
  sidearm: ['magazine', 'slide'],
  'battle-rifle': ['bolt', 'magazine'],
  sniper: ['bolt', 'magazine'],
  shotgun: ['magazine', 'pump'],
  'rocket-launcher': ['launcher-cassette'],
};

const HOLOGRAPHIC_WEAPONS = new Set<WeaponId>(['pulse-rifle', 'battle-rifle']);

const expectFiniteVector = (value: unknown): void => {
  expect(value).toBeDefined();
  expect(value).toEqual(expect.objectContaining({
    x: expect.any(Number),
    y: expect.any(Number),
    z: expect.any(Number),
  }));

  const vector = value as { x: number; y: number; z: number };
  expect([vector.x, vector.y, vector.z].every(Number.isFinite)).toBe(true);
};

describe('procedural weapon animation contract', () => {
  for (const [weaponId, expectedRoles] of Object.entries(EXPECTED_ROLES) as Array<
    [WeaponId, readonly WeaponAnimationRole[]]
  >) {
    it(`${weaponId} exposes its expected unique animation parts`, () => {
      const model = createWeaponModel(weaponId);
      const roles: WeaponAnimationRole[] = [];

      model.traverse((object) => {
        const role = object.userData.animationRole as WeaponAnimationRole | undefined;
        if (role) roles.push(role);
      });

      expect(new Set(roles).size).toBe(roles.length);
      expect([...roles].sort()).toEqual([...expectedRoles].sort());

      for (const role of expectedRoles) {
        const part = model.getObjectByName(`weapon-part-${role}`);
        expect(part, `missing named ${role} part`).toBeDefined();
        expect(part?.userData.animationRole).toBe(role);
      }
    });

    it(`${weaponId} keeps finite grip and muzzle metadata`, () => {
      const model = createWeaponModel(weaponId);

      expectFiniteVector(model.userData.primaryGrip);
      expectFiniteVector(model.userData.supportGrip);
      expectFiniteVector(model.userData.muzzle);
      if (model.userData.secondaryMuzzle !== undefined) {
        expectFiniteVector(model.userData.secondaryMuzzle);
      }
    });

    it(`${weaponId} keeps a readable hard-surface material hierarchy`, () => {
      const model = createWeaponModel(weaponId);
      const materialNames = new Set<string>();

      model.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) materialNames.add(material.name);
      });

      expect([...materialNames].some((name) => name.endsWith('-graphite-coated-alloy'))).toBe(true);
      expect([...materialNames].some((name) => name.endsWith('-pale-ceramic-panel'))).toBe(true);
      expect([...materialNames].some((name) => name.endsWith('-dark-polymer'))).toBe(true);
      expect([...materialNames].some((name) => name.endsWith('-grip-rubber'))).toBe(true);
      expect([...materialNames].some((name) => name.endsWith('-machined-metal'))).toBe(true);
    });

    it(`${weaponId} uses the intended optic family`, () => {
      const model = createWeaponModel(weaponId);
      const holographic = model.getObjectByName('weapon-optic-holographic');
      const tube = model.getObjectByName('weapon-optic-tube');

      expect(Boolean(holographic)).toBe(HOLOGRAPHIC_WEAPONS.has(weaponId));
      expect(Boolean(tube)).toBe(weaponId === 'sniper');
      if (holographic) {
        expect(holographic.userData.opticType).toBe('holographic');
        expect(holographic.getObjectByName('weapon-holographic-glass')).toBeDefined();
      }
    });
  }
});
