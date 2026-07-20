import type { MapDefinition } from '../game/types';

export type MapEnvironmentKind = 'alien-forest' | 'orbital-station' | 'alpine-forest';

export type VisualVector3 = readonly [x: number, y: number, z: number];

export interface FogVisualProfile {
  readonly color: number;
  readonly density: number;
}

export interface DirectionalLightVisualProfile {
  readonly color: number;
  /** Direction from the map origin toward the light source. */
  readonly direction: VisualVector3;
  readonly intensity: number;
}

export interface HemisphereLightVisualProfile {
  readonly skyColor: number;
  readonly groundColor: number;
  readonly intensity: number;
}

export interface AmbientLightVisualProfile {
  readonly color: number;
  readonly intensity: number;
}

export interface LocalLightVisualProfile {
  readonly color: number;
  readonly intensity: number;
  readonly distance: number;
  readonly decay: number;
}

export interface MapLightingProfile {
  readonly ambient: AmbientLightVisualProfile;
  readonly hemisphere: HemisphereLightVisualProfile;
  readonly sun: DirectionalLightVisualProfile;
  readonly fill: DirectionalLightVisualProfile;
  readonly centralTower: LocalLightVisualProfile;
  readonly teamBases: {
    readonly aurora: LocalLightVisualProfile;
    readonly nova: LocalLightVisualProfile;
  };
}

export interface BloomVisualProfile {
  readonly strength: number;
  readonly radius: number;
  readonly threshold: number;
}

/**
 * Shared material roles rather than map-specific object names. Keeping the
 * roles stable lets terrain, authored architecture and modular dressing use a
 * single coherent response without coupling this pure profile to Three.js.
 */
export interface MapSurfacePalette {
  readonly ground: number;
  readonly outerGround: number;
  readonly earthwork: number;
  readonly outcrop: number;
  readonly wetSurface: number;
  readonly panelLight: number;
  readonly panelMid: number;
  readonly panelDark: number;
  readonly structure: number;
  readonly glass: number;
  readonly neutralAccent: number;
  readonly auroraAccent: number;
  readonly novaAccent: number;
}

export interface MapAtmospherePalette {
  readonly haze: number;
  readonly motes: number;
  readonly boundaryField: number;
  readonly horizonGlow: number;
  readonly shadowTint: number;
  readonly highlightTint: number;
}

export type PracticalLightZone =
  | 'aurora-base'
  | 'nova-base'
  | 'central-tower'
  | 'north-observatory'
  | 'south-hydroponics'
  | 'north-signal-array'
  | 'south-power-annex'
  | 'upper-catwalk-ring'
  | 'west-expedition-camp'
  | 'east-expedition-camp'
  | 'titan-relay'
  | 'south-creek';

export type PracticalLightPurpose = 'interior' | 'orientation' | 'landmark';

interface PracticalLightBase {
  readonly id: string;
  readonly zone: PracticalLightZone;
  readonly purpose: PracticalLightPurpose;
  readonly position: VisualVector3;
  readonly color: number;
  readonly intensity: number;
  readonly distance: number;
  readonly decay: number;
  /** The sun remains the only shadow-casting world light. */
  readonly castShadow: false;
}

export interface PointPracticalLight extends PracticalLightBase {
  readonly kind: 'point';
}

export interface SpotPracticalLight extends PracticalLightBase {
  readonly kind: 'spot';
  readonly target: VisualVector3;
  readonly angle: number;
  readonly penumbra: number;
}

export type PracticalLightProfile = PointPracticalLight | SpotPracticalLight;

export interface MapVisualProfile {
  readonly mapId: MapDefinition['id'];
  readonly environmentKind: MapEnvironmentKind;
  readonly backgroundColor: number;
  readonly fog: FogVisualProfile;
  readonly exposure: number;
  readonly environmentIntensity: number;
  readonly lighting: MapLightingProfile;
  readonly bloom: BloomVisualProfile;
  readonly surfacePalette: MapSurfacePalette;
  readonly atmospherePalette: MapAtmospherePalette;
  readonly practicalLights: readonly PracticalLightProfile[];
}

const deepFreeze = <Value extends object>(value: Value): Value => {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
};

