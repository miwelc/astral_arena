import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { CRATER_RIDGE, TITAN_EXPANSE, UMBRA_STATION } from '../game/map';
import { createBaseArchitecture, type BaseArchitectureBundle } from './baseArchitecture';

const bundles: BaseArchitectureBundle[] = [];

const createBundle = (quality: 'low' | 'high' = 'high'): BaseArchitectureBundle => {
  const bundle = createBaseArchitecture(CRATER_RIDGE, { quality, seed: 712 });
  bundles.push(bundle);
  return bundle;
};

const createUmbraBundle = (): BaseArchitectureBundle => {
  const bundle = createBaseArchitecture(UMBRA_STATION, { quality: 'high', seed: 909 });
  bundles.push(bundle);
  return bundle;
};

const createTitanBundle = (): BaseArchitectureBundle => {
  const bundle = createBaseArchitecture(TITAN_EXPANSE, { quality: 'high', seed: 1217 });
  bundles.push(bundle);
  return bundle;
};

const findAuthoredMesh = (group: THREE.Group, sourceName: string): THREE.Mesh | undefined => {
  let result: THREE.Mesh | undefined;
  group.traverse((object) => {
    if (result || !(object instanceof THREE.Mesh)) return;
    const sourceNames = object.userData.sourceNames as string[] | undefined;
    if (object.name === sourceName || sourceNames?.includes(sourceName)) result = object;
  });
  return result;
};

afterEach(() => {
  for (const bundle of bundles.splice(0)) bundle.dispose();
});

