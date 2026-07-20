import { createNamedNavigationGraph } from '../navigationGraph';
import type { AabbObstacle, JumpPadZone, MapDefinition, Vec3 } from '../types';

export const TITAN_EXPANSE_BOUNDS = Object.freeze({
  minX: -104,
  maxX: 104,
  minZ: -84,
  maxZ: 84,
  floorY: 0,
  ceilingY: 30,
});

const COLORS = {
  aurora: 0x3e7f79,
  nova: 0x745f7f,
  timber: 0x5f5140,
  canopy: 0xb7c3a2,
  towah: 0x263f45,
  towahTrim: 0x87a79c,
  stone: 0x53665c,
  stoneLight: 0x718071,
  grove: 0x315c45,
} as const;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const smootherstep = (minimum: number, maximum: number, value: number): number => {
  const t = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

const corridorMask = (distance: number, halfWidth: number, shoulder: number): number =>
  smootherstep(halfWidth, halfWidth + shoulder, distance);

const clearingMask = (
  x: number,
  z: number,
  centerX: number,
  centerZ: number,
  radius: number,
  shoulder: number,
): number => corridorMask(Math.hypot(x - centerX, z - centerZ), radius, shoulder);

/** Shared by terrain and presentation so the water ribbon follows one curve. */
export const titanCreekCenterZ = (x: number): number =>
  43
  + 3.2 * Math.cos(x * Math.PI / 52)
  + 1.2 * Math.cos(x * Math.PI / 18);

/**
 * Deterministic highland relief. Wide, gently flattened bands form the three
 * main combat lanes; intervening shoulders rise into soft alpine ridges. The
 * formula is even in X so neither team inherits a terrain advantage.
 */
export const sampleTitanExpanseGroundHeight = (x: number, z: number): number => {
  const boundedX = clamp(x, TITAN_EXPANSE_BOUNDS.minX, TITAN_EXPANSE_BOUNDS.maxX);
  const boundedZ = clamp(z, TITAN_EXPANSE_BOUNDS.minZ, TITAN_EXPANSE_BOUNDS.maxZ);
  const absoluteX = Math.abs(boundedX);
  const absoluteZ = Math.abs(boundedZ);
  const creekZ = titanCreekCenterZ(boundedX);

  const rollingRelief = 0.7
    + 0.48 * (0.5 + 0.5 * Math.cos(absoluteX * 0.082))
    + 0.38 * (0.5 + 0.5 * Math.cos(boundedZ * 0.105 + Math.cos(absoluteX * 0.037)));
  const northCrown = 1.15
    * Math.exp(-(((boundedZ + 58) / 17) ** 2))
    * (0.72 + 0.28 * Math.cos(absoluteX * 0.068));
  const boundaryRise = 1.15 * smootherstep(67, 104, absoluteX)
    + 0.75 * smootherstep(61, 84, absoluteZ);

  // Multiplying smooth masks makes every authored route fully walkable while
  // allowing the ground between routes to retain several metres of relief.
  const routeMask = corridorMask(absoluteZ, 3.6, 9)
    * corridorMask(Math.abs(boundedZ + 42), 4.6, 9)
    * corridorMask(Math.abs(boundedZ + 64), 2.8, 7)
    * corridorMask(Math.abs(boundedZ - creekZ), 5.4, 9)
    * corridorMask(Math.abs(absoluteX - 76), 3.8, 8)
    * corridorMask(Math.abs(absoluteX - 56), 3.8, 8)
    * corridorMask(Math.abs(absoluteX - 28), 3.8, 8)
    * corridorMask(absoluteX, 3.8, 8);
  const clearing = clearingMask(boundedX, boundedZ, 0, 0, 20, 9)
    * clearingMask(boundedX, boundedZ, -84, 0, 15, 8)
    * clearingMask(boundedX, boundedZ, 84, 0, 15, 8);

  return Math.max(0, (rollingRelief + northCrown + boundaryRise) * routeMask * clearing);
};

const point = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const groundPoint = (x: number, z: number, offset = 0.05): Vec3 =>
  point(x, sampleTitanExpanseGroundHeight(x, z) + offset, z);

const box = (
  id: string,
  min: [number, number, number],
  max: [number, number, number],
  kind: AabbObstacle['kind'],
  color: number,
  render = true,
): AabbObstacle => ({
  id,
  min: point(...min),
  max: point(...max),
  kind,
  color,
  ...(render ? {} : { render: false }),
});

const terrainBox = (
  id: string,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  height: number,
  color: number,
): AabbObstacle => {
  const centerHeight = sampleTitanExpanseGroundHeight(x, z);
  const lowestCorner = Math.min(
    centerHeight,
    sampleTitanExpanseGroundHeight(x - halfX, z - halfZ),
    sampleTitanExpanseGroundHeight(x - halfX, z + halfZ),
    sampleTitanExpanseGroundHeight(x + halfX, z - halfZ),
    sampleTitanExpanseGroundHeight(x + halfX, z + halfZ),
  );
  return box(
    id,
    [x - halfX, lowestCorner - 1.2, z - halfZ],
    [x + halfX, centerHeight + height, z + halfZ],
    'cover',
    color,
  );
};

const mirroredTerrainBoxes = (
  label: string,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
  height: number,
  color: number,
): AabbObstacle[] => [
  terrainBox(`titan-west-${label}`, -x, z, halfX, halfZ, height, color),
  terrainBox(`titan-east-${label}`, x, z, halfX, halfZ, height, color),
];

interface TurretLayoutContract {
  platformTopOffset: number;
}

const createTitanNavigationGraph = () => {
  const creek = (x: number): Vec3 => groundPoint(x, titanCreekCenterZ(x));
  const nodes: Record<string, Vec3> = {
    westFlag: point(-84, 0.35, 0),
    westDoor: groundPoint(-75, 0),
    westCamp: groundPoint(-72, 0),
    eastCamp: groundPoint(72, 0),
    eastDoor: groundPoint(75, 0),
    eastFlag: point(84, 0.35, 0),

    westCenterOuter: groundPoint(-56, 0),
    westCenterMid: groundPoint(-28, 0),
    westPad: groundPoint(-16, 0),
    eastPad: groundPoint(16, 0),
    eastCenterMid: groundPoint(28, 0),
    eastCenterOuter: groundPoint(56, 0),

    westNorthEdge: groundPoint(-76, -42),
    westNorthOuter: groundPoint(-56, -42),
    westNorthMid: groundPoint(-28, -42),
    westNorthInner: groundPoint(-14, -42),
    northCenter: groundPoint(0, -42),
    eastNorthInner: groundPoint(14, -42),
    eastNorthMid: groundPoint(28, -42),
    eastNorthOuter: groundPoint(56, -42),
    eastNorthEdge: groundPoint(76, -42),

    westCreekEdge: creek(-76),
    westCreekOuter: creek(-56),
    westCreekMid: creek(-28),
    westCreekInner: creek(-14),
    creekCenter: creek(0),
    eastCreekInner: creek(14),
    eastCreekMid: creek(28),
    eastCreekOuter: creek(56),
    eastCreekEdge: creek(76),

    westNorthCampLink: groundPoint(-76, -21),
    westCreekCampLink: groundPoint(-76, 21),
    eastNorthCampLink: groundPoint(76, -21),
    eastCreekCampLink: groundPoint(76, 21),
    westNorthOuterLink: groundPoint(-56, -21),
    westCreekOuterLink: groundPoint(-56, 21),
    eastNorthOuterLink: groundPoint(56, -21),
    eastCreekOuterLink: groundPoint(56, 21),
    westNorthMidLink: groundPoint(-28, -21),
    westCreekMidLink: groundPoint(-28, 21),
    eastNorthMidLink: groundPoint(28, -21),
    eastCreekMidLink: groundPoint(28, 21),

    westNorthTowah: groundPoint(-12, -14),
    northTowah: groundPoint(0, -16),
    eastNorthTowah: groundPoint(12, -14),
    westSouthTowah: groundPoint(-12, 14),
    southTowah: groundPoint(0, 16),
    eastSouthTowah: groundPoint(12, 14),

    westNorthCrown: groundPoint(-56, -64),
    northCrown: groundPoint(0, -64),
    eastNorthCrown: groundPoint(56, -64),

    towerWest: point(-5.6, 6, 0),
    towerNorth: point(0, 6, -5.6),
    towerEast: point(5.6, 6, 0),
    towerSouth: point(0, 6, 5.6),
  };

  const walkEdges = [
    ['westFlag', 'westDoor'], ['westDoor', 'westCamp'],
    ['eastFlag', 'eastDoor'], ['eastDoor', 'eastCamp'],
    ['westCamp', 'westCenterOuter'], ['westCenterOuter', 'westCenterMid'], ['westCenterMid', 'westPad'],
    ['eastCamp', 'eastCenterOuter'], ['eastCenterOuter', 'eastCenterMid'], ['eastCenterMid', 'eastPad'],

    ['westNorthEdge', 'westNorthOuter'], ['westNorthOuter', 'westNorthMid'],
    ['westNorthMid', 'westNorthInner'], ['westNorthInner', 'northCenter'],
    ['northCenter', 'eastNorthInner'], ['eastNorthInner', 'eastNorthMid'],
    ['eastNorthMid', 'eastNorthOuter'], ['eastNorthOuter', 'eastNorthEdge'],
    ['westCreekEdge', 'westCreekOuter'], ['westCreekOuter', 'westCreekMid'],
    ['westCreekMid', 'westCreekInner'], ['westCreekInner', 'creekCenter'],
    ['creekCenter', 'eastCreekInner'], ['eastCreekInner', 'eastCreekMid'],
    ['eastCreekMid', 'eastCreekOuter'], ['eastCreekOuter', 'eastCreekEdge'],

    ['westCamp', 'westNorthCampLink'], ['westNorthCampLink', 'westNorthEdge'],
    ['westCamp', 'westCreekCampLink'], ['westCreekCampLink', 'westCreekEdge'],
    ['eastCamp', 'eastNorthCampLink'], ['eastNorthCampLink', 'eastNorthEdge'],
    ['eastCamp', 'eastCreekCampLink'], ['eastCreekCampLink', 'eastCreekEdge'],
    ['westCenterOuter', 'westNorthOuterLink'], ['westNorthOuterLink', 'westNorthOuter'],
    ['westCenterOuter', 'westCreekOuterLink'], ['westCreekOuterLink', 'westCreekOuter'],
    ['eastCenterOuter', 'eastNorthOuterLink'], ['eastNorthOuterLink', 'eastNorthOuter'],
    ['eastCenterOuter', 'eastCreekOuterLink'], ['eastCreekOuterLink', 'eastCreekOuter'],
    ['westCenterMid', 'westNorthMidLink'], ['westNorthMidLink', 'westNorthMid'],
    ['westCenterMid', 'westCreekMidLink'], ['westCreekMidLink', 'westCreekMid'],
    ['eastCenterMid', 'eastNorthMidLink'], ['eastNorthMidLink', 'eastNorthMid'],
    ['eastCenterMid', 'eastCreekMidLink'], ['eastCreekMidLink', 'eastCreekMid'],

    ['westPad', 'westNorthTowah'], ['westNorthTowah', 'northTowah'],
    ['eastPad', 'eastNorthTowah'], ['eastNorthTowah', 'northTowah'],
    ['northTowah', 'northCenter'],
    ['westPad', 'westSouthTowah'], ['westSouthTowah', 'southTowah'],
    ['eastPad', 'eastSouthTowah'], ['eastSouthTowah', 'southTowah'],
    ['southTowah', 'creekCenter'],

    ['westNorthOuter', 'westNorthCrown'], ['westNorthCrown', 'northCrown'],
    ['northCrown', 'eastNorthCrown'], ['eastNorthCrown', 'eastNorthOuter'],

    ['towerWest', 'towerNorth'], ['towerNorth', 'towerEast'],
    ['towerEast', 'towerSouth'], ['towerSouth', 'towerWest'],
  ] as const;
  const directedEdges = [
    ['westPad', 'towerWest', 'launch'],
    ['towerWest', 'westPad', 'drop'],
    ['eastPad', 'towerEast', 'launch'],
    ['towerEast', 'eastPad', 'drop'],
  ] as const;
  return createNamedNavigationGraph(nodes, walkEdges, directedEdges);
};

export const TITAN_EXPANSE_JUMP_PADS: JumpPadZone[] = [
  {
    id: 'titan-west-towah-pad',
    center: groundPoint(-16, 0, 0),
    halfSize: { x: 1.9, z: 2.6 },
    launchVelocity: point(6.3, 14.6, 0),
  },
  {
    id: 'titan-east-towah-pad',
    center: groundPoint(16, 0, 0),
    halfSize: { x: 1.9, z: 2.6 },
    launchVelocity: point(-6.3, 14.6, 0),
  },
];

/**
 * A broad alpine battlefield built around sightline choice rather than
 * corridors: the exposed north crown, command meadow, and sheltered creek
 * remain interlinked by mirrored natural clearings on both team halves.
 */
export const createTitanExpanse = (turretLayout: TurretLayoutContract): MapDefinition => {
  const navigation = createTitanNavigationGraph();
  const towerCenterY = 6.05;
  const creekPickup = (id: string, kind: 'weapon' | 'ammo' | 'grenade', x: number, weaponId?: 'shotgun') => ({
    id,
    kind,
    ...(weaponId ? { weaponId } : {}),
    position: groundPoint(x, titanCreekCenterZ(x), 0.46),
    respawnSeconds: kind === 'weapon' ? 35 : kind === 'grenade' ? 20 : 18,
  });

  return {
    id: 'titan-expanse',
    name: 'Extensión Titán',
    bounds: { ...TITAN_EXPANSE_BOUNDS },
    groundHeightAt: sampleTitanExpanseGroundHeight,
    preferNeutralSpawns: true,
    obstacles: [
      // Collision remains rectangular, but these walls are visually replaced
      // by distant cliff faces, treelines, and mist in the Titan renderer.
      box('titan-boundary-north', [-104, -4, -84.5], [104, 30, -84], 'wall', COLORS.stone, false),
      box('titan-boundary-south', [-104, -4, 84], [104, 30, 84.5], 'wall', COLORS.stone, false),
      box('titan-boundary-west', [-104.5, -4, -84], [-104, 30, 84], 'wall', COLORS.stone, false),
      box('titan-boundary-east', [104, -4, -84], [104.5, 30, 84], 'wall', COLORS.stone, false),

      // Compact expedition camps leave their inward faces open to the field.
      box('titan-west-base-floor', [-93, 0, -10], [-76, 0.3, 10], 'platform', COLORS.aurora),
      box('titan-west-base-back', [-94, 0, -11], [-91, 4.2, 11], 'wall', COLORS.timber),
      box('titan-west-base-north-wing', [-91, 0.3, -11], [-76, 3.15, -8.5], 'wall', COLORS.aurora),
      box('titan-west-base-south-wing', [-91, 0.3, 8.5], [-76, 3.15, 11], 'wall', COLORS.aurora),
      box('titan-west-base-roof', [-92, 4.05, -10.5], [-77, 4.35, 10.5], 'platform', COLORS.canopy),
      box('titan-east-base-floor', [76, 0, -10], [93, 0.3, 10], 'platform', COLORS.nova),
      box('titan-east-base-back', [91, 0, -11], [94, 4.2, 11], 'wall', COLORS.timber),
      box('titan-east-base-north-wing', [76, 0.3, -11], [91, 3.15, -8.5], 'wall', COLORS.nova),
      box('titan-east-base-south-wing', [76, 0.3, 8.5], [91, 3.15, 11], 'wall', COLORS.nova),
      box('titan-east-base-roof', [77, 4.05, -10.5], [92, 4.35, 10.5], 'platform', COLORS.canopy),

      // The only industrial silhouette is the small Towah relay in the vast meadow.
      box('tower-core', [-4.8, 0, -4.8], [4.8, 5.4, 4.8], 'tower', COLORS.towah),
      box('tower-deck', [-9, 5.4, -9], [9, 5.95, 9], 'platform', COLORS.towahTrim),
      box(
        'tower-cap',
        [-1.9, 5.95, -1.9],
        [1.9, towerCenterY + turretLayout.platformTopOffset, 1.9],
        'tower',
        COLORS.towah,
      ),
      box('tower-rail-n', [-9, 5.95, -9], [9, 6.72, -8.55], 'wall', COLORS.towah),
      box('tower-rail-s', [-9, 5.95, 8.55], [9, 6.72, 9], 'wall', COLORS.towah),
      box('tower-rail-w-n', [-9, 5.95, -9], [-8.55, 6.72, -2.6], 'wall', COLORS.towah),
      box('tower-rail-w-s', [-9, 5.95, 2.6], [-8.55, 6.72, 9], 'wall', COLORS.towah),
      box('tower-rail-e-n', [8.55, 5.95, -9], [9, 6.72, -2.6], 'wall', COLORS.towah),
      box('tower-rail-e-s', [8.55, 5.95, 2.6], [9, 6.72, 9], 'wall', COLORS.towah),

      ...mirroredTerrainBoxes('north-rim-outcrop-1', 90, -61, 5.4, 5.2, 4.8, COLORS.stone),
      ...mirroredTerrainBoxes('north-rim-outcrop-2', 70, -57, 4.3, 4.8, 3.8, COLORS.stoneLight),
      ...mirroredTerrainBoxes('north-rim-outcrop-3', 42, -54, 5.2, 4, 3.4, COLORS.stone),
      ...mirroredTerrainBoxes('north-rim-outcrop-4', 18, -53, 3.8, 4.4, 3.1, COLORS.stoneLight),
      ...mirroredTerrainBoxes('north-shoulder-outcrop-1', 66, -26, 4.2, 5.2, 3.2, COLORS.stone),
      ...mirroredTerrainBoxes('north-shoulder-outcrop-2', 43, -25, 4.6, 4.2, 2.8, COLORS.stoneLight),
      ...mirroredTerrainBoxes('north-shoulder-grove-1', 17, -28, 3.5, 5, 3.6, COLORS.grove),
      ...mirroredTerrainBoxes('south-shoulder-grove-1', 67, 27, 4.1, 5.2, 3.5, COLORS.grove),
      ...mirroredTerrainBoxes('south-shoulder-outcrop-1', 43, 26, 4.7, 4.4, 2.9, COLORS.stone),
      ...mirroredTerrainBoxes('south-shoulder-grove-2', 17, 29, 3.6, 4.8, 3.7, COLORS.grove),
      ...mirroredTerrainBoxes('creek-grove-1', 91, 63, 5.3, 5, 4.2, COLORS.grove),
      ...mirroredTerrainBoxes('creek-grove-2', 69, 65, 4.2, 5.1, 3.8, COLORS.grove),
      ...mirroredTerrainBoxes('creek-grove-3', 43, 62, 5, 4.4, 3.6, COLORS.grove),
      ...mirroredTerrainBoxes('creek-outcrop-1', 18, 64, 3.7, 4.5, 3, COLORS.stoneLight),
      ...mirroredTerrainBoxes('camp-screen-outcrop', 96, -25, 4.1, 6.2, 4.4, COLORS.stone),
      ...mirroredTerrainBoxes('camp-screen-grove', 96, 27, 4, 6, 4.5, COLORS.grove),
    ],
    spawns: [
      { position: point(-86, 0.35, 0), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-86, 0.35, -6), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-86, 0.35, 6), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-81, 0.35, -5.5), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-81, 0.35, 5.5), yaw: -Math.PI / 2, team: 'aurora' },
      { position: groundPoint(-72, -18), yaw: -Math.PI / 2, team: 'aurora' },
      { position: groundPoint(-72, 18), yaw: -Math.PI / 2, team: 'aurora' },
      { position: groundPoint(-68, 0), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(86, 0.35, 0), yaw: Math.PI / 2, team: 'nova' },
      { position: point(86, 0.35, -6), yaw: Math.PI / 2, team: 'nova' },
      { position: point(86, 0.35, 6), yaw: Math.PI / 2, team: 'nova' },
      { position: point(81, 0.35, -5.5), yaw: Math.PI / 2, team: 'nova' },
      { position: point(81, 0.35, 5.5), yaw: Math.PI / 2, team: 'nova' },
      { position: groundPoint(72, -18), yaw: Math.PI / 2, team: 'nova' },
      { position: groundPoint(72, 18), yaw: Math.PI / 2, team: 'nova' },
      { position: groundPoint(68, 0), yaw: Math.PI / 2, team: 'nova' },

      { position: groundPoint(-44, -9), yaw: -Math.PI / 2, team: 'neutral' },
      { position: groundPoint(44, -9), yaw: Math.PI / 2, team: 'neutral' },
      { position: groundPoint(-44, 9), yaw: -Math.PI / 2, team: 'neutral' },
      { position: groundPoint(44, 9), yaw: Math.PI / 2, team: 'neutral' },
      { position: groundPoint(-23, -20), yaw: -Math.PI / 2, team: 'neutral' },
      { position: groundPoint(23, -20), yaw: Math.PI / 2, team: 'neutral' },
      { position: groundPoint(-23, 20), yaw: -Math.PI / 2, team: 'neutral' },
      { position: groundPoint(23, 20), yaw: Math.PI / 2, team: 'neutral' },
      { position: groundPoint(0, -27), yaw: 0, team: 'neutral' },
      { position: groundPoint(0, 28), yaw: Math.PI, team: 'neutral' },
    ],
    waypoints: navigation.waypoints,
    waypointLinks: navigation.links,
    jumpPads: TITAN_EXPANSE_JUMP_PADS.map((pad) => ({ ...pad, center: { ...pad.center } })),
    pickups: [
      { id: 'titan-pickup-sniper', kind: 'weapon', weaponId: 'sniper', position: groundPoint(0, -64, 0.48), respawnSeconds: 50 },
      { id: 'titan-pickup-rocket', kind: 'weapon', weaponId: 'rocket-launcher', position: groundPoint(0, titanCreekCenterZ(0), 0.48), respawnSeconds: 60 },
      { id: 'titan-pickup-overshield', kind: 'overshield', position: point(0, 6.43, -5.8), respawnSeconds: 60 },
      { id: 'titan-pickup-battle-west', kind: 'weapon', weaponId: 'battle-rifle', position: groundPoint(-42, -42, 0.46), respawnSeconds: 30 },
      { id: 'titan-pickup-battle-east', kind: 'weapon', weaponId: 'battle-rifle', position: groundPoint(42, -42, 0.46), respawnSeconds: 30 },
      creekPickup('titan-pickup-shotgun-west', 'weapon', -42, 'shotgun'),
      creekPickup('titan-pickup-shotgun-east', 'weapon', 42, 'shotgun'),
      { id: 'titan-pickup-pulse-west', kind: 'weapon', weaponId: 'pulse-rifle', position: groundPoint(-58, 0, 0.46), respawnSeconds: 25 },
      { id: 'titan-pickup-pulse-east', kind: 'weapon', weaponId: 'pulse-rifle', position: groundPoint(58, 0, 0.46), respawnSeconds: 25 },
      { id: 'titan-pickup-ammo-north-west', kind: 'ammo', position: groundPoint(-72, -42, 0.46), respawnSeconds: 18 },
      { id: 'titan-pickup-ammo-north-east', kind: 'ammo', position: groundPoint(72, -42, 0.46), respawnSeconds: 18 },
      creekPickup('titan-pickup-ammo-creek-west', 'ammo', -72),
      creekPickup('titan-pickup-ammo-creek-east', 'ammo', 72),
      { id: 'titan-pickup-ammo-meadow-west', kind: 'ammo', position: groundPoint(-36, 0, 0.46), respawnSeconds: 18 },
      { id: 'titan-pickup-ammo-meadow-east', kind: 'ammo', position: groundPoint(36, 0, 0.46), respawnSeconds: 18 },
      { id: 'titan-pickup-grenade-north-west', kind: 'grenade', position: groundPoint(-28, -21, 0.46), respawnSeconds: 20 },
      { id: 'titan-pickup-grenade-north-east', kind: 'grenade', position: groundPoint(28, -21, 0.46), respawnSeconds: 20 },
      { id: 'titan-pickup-grenade-south-west', kind: 'grenade', position: groundPoint(-28, 21, 0.46), respawnSeconds: 20 },
      { id: 'titan-pickup-grenade-south-east', kind: 'grenade', position: groundPoint(28, 21, 0.46), respawnSeconds: 20 },
      { id: 'titan-pickup-grenade-camp-west', kind: 'grenade', position: groundPoint(-68, 0, 0.46), respawnSeconds: 20 },
      { id: 'titan-pickup-grenade-camp-east', kind: 'grenade', position: groundPoint(68, 0, 0.46), respawnSeconds: 20 },
    ],
    flagBases: {
      aurora: point(-84, 0.72, 0),
      nova: point(84, 0.72, 0),
    },
    towerCenter: point(0, towerCenterY, 0),
    towerZone: { radius: 7, controlMinY: 5.15, patrolRadius: 5.45 },
  };
};
