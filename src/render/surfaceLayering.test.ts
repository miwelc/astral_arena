import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { COPLANAR_SURFACE_STEP, setCoplanarSurfaceLayer } from './surfaceLayering';

describe('coplanar surface layering', () => {
  it('separates overlapping surfaces both geometrically and in the depth buffer', () => {
    const lowerMaterial = new THREE.MeshStandardMaterial();
    const upperMaterial = new THREE.MeshStandardMaterial();
    const lower = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lowerMaterial);
    const upper = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), upperMaterial);

    setCoplanarSurfaceLayer(lower, 0.02, 2);
    setCoplanarSurfaceLayer(upper, 0.02, 3);

    expect(upper.position.y - lower.position.y).toBeCloseTo(COPLANAR_SURFACE_STEP);
    expect(upper.renderOrder).toBeGreaterThan(lower.renderOrder);
    expect(lowerMaterial.polygonOffset).toBe(true);
    expect(upperMaterial.polygonOffsetFactor).toBeLessThan(lowerMaterial.polygonOffsetFactor);
    expect(upperMaterial.polygonOffsetUnits).toBeLessThan(lowerMaterial.polygonOffsetUnits);

    lower.geometry.dispose();
    upper.geometry.dispose();
    lowerMaterial.dispose();
    upperMaterial.dispose();
  });

  it('rejects fractional or negative layer identifiers', () => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    expect(() => setCoplanarSurfaceLayer(mesh, 0, -1)).toThrow(RangeError);
    expect(() => setCoplanarSurfaceLayer(mesh, 0, 1.5)).toThrow(RangeError);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
});
