import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { CRATER_RIDGE } from '../game/map';
import { createBaseArchitecture, type BaseArchitectureBundle } from './baseArchitecture';

const bundles: BaseArchitectureBundle[] = [];

const createBundle = (quality: 'low' | 'high' = 'high'): BaseArchitectureBundle => {
  const bundle = createBaseArchitecture(CRATER_RIDGE, { quality, seed: 712 });
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

  it('disposes owned resources and is safe to dispose twice', () => {
    const bundle = createBundle();
    expect(bundle.group.children.length).toBeGreaterThan(0);
    expect(() => bundle.dispose()).not.toThrow();
    expect(bundle.group.children).toHaveLength(0);
    expect(() => bundle.dispose()).not.toThrow();
  });

  it('batches static detail into a browser-friendly render budget', () => {
    const { group } = createBundle();
    let renderables = 0;
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) renderables += 1;
    });
    expect(renderables).toBeLessThanOrEqual(60);
  });
});