const MAP_VISUAL_PROFILES = deepFreeze({
  'crater-ridge': {
    mapId: 'crater-ridge',
    environmentKind: 'alien-forest',
    backgroundColor: 0x102832,
    fog: { color: 0x496c6b, density: 0.0065 },
    exposure: 1,
    environmentIntensity: 0.88,
    lighting: {
      ambient: { color: 0x304a43, intensity: 0.1 },
      hemisphere: { skyColor: 0x91c6c2, groundColor: 0x07110e, intensity: 0.42 },
      sun: {
        color: 0xffd49a,
        direction: [-0.52, 0.64, -0.56],
        intensity: 4.35,
      },
      fill: {
        color: 0x65a9bf,
        direction: [0.58, 0.42, 0.7],
        intensity: 0.24,
      },
      centralTower: { color: 0x68f2df, intensity: 19, distance: 18, decay: 2 },
      teamBases: {
        aurora: { color: 0x54edff, intensity: 13, distance: 14, decay: 2 },
        nova: { color: 0xff7186, intensity: 13, distance: 14, decay: 2 },
      },
    },
    bloom: { strength: 0.42, radius: 0.56, threshold: 0.92 },
    surfacePalette: {
      ground: 0x8ea77b,
      outerGround: 0x758c70,
      earthwork: 0x78906b,
      outcrop: 0x455b53,
      wetSurface: 0x143a36,
      panelLight: 0xf1eee5,
      panelMid: 0xaec5c1,
      panelDark: 0x101d22,
      structure: 0x081114,
      glass: 0x4d8290,
      neutralAccent: 0xb4ef3f,
      auroraAccent: 0x4fd9ed,
      novaAccent: 0xf45f7c,
    },
    atmospherePalette: {
      haze: 0x9fc8bd,
      motes: 0xffe5b8,
      boundaryField: 0x77d8d3,
      horizonGlow: 0xb5d9c8,
      shadowTint: 0x163238,
      highlightTint: 0xffd6a5,
    },
    practicalLights: [
      {
        id: 'crater-aurora-operations',
        kind: 'point',
        zone: 'aurora-base',
        purpose: 'interior',
        position: [-44.5, 3.35, 0],
        color: 0x6fe9ff,
        intensity: 7.5,
        distance: 11,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'crater-nova-operations',
        kind: 'point',
        zone: 'nova-base',
        purpose: 'interior',
        position: [44.5, 3.35, 0],
        color: 0xff7891,
        intensity: 7.5,
        distance: 11,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'crater-observatory-relay',
        kind: 'spot',
        zone: 'north-observatory',
        purpose: 'landmark',
        position: [0, 7.9, -33.4],
        target: [0, 0.2, -25],
        color: 0x79ddff,
        intensity: 10,
        distance: 22,
        decay: 2,
        angle: 0.62,
        penumbra: 0.72,
        castShadow: false,
      },
      {
        id: 'crater-hydroponics-lab',
        kind: 'point',
        zone: 'south-hydroponics',
        purpose: 'landmark',
        position: [0, 3.2, 32.4],
        color: 0xb7ff74,
        intensity: 8.5,
        distance: 14,
        decay: 2,
        castShadow: false,
      },
    ],
  },
  'umbra-station': {
    mapId: 'umbra-station',
    environmentKind: 'orbital-station',
    backgroundColor: 0x07111f,
    fog: { color: 0x172942, density: 0.00145 },
    exposure: 1.16,
    environmentIntensity: 1.18,
    lighting: {
      ambient: { color: 0x91afd0, intensity: 0.68 },
      hemisphere: { skyColor: 0xb8dcf7, groundColor: 0x26364d, intensity: 0.64 },
      sun: {
        color: 0xcbe4ff,
        direction: [-0.42, 0.7, -0.58],
        intensity: 2.55,
      },
      fill: {
        color: 0x8799d8,
        direction: [0.64, 0.28, 0.72],
        intensity: 0.84,
      },
      centralTower: { color: 0x7feeff, intensity: 20, distance: 19, decay: 2 },
      teamBases: {
        aurora: { color: 0x62e6ff, intensity: 15, distance: 15, decay: 2 },
        nova: { color: 0xff698d, intensity: 15, distance: 15, decay: 2 },
      },
    },
    bloom: { strength: 0.48, radius: 0.58, threshold: 0.92 },
    surfacePalette: {
      ground: 0x31475b,
      outerGround: 0x121e2d,
      earthwork: 0x586b72,
      outcrop: 0x435a63,
      wetSurface: 0x1d3850,
      panelLight: 0xc9d9e2,
      panelMid: 0x526b80,
      panelDark: 0x1c2a3a,
      structure: 0x14202d,
      glass: 0x5b91ad,
      neutralAccent: 0x8cf4ff,
      auroraAccent: 0x57e7ff,
      novaAccent: 0xff638b,
    },
    atmospherePalette: {
      haze: 0x668bb7,
      motes: 0xc1e9ff,
      boundaryField: 0x71e8ff,
      horizonGlow: 0x7866ad,
      shadowTint: 0x263a57,
      highlightTint: 0xc4e7ff,
    },
    practicalLights: [
      {
        id: 'umbra-aurora-habitat',
        kind: 'point',
        zone: 'aurora-base',
        purpose: 'interior',
        position: [-31.2, 3.3, 0],
        color: 0x5ce5ff,
        intensity: 11,
        distance: 12,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'umbra-nova-habitat',
        kind: 'point',
        zone: 'nova-base',
        purpose: 'interior',
        position: [31.2, 3.3, 0],
        color: 0xff6589,
        intensity: 11,
        distance: 12,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'umbra-signal-array',
        kind: 'spot',
        zone: 'north-signal-array',
        purpose: 'landmark',
        position: [0, 12.2, -22.8],
        target: [0, 2.8, -14],
        color: 0x6eeeff,
        intensity: 15,
        distance: 25,
        decay: 2,
        angle: 0.5,
        penumbra: 0.68,
        castShadow: false,
      },
      {
        id: 'umbra-power-annex',
        kind: 'point',
        zone: 'south-power-annex',
        purpose: 'landmark',
        position: [0, 3.9, 19.2],
        color: 0xffa14f,
        intensity: 14,
        distance: 17,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'umbra-upper-ring',
        kind: 'point',
        zone: 'upper-catwalk-ring',
        purpose: 'orientation',
        position: [0, 6.7, 0],
        color: 0x8d72ff,
        intensity: 7.5,
        distance: 21,
        decay: 2,
        castShadow: false,
      },
    ],
  },
  'titan-expanse': {
    mapId: 'titan-expanse',
    environmentKind: 'alpine-forest',
    backgroundColor: 0x4f91a8,
    fog: { color: 0x4f838d, density: 0.0029 },
    exposure: 1.08,
    environmentIntensity: 0.65,
    lighting: {
      ambient: { color: 0x7d9e9c, intensity: 0.15 },
      hemisphere: { skyColor: 0xb8dfe5, groundColor: 0x315b40, intensity: 0.82 },
      sun: {
        color: 0xffddb0,
        direction: [-0.48, 0.61, -0.63],
        intensity: 2.3,
      },
      fill: {
        color: 0x6eb5c3,
        direction: [0.66, 0.36, 0.58],
        intensity: 0.42,
      },
      centralTower: { color: 0x9fe8d4, intensity: 12, distance: 18, decay: 2 },
      teamBases: {
        aurora: { color: 0x75e1e3, intensity: 9.5, distance: 13, decay: 2 },
        nova: { color: 0xf58aa7, intensity: 9.5, distance: 13, decay: 2 },
      },
    },
    bloom: { strength: 0.42, radius: 0.52, threshold: 0.88 },
    surfacePalette: {
      ground: 0x6f875c,
      outerGround: 0x455d4d,
      earthwork: 0x62734d,
      outcrop: 0x50635b,
      wetSurface: 0x17464a,
      panelLight: 0xf2f2e7,
      panelMid: 0x83a27d,
      panelDark: 0x172821,
      structure: 0x17312d,
      glass: 0x79aeb0,
      neutralAccent: 0xa7cb72,
      auroraAccent: 0x55cbd0,
      novaAccent: 0xe47b96,
    },
    atmospherePalette: {
      haze: 0x75aaa5,
      motes: 0xffe7b8,
      boundaryField: 0x8ac9bd,
      horizonGlow: 0xe0dbbd,
      shadowTint: 0x183d43,
      highlightTint: 0xffd7a4,
    },
    practicalLights: [
      {
        id: 'titan-west-field-camp',
        kind: 'point',
        zone: 'west-expedition-camp',
        purpose: 'interior',
        position: [-84, 3.2, 0],
        color: 0x76e4df,
        intensity: 6.5,
        distance: 10,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'titan-east-field-camp',
        kind: 'point',
        zone: 'east-expedition-camp',
        purpose: 'interior',
        position: [84, 3.2, 0],
        color: 0xf194a9,
        intensity: 6.5,
        distance: 10,
        decay: 2,
        castShadow: false,
      },
      {
        id: 'titan-central-relay',
        kind: 'spot',
        zone: 'titan-relay',
        purpose: 'landmark',
        position: [0, 12.5, 0],
        target: [0, 1, -11],
        color: 0xa9f2da,
        intensity: 8.5,
        distance: 22,
        decay: 2,
        angle: 0.52,
        penumbra: 0.8,
        castShadow: false,
      },
      {
        id: 'titan-south-creek-beacon',
        kind: 'point',
        zone: 'south-creek',
        purpose: 'orientation',
        position: [0, 2.2, 47.4],
        color: 0x7bc5b8,
        intensity: 3.4,
        distance: 9,
        decay: 2,
        castShadow: false,
      },
    ],
  },
} satisfies Record<MapDefinition['id'], MapVisualProfile>);

/** Returns the shared, deeply frozen visual contract for an authored map. */
export const getMapVisualProfile = (mapId: MapDefinition['id']): MapVisualProfile =>
  MAP_VISUAL_PROFILES[mapId];
