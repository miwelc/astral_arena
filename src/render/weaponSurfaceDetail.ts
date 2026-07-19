import * as THREE from 'three';

/**
 * Adds the renderer's subtle fallback normal detail only where tangent-space
 * sampling is defined. Some of the authored CC0 GLBs intentionally contain no
 * TEXCOORD_0; assigning a normal map there samples one texel over the whole
 * gun and produces incorrect, often dark lighting.
 */
export const applyFallbackWeaponNormalDetail = (
  root: THREE.Object3D,
  normalTexture: THREE.Texture,
): number => {
  const uvSafeByMaterial = new Map<THREE.MeshStandardMaterial, boolean>();

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const hasUv = Boolean(object.geometry.getAttribute('uv'));
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.transparent || material.normalMap) continue;
      uvSafeByMaterial.set(material, (uvSafeByMaterial.get(material) ?? true) && hasUv);
    }
  });

  let updated = 0;
  for (const [material, uvSafe] of uvSafeByMaterial) {
    if (!uvSafe) continue;
    material.normalMap = normalTexture;
    material.normalScale.set(0.11, 0.11);
    material.needsUpdate = true;
    updated += 1;
  }
  return updated;
};
