import { describe, expect, it } from 'vitest';

import { MAP_IDS as AUTHORED_MAP_IDS, type MapDefinition } from '../game/types';
import {
  getMapVisualProfile,
  type MapVisualProfile,
  type PracticalLightProfile,
} from './mapVisualProfile';

const MAP_IDS = AUTHORED_MAP_IDS satisfies readonly MapDefinition['id'][];

const expectDeeplyFrozen = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
};

const expectColor = (color: number): void => {
  expect(Number.isInteger(color)).toBe(true);
  expect(color).toBeGreaterThanOrEqual(0);
  expect(color).toBeLessThanOrEqual(0xffffff);
};

const expectLocalLight = (light: PracticalLightProfile): void => {
  expect(light.id.length).toBeGreaterThan(0);
  expect(light.position).toHaveLength(3);
  expectColor(light.color);
  expect(light.intensity).toBeGreaterThan(0);
  expect(light.distance).toBeGreaterThan(0);
  expect(light.decay).toBeGreaterThan(0);
  expect(light.castShadow).toBe(false);
  if (light.kind === 'spot') {
    expect(light.target).toHaveLength(3);
    expect(light.angle).toBeGreaterThan(0);
    expect(light.angle).toBeLessThan(Math.PI / 2);
    expect(light.penumbra).toBeGreaterThanOrEqual(0);
    expect(light.penumbra).toBeLessThanOrEqual(1);
  }
};

const expectCompleteProfile = (profile: MapVisualProfile): void => {
  expectColor(profile.backgroundColor);
  expectColor(profile.fog.color);
  expect(profile.fog.density).toBeGreaterThan(0);
  expect(profile.exposure).toBeGreaterThan(0);
  expect(profile.environmentIntensity).toBeGreaterThan(0);

  expectColor(profile.lighting.ambient.color);
  expect(profile.lighting.ambient.intensity).toBeGreaterThan(0);
  expectColor(profile.lighting.hemisphere.skyColor);
  expectColor(profile.lighting.hemisphere.groundColor);
  expect(profile.lighting.hemisphere.intensity).toBeGreaterThan(0);
  for (const directional of [profile.lighting.sun, profile.lighting.fill]) {
    expectColor(directional.color);
    expect(directional.direction).toHaveLength(3);
    expect(directional.intensity).toBeGreaterThan(0);
  }
  for (const local of [
    profile.lighting.centralTower,
    profile.lighting.teamBases.aurora,
    profile.lighting.teamBases.nova,
  ]) {
    expectColor(local.color);
    expect(local.intensity).toBeGreaterThan(0);
    expect(local.distance).toBeGreaterThan(0);
    expect(local.decay).toBeGreaterThan(0);
  }

  expect(profile.bloom.strength).toBeGreaterThan(0);
  expect(profile.bloom.radius).toBeGreaterThanOrEqual(0);
  expect(profile.bloom.radius).toBeLessThanOrEqual(1);
  expect(profile.bloom.threshold).toBeGreaterThanOrEqual(0);
  expect(profile.bloom.threshold).toBeLessThanOrEqual(1);
  for (const color of Object.values(profile.surfacePalette)) expectColor(color);
  for (const color of Object.values(profile.atmospherePalette)) expectColor(color);
  expect(profile.practicalLights.length).toBeGreaterThanOrEqual(4);
  for (const light of profile.practicalLights) expectLocalLight(light);
  expect(new Set(profile.practicalLights.map((light) => light.id)).size)
    .toBe(profile.practicalLights.length);
};

describe('map visual profiles', () => {
  it('defines a complete profile for every authored map', () => {
    for (const mapId of MAP_IDS) {
      const profile = getMapVisualProfile(mapId);
      expect(profile.mapId).toBe(mapId);
      expectCompleteProfile(profile);
    }
  });

  it('gives Crater and Umbra unmistakably different environmental treatments', () => {
    const crater = getMapVisualProfile('crater-ridge');
    const umbra = getMapVisualProfile('umbra-station');

    expect(crater.environmentKind).toBe('alien-forest');
    expect(umbra.environmentKind).toBe('orbital-station');
    expect(crater.backgroundColor).not.toBe(umbra.backgroundColor);
    expect(crater.fog).not.toEqual(umbra.fog);
    expect(crater.exposure).not.toBe(umbra.exposure);
    expect(crater.environmentIntensity).not.toBe(umbra.environmentIntensity);
    expect(crater.lighting).not.toEqual(umbra.lighting);
    expect(crater.bloom).not.toEqual(umbra.bloom);
    expect(crater.surfacePalette).not.toEqual(umbra.surfacePalette);
    expect(crater.atmospherePalette).not.toEqual(umbra.atmospherePalette);
  });

  it('dispatches Titan through its own cinematic alpine strategy', () => {
    const crater = getMapVisualProfile('crater-ridge');
    const umbra = getMapVisualProfile('umbra-station');
    const titan = getMapVisualProfile('titan-expanse');

    expect(titan.environmentKind).toBe('alpine-forest');
    expect(titan.environmentKind).not.toBe(crater.environmentKind);
    expect(titan.environmentKind).not.toBe(umbra.environmentKind);
    expect(titan.fog.density).toBeLessThan(crater.fog.density);
    expect(titan.lighting.sun.color).not.toBe(umbra.lighting.sun.color);
    expect(titan.surfacePalette.ground).not.toBe(crater.surfacePalette.ground);
  });

  it('gives Umbra enough ambient fill to keep its night-side routes readable', () => {
    const crater = getMapVisualProfile('crater-ridge');
    const umbra = getMapVisualProfile('umbra-station');

    expect(umbra.exposure).toBeGreaterThan(crater.exposure);
    expect(umbra.lighting.ambient.intensity).toBeGreaterThan(
      crater.lighting.ambient.intensity * 2,
    );
    expect(umbra.lighting.fill.intensity).toBeGreaterThan(crater.lighting.fill.intensity);
  });

  it('assigns practical lights to semantic landmarks instead of anonymous coordinates', () => {
    const craterZones = new Set(
      getMapVisualProfile('crater-ridge').practicalLights.map((light) => light.zone),
    );
    const umbraZones = new Set(
      getMapVisualProfile('umbra-station').practicalLights.map((light) => light.zone),
    );
    const titanZones = new Set(
      getMapVisualProfile('titan-expanse').practicalLights.map((light) => light.zone),
    );

    expect(craterZones).toEqual(new Set([
      'aurora-base',
      'nova-base',
      'north-observatory',
      'south-hydroponics',
    ]));
    expect(umbraZones).toEqual(new Set([
      'aurora-base',
      'nova-base',
      'north-signal-array',
      'south-power-annex',
      'upper-catwalk-ring',
    ]));
    expect(titanZones).toEqual(new Set([
      'west-expedition-camp',
      'east-expedition-camp',
      'titan-relay',
      'south-creek',
    ]));
  });

  it('returns stable deeply immutable profile objects', () => {
    for (const mapId of MAP_IDS) {
      const first = getMapVisualProfile(mapId);
      const second = getMapVisualProfile(mapId);
      expect(first).toBe(second);
      expectDeeplyFrozen(first);
    }
  });
});
