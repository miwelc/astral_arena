import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { TITAN_EXPANSE } from '../game/map';
import { titanCreekCenterZ } from '../game/maps/titanExpanse';
import {
  createTitanForestWorld,
  sampleTitanForestVisualHeight,
  type TitanForestModels,
  type TitanForestWorldBundle,
} from './forestWorld';

const bundles: TitanForestWorldBundle[] = [];

const createBundle = (quality: 'low' | 'high' = 'high', seed = 0x71a9e): TitanForestWorldBundle => {
  const bundle = createTitanForestWorld({
    map: TITAN_EXPANSE,
    creekCenterZ: titanCreekCenterZ,
    quality,
    seed,
  });
  bundles.push(bundle);
  return bundle;
};

afterEach(() => {
  for (const bundle of bundles.splice(0)) bundle.dispose();
});

describe('Titan forest world', () => {
  it('samples the authored heightfield at every playable terrain vertex', () => {
    const bundle = createBundle('low');
    const terrain = bundle.group.getObjectByName('titan-chunked-heightfield');
    let checked = 0;
    terrain?.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || checked > 300) return;
      const position = object.geometry.getAttribute('position');
      for (let index = 0; index < position.count && checked <= 300; index += 1) {
        const x = position.getX(index);
        const z = position.getZ(index);
        if (
          x < TITAN_EXPANSE.bounds.minX
          || x > TITAN_EXPANSE.bounds.maxX
          || z < TITAN_EXPANSE.bounds.minZ
          || z > TITAN_EXPANSE.bounds.maxZ
        ) continue;
        expect(position.getY(index)).toBeCloseTo(TITAN_EXPANSE.groundHeightAt!(x, z), 4);
        checked += 1;
      }
    });
    expect(checked).toBeGreaterThan(250);
    expect(bundle.stats.terrainChunks).toBeGreaterThan(30);
    expect(bundle.stats.terrainVertices).toBeGreaterThan(12_000);
  });

  it('scatters chunked vegetation deterministically from its seed', () => {
    const first = createBundle('low', 771);
    const second = createBundle('low', 771);
    const firstGrass = first.group.getObjectByName('titan-dense-grass') as THREE.InstancedMesh;
    const secondGrass = second.group.getObjectByName('titan-dense-grass') as THREE.InstancedMesh;
    const firstCrowns = first.group.getObjectByName('titan-umbrella-tree-crowns') as THREE.InstancedMesh;
    const secondCrowns = second.group.getObjectByName('titan-umbrella-tree-crowns') as THREE.InstancedMesh;

    expect(first.stats).toEqual(second.stats);
    expect(Array.from(firstGrass.instanceMatrix.array)).toEqual(Array.from(secondGrass.instanceMatrix.array));
    expect(Array.from(firstCrowns.instanceMatrix.array)).toEqual(Array.from(secondCrowns.instanceMatrix.array));
  });

  it('keeps a lush forest inside a bounded draw and shadow budget', () => {
    const { stats, group } = createBundle('high');
    expect(stats.vegetationTiles).toBeLessThanOrEqual(30);
    expect(stats.treeInstances).toBeGreaterThan(120);
    expect(stats.grassInstances).toBeGreaterThan(7_000);
    expect(stats.fernInstances).toBeGreaterThan(700);
    expect(stats.rockInstances).toBeGreaterThan(120);
    expect(stats.renderables).toBeLessThanOrEqual(200);
    expect(stats.shadowCasters).toBeLessThanOrEqual(14);
    expect(stats.transparentRenderables).toBe(1);
    expect(group.getObjectByName('titan-natural-cliff-perimeter')).toBeInstanceOf(THREE.InstancedMesh);
    expect(group.getObjectByName('titan-south-creek')).toBeInstanceOf(THREE.Mesh);
  });

  it('places the water ribbon on the map-owned creek centerline', () => {
    const bundle = createBundle('low');
    const creek = bundle.group.getObjectByName('titan-south-creek') as THREE.Mesh;
    const position = creek.geometry.getAttribute('position');
    for (let index = 0; index < position.count; index += 18) {
      const pair = index - index % 2;
      const x = position.getX(pair);
      const centerZ = (position.getZ(pair) + position.getZ(pair + 1)) * 0.5;
      expect(centerZ).toBeCloseTo(titanCreekCenterZ(x), 4);
    }
  });

  it('keeps perimeter mountain normals facing out and their bases buried in terrain', () => {
    const seed = 0x71a9e;
    const bundle = createBundle('low', seed);
    const cliffs = bundle.group.getObjectByName('titan-natural-cliff-perimeter') as THREE.InstancedMesh;
    const positions = cliffs.geometry.getAttribute('position');
    const normals = cliffs.geometry.getAttribute('normal');
    let outward = 0;
    let radialVertices = 0;
    for (let index = 0; index < positions.count; index += 1) {
      const x = positions.getX(index);
      const z = positions.getZ(index);
      if (Math.hypot(x, z) < 0.14) continue;
      radialVertices += 1;
      if (x * normals.getX(index) + z * normals.getZ(index) > 0) outward += 1;
    }
    expect(outward / radialVertices).toBeGreaterThan(0.92);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let index = 0; index < cliffs.count; index += 1) {
      cliffs.getMatrixAt(index, matrix);
      matrix.decompose(position, rotation, scale);
      const ground = sampleTitanForestVisualHeight(TITAN_EXPANSE, position.x, position.z, seed);
      expect(position.y).toBeLessThanOrEqual(ground + 0.01);
      expect(position.y).toBeGreaterThan(ground - 7.2);
    }
  });

  it('updates wind/water without moving static chunks and disposes idempotently', () => {
    const bundle = createBundle('low');
    const terrain = bundle.group.getObjectByName('titan-chunked-heightfield');
    const before = terrain?.matrix.clone();
    bundle.update(12.4, new THREE.Vector3(0, 3, 0));
    expect(terrain?.matrix.equals(before!)).toBe(true);
    expect(() => bundle.dispose()).not.toThrow();
    expect(bundle.group.children).toHaveLength(0);
    expect(() => bundle.dispose()).not.toThrow();
  });

  it('cycles scanned understory variants without disposing shared asset-library resources', () => {
    const namedGeometry = (name: string): THREE.BufferGeometry => {
      const geometry = new THREE.BoxGeometry(0.5, 1, 0.5);
      geometry.name = name;
      return geometry;
    };
    const grassGeometries = [namedGeometry('grass-a'), namedGeometry('grass-b'), namedGeometry('grass-c')];
    const fernGeometries = [namedGeometry('fern-a'), namedGeometry('fern-b')];
    const rockGeometries = [namedGeometry('rock-a'), namedGeometry('rock-b'), namedGeometry('rock-c')];
    const sourceMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const models: TitanForestModels = {
      grass: { geometries: grassGeometries, material: sourceMaterial },
      fern: { geometries: fernGeometries, material: sourceMaterial },
      rock: { geometries: rockGeometries, material: sourceMaterial },
    };
    const disposedGeometries = new Set<THREE.BufferGeometry>();
    for (const geometry of [...grassGeometries, ...fernGeometries, ...rockGeometries]) {
      geometry.addEventListener('dispose', () => disposedGeometries.add(geometry));
    }
    let sourceMaterialDisposed = false;
    sourceMaterial.addEventListener('dispose', () => { sourceMaterialDisposed = true; });

    const seed = 771;
    const bundle = createTitanForestWorld({
      map: TITAN_EXPANSE,
      creekCenterZ: titanCreekCenterZ,
      quality: 'low',
      seed,
      models,
    });
    bundles.push(bundle);
    const grassMeshes: THREE.InstancedMesh[] = [];
    const fernMeshes: THREE.InstancedMesh[] = [];
    bundle.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      if (object.name === 'titan-dense-grass') grassMeshes.push(object);
      if (object.name === 'titan-natural-ferns') fernMeshes.push(object);
    });

    expect(grassMeshes.length).toBeGreaterThan(grassGeometries.length);
    expect(fernMeshes.length).toBeGreaterThan(fernGeometries.length);
    grassMeshes.forEach((mesh, index) => {
      expect(mesh.geometry).toBe(grassGeometries[index % grassGeometries.length]);
    });
    fernMeshes.forEach((mesh, index) => {
      expect(mesh.geometry).toBe(fernGeometries[index % fernGeometries.length]);
    });
    const wetRocks = bundle.group.getObjectByName('titan-wet-rocks') as THREE.InstancedMesh;
    expect(wetRocks.geometry).toBe(rockGeometries[((seed ^ 0x771c) >>> 0) % rockGeometries.length]);

    bundle.dispose();
    expect(disposedGeometries.size).toBe(0);
    expect(sourceMaterialDisposed).toBe(false);
  });
});
