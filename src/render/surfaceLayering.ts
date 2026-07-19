import * as THREE from 'three';

export const COPLANAR_SURFACE_STEP = 0.00075;
const SURFACE_RENDER_ORDER_BASE = 40;

/**
 * Gives deliberately overlapping floor details a deterministic depth order.
 * A minute physical separation handles shadow/depth pre-passes, while polygon
 * offset prevents precision loss at grazing camera angles and long distances.
 */
export const setCoplanarSurfaceLayer = <T extends THREE.Mesh>(
  mesh: T,
  baseY: number,
  layer: number,
): T => {
  if (!Number.isFinite(baseY) || !Number.isInteger(layer) || layer < 0) {
    throw new RangeError('Surface layers require a finite base height and a non-negative integer layer.');
  }
  const bias = layer + 1;
  mesh.position.y = baseY + layer * COPLANAR_SURFACE_STEP;
  mesh.renderOrder = SURFACE_RENDER_ORDER_BASE + layer;
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    material.polygonOffset = true;
    material.polygonOffsetFactor = -bias;
    material.polygonOffsetUnits = -bias;
    material.needsUpdate = true;
  }
  return mesh;
};
