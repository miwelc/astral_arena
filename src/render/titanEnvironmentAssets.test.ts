import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import {
  TITAN_CLIFF_VARIANT_NAME,
  TITAN_ENVIRONMENT_ASSET_PATHS,
  TITAN_ENVIRONMENT_SOURCES,
  TITAN_FERN_VARIANT_NAMES,
  TITAN_GRASS_VARIANT_NAMES,
  TITAN_ROCK_VARIANT_NAMES,
  TitanEnvironmentAssetLibrary,
  type TitanEnvironmentAssetLoaders,
  titanEnvironmentAssetUrl,
} from './titanEnvironmentAssets';

const sceneWith = (names: readonly string[]): THREE.Group => {
  const root = new THREE.Group();
  for (const name of names) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ name: `${name}-material` }),
    );
    mesh.name = name;
    mesh.position.set(7, 3, -5);
    mesh.scale.set(2, 3, 0.5);
    root.add(mesh);
  }
  return root;
};

const fixtureLoaders = (): {
  loaders: TitanEnvironmentAssetLoaders;
  gltfLoad: ReturnType<typeof vi.fn>;
  hdriLoad: ReturnType<typeof vi.fn>;
  textureLoad: ReturnType<typeof vi.fn>;
} => {
  const gltfLoad = vi.fn((url: string) => {
    const names = url.includes('/grass_bermuda_01/')
      ? TITAN_GRASS_VARIANT_NAMES
      : url.includes('/fern_02/')
        ? TITAN_FERN_VARIANT_NAMES
        : url.includes('/rock_moss_set_02/')
          ? TITAN_ROCK_VARIANT_NAMES
          : [TITAN_CLIFF_VARIANT_NAME];
    return Promise.resolve({ scene: sceneWith(names) });
  });
  const hdriLoad = vi.fn(() => Promise.resolve(new THREE.DataTexture()));
  const textureLoad = vi.fn(() => Promise.resolve(new THREE.Texture()));
  return {
    loaders: {
      gltf: { loadAsync: gltfLoad },
      hdri: { loadAsync: hdriLoad },
      texture: { loadAsync: textureLoad },
    },
    gltfLoad,
    hdriLoad,
    textureLoad,
  };
};

