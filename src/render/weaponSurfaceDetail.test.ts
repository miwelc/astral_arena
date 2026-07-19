import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { applyFallbackWeaponNormalDetail } from './weaponSurfaceDetail';

const geometryWithoutUvs = (): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  return geometry;
};

describe('fallback weapon normal detail', () => {
  it('does not assign tangent-space detail to a GLB primitive without TEXCOORD_0', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometryWithoutUvs(), material));

    const updated = applyFallbackWeaponNormalDetail(root, new THREE.Texture());

    expect(updated).toBe(0);
    expect(material.normalMap).toBeNull();
  });

  it('adds subtle normal detail to UV-authored procedural geometry', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const detail = new THREE.Texture();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));

    const updated = applyFallbackWeaponNormalDetail(root, detail);

    expect(updated).toBe(1);
    expect(material.normalMap).toBe(detail);
    expect(material.normalScale.toArray()).toEqual([0.11, 0.11]);
  });

  it('keeps a shared material safe when any primitive using it lacks UVs', () => {
    const shared = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    root.add(
      new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared),
      new THREE.Mesh(geometryWithoutUvs(), shared),
    );

    expect(applyFallbackWeaponNormalDetail(root, new THREE.Texture())).toBe(0);
    expect(shared.normalMap).toBeNull();
  });
});
