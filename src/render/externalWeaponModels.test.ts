import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import type { WeaponId } from '../game/types';
import { createWeaponModel, getWeaponAnchor, type WeaponAnimationRole } from './weaponModels';
import {
  EXTERNAL_WEAPON_IDS,
  EXTERNAL_WEAPON_SOURCES,
  ExternalWeaponModelLibrary,
  externalWeaponAssetUrl,
  type ExternalWeaponAssetLoader,
} from './externalWeaponModels';

const EXPECTED_ROLES: Readonly<Record<WeaponId, readonly WeaponAnimationRole[]>> = {
  'pulse-rifle': ['energy-cell'],
  sidearm: ['magazine', 'slide'],
  'battle-rifle': ['bolt', 'magazine'],
  sniper: ['bolt', 'magazine'],
  shotgun: ['magazine', 'pump'],
  'rocket-launcher': ['launcher-cassette'],
};

const SOURCE_PART_NAMES: Readonly<Record<WeaponId, readonly string[]>> = {
  'pulse-rifle': ['Magazine_AR_2'],
  sidearm: ['pewmagazine', 'pewhaut'],
  'battle-rifle': [],
  sniper: ['snipermagazine_low'],
  shotgun: ['shotgunpomp'],
  'rocket-launcher': ['quadrocketdevant_low'],
};

const weaponIdFromUrl = (url: string): WeaponId => {
  const id = EXTERNAL_WEAPON_IDS.find((candidate) => url.endsWith(`/${candidate}.glb`));
  if (!id) throw new Error(`Unexpected weapon URL: ${url}`);
  return id;
};

const syntheticScene = (id: WeaponId): THREE.Group => {
  const scene = new THREE.Group();
  const paintedAlbedo = new THREE.DataTexture(
    new Uint8Array([42, 176, 71, 255]),
    1,
    1,
    THREE.RGBAFormat,
  );
  paintedAlbedo.colorSpace = THREE.SRGBColorSpace;
  paintedAlbedo.needsUpdate = true;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2, 0.75, 0.34),
    new THREE.MeshStandardMaterial({
      name: 'Main',
      color: 0xc6ccca,
      roughness: 0.55,
      map: paintedAlbedo,
    }),
  );
  body.name = `${id}-body`;
  body.position.x = 0.35;
  scene.add(body);

  for (const name of SOURCE_PART_NAMES[id]) {
    const part = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, 0.12, 0.09),
      new THREE.MeshStandardMaterial({ name: 'Main', color: 0x38484a }),
    );
    part.name = name;
    scene.add(part);
  }
  return scene;
};

class SyntheticLoader implements ExternalWeaponAssetLoader {
  readonly loadAsync = vi.fn(async (url: string) => ({
    scene: syntheticScene(weaponIdFromUrl(url)),
  }));
}