describe('Titan environment asset library', () => {
  it('resolves every local asset below the Vite deployment base', () => {
    const base = import.meta.env.BASE_URL || '/';
    const normalizedBase = base.endsWith('/') ? base : `${base}/`;
    for (const path of Object.values(TITAN_ENVIRONMENT_ASSET_PATHS)) {
      expect(titanEnvironmentAssetUrl(path)).toBe(`${normalizedBase}${path}`);
    }
  });

  it('loads once, exposes named shared geometry, and configures image roles', async () => {
    const fixture = fixtureLoaders();
    const library = new TitanEnvironmentAssetLibrary(fixture.loaders);

    const [first, concurrent] = await Promise.all([library.preload(), library.preload()]);
    const cached = await library.preload();

    expect(concurrent).toBe(first);
    expect(cached).toBe(first);
    expect(library.get()).toBe(first);
    expect(fixture.gltfLoad).toHaveBeenCalledTimes(4);
    expect(fixture.hdriLoad).toHaveBeenCalledTimes(1);
    expect(fixture.textureLoad).toHaveBeenCalledTimes(11);

    expect(first.grass.size).toBe(TITAN_GRASS_VARIANT_NAMES.length);
    expect(first.ferns.size).toBe(TITAN_FERN_VARIANT_NAMES.length);
    expect(first.rocks.size).toBe(TITAN_ROCK_VARIANT_NAMES.length);
    expect(first.grass.get('grass_bermuda_01_medium_a')?.geometry).toBeInstanceOf(THREE.BufferGeometry);
    expect(first.ferns.get('fern_02_d')?.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect((first.ferns.get('fern_02_d')?.material as THREE.MeshStandardMaterial).alphaMap)
      .toBeInstanceOf(THREE.Texture);
    expect(first.rocks.get('rock_moss_set_02_rock09')?.name).toBe('rock_moss_set_02_rock09');
    expect(first.cliff.name).toBe(TITAN_CLIFF_VARIANT_NAME);

    for (const asset of [...first.grass.values(), ...first.ferns.values(), first.cliff]) {
      const bounds = asset.geometry.boundingBox;
      expect(bounds).not.toBeNull();
      const size = bounds!.getSize(new THREE.Vector3());
      const center = bounds!.getCenter(new THREE.Vector3());
      expect(bounds!.min.y).toBeCloseTo(0);
      expect(size.y).toBeCloseTo(1);
      expect(center.x).toBeCloseTo(0);
      expect(center.z).toBeCloseTo(0);
    }
    for (const asset of first.rocks.values()) {
      const bounds = asset.geometry.boundingBox;
      expect(bounds).not.toBeNull();
      const size = bounds!.getSize(new THREE.Vector3());
      const center = bounds!.getCenter(new THREE.Vector3());
      expect(bounds!.min.y).toBeCloseTo(0);
      expect(Math.max(size.x, size.y, size.z)).toBeCloseTo(2);
      expect(center.x).toBeCloseTo(0);
      expect(center.z).toBeCloseTo(0);
    }

    expect(first.environmentEquirect.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(first.ground.albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first.ground.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(first.ground.roughness.colorSpace).toBe(THREE.NoColorSpace);
    for (const texture of Object.values(first.ground)) {
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    }
    expect(first.textures.barkAlbedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first.textures.leafAlbedo.colorSpace).toBe(THREE.SRGBColorSpace);
    for (const texture of [
      first.textures.barkNormal,
      first.textures.barkRoughness,
      first.textures.leafNormal,
      first.textures.leafOpacity,
      first.textures.leafRoughness,
    ]) {
      expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    }
    for (const texture of [
      first.textures.barkAlbedo,
      first.textures.barkNormal,
      first.textures.barkRoughness,
    ]) {
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    }
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ground)).toBe(true);
    expect(Object.isFrozen(first.textures)).toBe(true);
  });

  it('does not publish an incomplete asset set and permits a retry', async () => {
    const fixture = fixtureLoaders();
    const validLoad = fixture.loaders.gltf.loadAsync;
    let failGrass = true;
    const library = new TitanEnvironmentAssetLibrary({
      ...fixture.loaders,
      gltf: {
        loadAsync: (url) => {
          if (failGrass && url.includes('/grass_bermuda_01/')) {
            failGrass = false;
            return Promise.resolve({ scene: sceneWith([]) });
          }
          return validLoad(url);
        },
      },
    });

    await expect(library.preload()).rejects.toThrow(
      'Grass Bermuda 01 is missing required mesh grass_bermuda_01_dead_a.',
    );
    expect(library.get()).toBeNull();

    const recovered = await library.preload();
    expect(library.get()).toBe(recovered);
    expect(recovered.grass.size).toBe(TITAN_GRASS_VARIANT_NAMES.length);
  });

  it('keeps a complete CC0 provenance ledger for bundled sources', () => {
    expect(Object.keys(TITAN_ENVIRONMENT_SOURCES)).toEqual([
      'grass',
      'ferns',
      'rocks',
      'cliff',
      'ground',
      'bark',
      'foliage',
      'environment',
    ]);
    for (const source of Object.values(TITAN_ENVIRONMENT_SOURCES)) {
      expect(source.license).toBe('CC0-1.0');
      expect(source.authors.length).toBeGreaterThan(0);
      expect(source.sourceUrl).toMatch(/^https:\/\/(polyhaven\.com\/a\/|ambientcg\.com\/view\?id=)/);
    }
    expect(TITAN_ENVIRONMENT_SOURCES.bark.sourceUrl).toBe(
      'https://ambientcg.com/view?id=Bark012',
    );
    expect(TITAN_ENVIRONMENT_SOURCES.foliage.sourceUrl).toBe(
      'https://ambientcg.com/view?id=LeafSet024',
    );
  });
});