describe('human base architecture', () => {
  it('builds mirrored team facilities with traversable-door visual language', () => {
    const { group } = createBundle();
    const aurora = group.getObjectByName('aurora-operations-building');
    const nova = group.getObjectByName('nova-operations-building');

    expect(aurora).toBeInstanceOf(THREE.Group);
    expect(nova).toBeInstanceOf(THREE.Group);
    expect(aurora?.userData.hasInterior).toBe(true);
    expect(nova?.userData.entryClearWidth).toBe(8.8);
    expect(group.getObjectByName('aurora-pressure-door')).toBeInstanceOf(THREE.Group);
    expect(group.getObjectByName('nova-pressure-door')).toBeInstanceOf(THREE.Group);
    expect(findAuthoredMesh(group, 'aurora-loading-ramp')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'nova-loading-ramp')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'aurora-mezzanine-handrail')).toBeInstanceOf(THREE.Mesh);
    expect(group.getObjectByName('aurora-facade-north-windows')).toBeInstanceOf(THREE.InstancedMesh);
  });

  it('creates recognizable occupied relay and hydroponics interiors', () => {
    const { group } = createBundle('low');
    const relay = group.getObjectByName('observatory-relay-building');
    const greenhouse = group.getObjectByName('hydroponics-laboratory');
    const westCrops = group.getObjectByName('greenhouse-west-crops') as THREE.InstancedMesh | undefined;

    expect(relay?.userData.function).toBe('meteorological-relay-and-power-weapon-room');
    expect(findAuthoredMesh(group, 'relay-antenna-mast')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'relay-west-console-screen')).toBeInstanceOf(THREE.Mesh);
    expect(greenhouse?.userData.function).toBe('food-production-and-botany-laboratory');
    expect(group.getObjectByName('greenhouse-skylight--5.7')).toBeInstanceOf(THREE.Mesh);
    expect(westCrops).toBeInstanceOf(THREE.InstancedMesh);
    expect(westCrops?.count).toBe(24);
  });

  it('uses coherent PBR panel maps and detailed cargo dressing', () => {
    const { group } = createBundle();
    const ramp = findAuthoredMesh(group, 'aurora-loading-ramp');
    const material = ramp?.material as THREE.MeshPhysicalMaterial | undefined;

    expect(material?.map).toBeInstanceOf(THREE.DataTexture);
    expect(material?.normalMap).toBeInstanceOf(THREE.DataTexture);
    expect(material?.roughnessMap).toBeInstanceOf(THREE.DataTexture);
    expect(material?.map?.wrapS).toBe(THREE.RepeatWrapping);
    expect(findAuthoredMesh(group, 'cover-nw-a-cargo-corner--1--1')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'cover-se-b-cargo-id-back')).toBeInstanceOf(THREE.Mesh);
  });

  it('keeps Crater ceramic-bright while Umbra uses dark reflective orbital panels', () => {
    const crater = createBundle();
    const umbra = createUmbraBundle();
    const craterPanel = findAuthoredMesh(crater.group, 'relay-antenna-fin-1')
      ?.material as THREE.MeshPhysicalMaterial | undefined;
    const umbraPanel = findAuthoredMesh(umbra.group, 'umbra-relay-deep-space-dish')
      ?.material as THREE.MeshPhysicalMaterial | undefined;
    const craterScreen = findAuthoredMesh(crater.group, 'relay-west-console-screen')
      ?.material as THREE.MeshStandardMaterial | undefined;
    const umbraScreen = findAuthoredMesh(umbra.group, 'umbra-relay-telemetry-panel-west')
      ?.material as THREE.MeshStandardMaterial | undefined;

    expect(craterPanel).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(umbraPanel).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(craterPanel?.name).toBe('architecture-white-panel');
    expect(umbraPanel?.name).toBe('architecture-white-panel');
    expect(craterPanel?.color.getHex()).toBe(0xf7f4ec);
    expect(umbraPanel?.color.getHex()).toBe(0x263342);
    expect(umbraPanel?.metalness).toBeGreaterThan(craterPanel?.metalness ?? 1);
    expect(umbraPanel?.envMapIntensity).toBeGreaterThan(craterPanel?.envMapIntensity ?? 2);
    expect(craterScreen?.emissive.getHex()).toBe(0x37cfc5);
    expect(umbraScreen?.emissive.getHex()).toBe(0x2a67d8);
  });

  it('only makes intentional glazing and painted floor overlays transparent', () => {
    const craterGroup = createBundle().group;
    const groups = [craterGroup, createUmbraBundle().group];
    for (const group of groups) {
      const transparentMaterials = new Set<string>();
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (material.transparent) transparentMaterials.add(material.name);
        }
      });

      expect([...transparentMaterials].sort()).toEqual([
        'architecture-floor-marking',
        'architecture-laminated-glass',
      ]);
    }
    const routeLine = findAuthoredMesh(craterGroup, 'aurora-interior-navigation-lane');
    const routeMaterial = routeLine?.material as THREE.Material | undefined;
    expect(routeMaterial?.polygonOffset).toBe(true);
    expect(routeMaterial?.polygonOffsetFactor).toBeLessThan(0);
  });

  it('disposes owned resources and is safe to dispose twice', () => {
    const bundle = createBundle();
    expect(bundle.group.children.length).toBeGreaterThan(0);
    expect(() => bundle.dispose()).not.toThrow();
    expect(bundle.group.children).toHaveLength(0);
    expect(() => bundle.dispose()).not.toThrow();
  });

  it('batches static detail into a browser-friendly render budget', () => {
    const groups = [createBundle().group, createUmbraBundle().group, createTitanBundle().group];
    for (const group of groups) {
      let renderables = 0;
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) renderables += 1;
      });
      expect(renderables).toBeLessThanOrEqual(60);
    }
  });

  it('dispatches Titan to minimal green-white field architecture', () => {
    const { group } = createTitanBundle();
    const architecture = group.getObjectByName('titan-expanse-field-architecture');
    const panel = findAuthoredMesh(group, 'titan-west-base-white-back-shell')
      ?.material as THREE.MeshPhysicalMaterial | undefined;

    expect(architecture).toBeInstanceOf(THREE.Group);
    expect(architecture?.userData.function).toBe('minimal-alpine-expedition-camps-and-towah-relay');
    expect(group.getObjectByName('titan-aurora-expedition-camp')).toBeInstanceOf(THREE.Group);
    expect(group.getObjectByName('titan-nova-expedition-camp')).toBeInstanceOf(THREE.Group);
    expect(findAuthoredMesh(group, 'titan-west-base-moss-green-canopy')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'titan-relay-slender-mast')).toBeInstanceOf(THREE.Mesh);
    expect(panel?.name).toBe('architecture-white-panel');
    expect(panel?.color.getHex()).toBe(0xe9eee2);
    expect(group.getObjectByName('observatory-relay-building')).toBeUndefined();
    expect(group.getObjectByName('umbra-station-architecture')).toBeUndefined();
  });

  it('dispatches Umbra to its own orbital-station architecture without Crater-only dependencies', () => {
    const { group } = createUmbraBundle();
    const station = group.getObjectByName('umbra-station-architecture');

    expect(station).toBeInstanceOf(THREE.Group);
    expect(station?.userData.hasInteriors).toBe(true);
    expect(station?.userData.function).toBe('orbital-communications-and-life-support-station');
    expect(group.getObjectByName('aurora-operations-building')).toBeUndefined();
    expect(findAuthoredMesh(group, 'umbra-aurora-main-airlock-header')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'umbra-nova-main-airlock-header')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'umbra-relay-primary-mast')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'umbra-relay-deep-space-dish')).toBeInstanceOf(THREE.Mesh);
    expect(findAuthoredMesh(group, 'umbra-annex-power-bus-west')).toBeInstanceOf(THREE.Mesh);
  });
});
