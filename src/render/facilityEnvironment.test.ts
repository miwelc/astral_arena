import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createFacilityBlock,
  createFacilityEnvironment,
  createFacilityMaterialKit,
  createFacilityRail,
  createTallTreeGrove,
  createUnderstoryField,
  disposeFacilityMaterialKit,
  type FacilityMaterialKit,
} from './facilityEnvironment';

const allocatedKits: FacilityMaterialKit[] = [];

const makeKit = (): FacilityMaterialKit => {
  const kit = createFacilityMaterialKit();
  allocatedKits.push(kit);
  return kit;
};

afterEach(() => {
  for (const kit of allocatedKits.splice(0)) disposeFacilityMaterialKit(kit);
});

const instanceMatrices = (group: THREE.Group, name: string): number[] => {
  const mesh = group.getObjectByName(name) as THREE.InstancedMesh | undefined;
  if (!mesh) throw new Error(`Missing ${name}`);
  return Array.from(mesh.instanceMatrix.array);
};

describe('facility environment geometry', () => {
  it('scatters tree layers deterministically from a seed', () => {
    const materials = makeKit();
    const options = {
      seed: 417,
      bounds: { minX: -8, maxX: 8, minZ: -6, maxZ: 6 },
      materials,
      count: 7,
      heightRange: [7, 11] as const,
    };
    const first = createTallTreeGrove(options);
    const second = createTallTreeGrove(options);

    expect(first.userData.treeCount).toBe(7);
    expect(instanceMatrices(first, 'tree-trunks')).toEqual(instanceMatrices(second, 'tree-trunks'));
    expect(instanceMatrices(first, 'tree-crowns')).toEqual(instanceMatrices(second, 'tree-crowns'));
  });

  it('respects no-grow zones for instanced understory', () => {
    const field = createUnderstoryField({
      seed: 9,
      bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 },
      materials: makeKit(),
      fernCount: 20,
      grassCount: 40,
      exclusions: [{ minX: -6, maxX: 6, minZ: -6, maxZ: 6 }],
    });

    expect(field.userData.fernCrownCount).toBe(0);
    expect(field.userData.fernFrondCount).toBe(0);
    expect(field.userData.grassCount).toBe(0);
  });

  it('keeps dense grass at lawn height instead of producing repeated metre-high spikes', () => {
    const field = createUnderstoryField({
      seed: 77,
      bounds: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 },
      materials: makeKit(),
      fernCount: 0,
      grassCount: 24,
    });
    const grass = field.getObjectByName('grass-tufts') as THREE.InstancedMesh | undefined;

    expect(grass).toBeInstanceOf(THREE.InstancedMesh);
    grass!.geometry.computeBoundingBox();
    expect(grass!.geometry.boundingBox?.max.y).toBeLessThan(0.65);
    expect(new Set(instanceMatrices(field, 'grass-tufts').map((value) => value.toFixed(3))).size)
      .toBeGreaterThan(8);
  });

  it('creates layered facility facades without requiring browser canvas', () => {
    const block = createFacilityBlock({
      seed: 82,
      materials: makeKit(),
      width: 10,
      height: 5,
      depth: 7,
      label: 'B91',
    });

    expect(block.getObjectByName('structural-core')).toBeInstanceOf(THREE.Mesh);
    expect(block.getObjectByName('continuous-window-front')).toBeInstanceOf(THREE.Mesh);
    expect(block.getObjectByName('lime-roof-fascia')).toBeInstanceOf(THREE.Mesh);
    expect(block.getObjectByName('access-light')).toBeInstanceOf(THREE.Mesh);
  });

  it('assigns distinct manufactured facade families instead of repeating white and lime everywhere', () => {
    const materials = makeKit();
    const ceramic = createFacilityBlock({
      seed: 81,
      materials,
      width: 8,
      height: 5,
      depth: 6,
    });
    const sage = createFacilityBlock({
      seed: 82,
      materials,
      width: 8,
      height: 5,
      depth: 6,
    });
    const blue = createFacilityBlock({
      seed: 83,
      materials,
      width: 8,
      height: 5,
      depth: 6,
    });

    expect([ceramic.userData.facadeStyle, sage.userData.facadeStyle, blue.userData.facadeStyle])
      .toEqual(['ceramic', 'sage-alloy', 'desaturated-blue']);
    const materialsUsed = (group: THREE.Group): Set<THREE.Material> => {
      const result = new Set<THREE.Material>();
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of meshMaterials) result.add(material);
      });
      return result;
    };
    expect(materialsUsed(ceramic).has(materials.panelLight)).toBe(true);
    expect(materialsUsed(sage).has(materials.panelSage)).toBe(true);
    expect(materialsUsed(blue).has(materials.panelBlue)).toBe(true);
    expect(materials.panelLight.map).toBeInstanceOf(THREE.DataTexture);
    expect(materials.panelSage.normalMap).toBe(materials.panelLight.normalMap);
    expect(materials.panelBlue.roughnessMap).toBe(materials.panelLight.roughnessMap);
  });

  it('builds rails with endpoint posts, handrail and sagging cable', () => {
    const rail = createFacilityRail({
      start: [0, 1, 0],
      end: [5, 1, 0],
      materials: makeKit(),
      postSpacing: 2,
    });

    expect(rail.userData.postCount).toBe(4);
    expect(rail.getObjectByName('rail-post-0')).toBeInstanceOf(THREE.Mesh);
    expect(rail.getObjectByName('rail-handrail')).toBeInstanceOf(THREE.Mesh);
    expect(rail.getObjectByName('rail-lower-cable')).toBeInstanceOf(THREE.Mesh);
  });

  it('composes and safely disposes a small environment bundle', () => {
    const bundle = createFacilityEnvironment({
      seed: 101,
      bounds: { minX: -3, maxX: 3, minZ: -3, maxZ: 3 },
      quality: 'low',
      blocks: [
        {
          seed: 102,
          position: [0, 0, 0],
          width: 4,
          height: 3,
          depth: 3,
          roofEquipment: false,
        },
      ],
    });

    expect(bundle.ownsMaterials).toBe(true);
    expect(bundle.group.children.length).toBeGreaterThanOrEqual(3);
    expect(() => bundle.dispose()).not.toThrow();
    expect(() => bundle.dispose()).not.toThrow();
    expect(bundle.group.children).toHaveLength(0);
  });
});