describe('external weapon asset manifest', () => {
  it('covers every gameplay weapon with a local CC0 GLB', () => {
    expect(Object.keys(EXTERNAL_WEAPON_SOURCES).sort()).toEqual([...EXTERNAL_WEAPON_IDS].sort());
    for (const id of EXTERNAL_WEAPON_IDS) {
      const source = EXTERNAL_WEAPON_SOURCES[id];
      expect(source.assetPath).toBe(`models/weapons/${id}.glb`);
      expect(source.license).toBe('CC0-1.0');
      expect(source.author.length).toBeGreaterThan(0);
      expect(source.sourceUrl).toMatch(/^https:\/\//);
      expect(externalWeaponAssetUrl(id)).toMatch(new RegExp(`/?models/weapons/${id}\\.glb$`));
    }
  });
});

describe('ExternalWeaponModelLibrary', () => {
  it('returns the procedural model synchronously until the GLB is ready', () => {
    const library = new ExternalWeaponModelLibrary(new SyntheticLoader());
    const model = library.create('sniper');

    expect(model.userData.externalModel).not.toBe(true);
    expect(model.getObjectByName('weapon-optic-tube')).toBeDefined();
    expect(getWeaponAnchor(model, 'muzzle')).toBeInstanceOf(THREE.Vector3);
  });

  it('deduplicates concurrent loads and notifies renderer cache listeners once', async () => {
    const loader = new SyntheticLoader();
    const library = new ExternalWeaponModelLibrary(loader);
    const listener = vi.fn();
    const unsubscribe = library.subscribe(listener);

    const first = library.load('sidearm');
    const second = library.load('sidearm');
    const [firstTemplate, secondTemplate] = await Promise.all([first, second]);

    expect(firstTemplate).toBe(secondTemplate);
    expect(loader.loadAsync).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('sidearm');
    unsubscribe();
  });

  it('normalizes all source models to the procedural coordinate contract', async () => {
    const library = new ExternalWeaponModelLibrary(new SyntheticLoader());
    const report = await library.preload();

    expect(report.failed).toEqual([]);
    expect(report.loaded).toEqual(EXTERNAL_WEAPON_IDS);

    for (const id of EXTERNAL_WEAPON_IDS) {
      const external = library.create(id);
      const procedural = createWeaponModel(id);
      const externalBounds = new THREE.Box3().setFromObject(external);
      const proceduralBounds = new THREE.Box3().setFromObject(procedural);
      const externalSize = externalBounds.getSize(new THREE.Vector3());
      const proceduralSize = proceduralBounds.getSize(new THREE.Vector3());

      expect(external.userData.externalModel).toBe(true);
      expect(external.userData.externalModelLicense).toBe('CC0-1.0');
      expect(external.userData.weaponId).toBe(id);
      expect(externalSize.z).toBeCloseTo(proceduralSize.z, 5);
      expect(externalBounds.min.z).toBeCloseTo(proceduralBounds.min.z, 5);
      expect(getWeaponAnchor(external, 'primaryGrip')).toBeInstanceOf(THREE.Vector3);
      expect(getWeaponAnchor(external, 'supportGrip')).toBeInstanceOf(THREE.Vector3);
      expect(getWeaponAnchor(external, 'muzzle')).toBeInstanceOf(THREE.Vector3);
      expect(external.getObjectByName('weapon-external-visual')).toBeDefined();
      expect(external.getObjectByName('weapon-external-identification-panel')).toBeDefined();

      const roles: WeaponAnimationRole[] = [];
      external.traverse((object) => {
        const role = object.userData.animationRole as WeaponAnimationRole | undefined;
        if (role) roles.push(role);
      });
      expect([...roles].sort()).toEqual([...EXPECTED_ROLES[id]].sort());
      expect(new Set(roles).size).toBe(roles.length);

      for (const role of EXPECTED_ROLES[id]) {
        const part = external.getObjectByName(`weapon-part-${role}`);
        expect(part).toBeDefined();
        if (part?.userData.externalAnimationProxy !== true) continue;
        let hasVisibleMesh = false;
        part.traverse((object) => {
          if (object instanceof THREE.Mesh) hasVisibleMesh = true;
        });
        expect(hasVisibleMesh, `${id} ${role} proxy should remain visibly animated`).toBe(true);
      }
    }
  });

  it('remaps imported paint to pale ceramic while keeping dark functional parts', async () => {
    const library = new ExternalWeaponModelLibrary(new SyntheticLoader());
    await library.load('sidearm');
    const model = library.create('sidearm');
    const surfaces: THREE.MeshPhysicalMaterial[] = [];
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material instanceof THREE.MeshPhysicalMaterial && material.userData.externalWeaponSurface) {
          surfaces.push(material);
        }
      }
    });

    expect(surfaces.some((material) => material.userData.externalWeaponSurface === 'ceramic')).toBe(true);
    expect(surfaces.some((material) => material.userData.externalWeaponSurface === 'functional-dark')).toBe(true);
    const ceramic = surfaces.find((material) => material.userData.externalWeaponSurface === 'ceramic');
    expect(ceramic?.color.getHex()).toBe(0xf5f1e8);
    expect(ceramic?.map).toBeInstanceOf(THREE.DataTexture);
    expect(ceramic?.userData.ceramicAlbedoRemap).toBe(true);
    expect(ceramic?.customProgramCacheKey()).toContain('ceramic-albedo-ceramic');
  });

  it('gives each renderer an independently disposable GPU-resource clone', async () => {
    const library = new ExternalWeaponModelLibrary(new SyntheticLoader());
    await library.load('sidearm');
    const first = library.create('sidearm');
    const second = library.create('sidearm');
    const firstMesh = first.getObjectByProperty('type', 'Mesh') as THREE.Mesh;
    const secondMesh = second.getObjectByProperty('type', 'Mesh') as THREE.Mesh;

    expect(firstMesh).toBeInstanceOf(THREE.Mesh);
    expect(secondMesh).toBeInstanceOf(THREE.Mesh);
    expect(firstMesh.geometry).not.toBe(secondMesh.geometry);
    expect(firstMesh.material).not.toBe(secondMesh.material);
  });

  it('keeps successful models usable when one optional GLB fails', async () => {
    const loader: ExternalWeaponAssetLoader = {
      loadAsync: vi.fn(async (url: string) => {
        const id = weaponIdFromUrl(url);
        if (id === 'sniper') throw new Error('offline');
        return { scene: syntheticScene(id) };
      }),
    };
    const library = new ExternalWeaponModelLibrary(loader);

    const report = await library.preload(['sidearm', 'sniper']);

    expect(report.loaded).toEqual(['sidearm']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.id).toBe('sniper');
    expect(library.create('sidearm').userData.externalModel).toBe(true);
    expect(library.create('sniper').userData.externalModel).not.toBe(true);
  });
});
