import { createNamedNavigationGraph } from '../navigationGraph';
import type { AabbObstacle, JumpPadZone, MapDefinition, Vec3 } from '../types';

const box = (
  id: string,
  min: [number, number, number],
  max: [number, number, number],
  kind: AabbObstacle['kind'],
  color: number,
): AabbObstacle => ({
  id,
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
  kind,
  color,
});

const point = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

const COLORS = {
  boundary: 0x294b55,
  boundaryDark: 0x172d38,
  ceramic: 0xe6ebe5,
  ceramicBlue: 0xaecbd2,
  ceramicSage: 0xc4d6ce,
  graphite: 0x142a34,
  aurora: 0x4f9bb1,
  nova: 0xaa6577,
  earth: 0x46685e,
  rock: 0x405450,
} as const;

const stairFlightX = (
  prefix: string,
  startX: number,
  direction: -1 | 1,
  zCenter: number,
  baseY: number,
  steps: number,
  run: number,
  rise: number,
  width: number,
  color: number,
): AabbObstacle[] => Array.from({ length: steps }, (_, index) => {
  const firstX = startX + direction * index * run;
  const secondX = startX + direction * (index + 1) * run;
  return box(
    `${prefix}-${index + 1}`,
    [Math.min(firstX, secondX), baseY, zCenter - width * 0.5],
    [Math.max(firstX, secondX), baseY + rise * (index + 1), zCenter + width * 0.5],
    'platform',
    color,
  );
});

const stairFlightZ = (
  prefix: string,
  xCenter: number,
  startZ: number,
  direction: -1 | 1,
  baseY: number,
  steps: number,
  run: number,
  rise: number,
  width: number,
  color: number,
): AabbObstacle[] => Array.from({ length: steps }, (_, index) => {
  const firstZ = startZ + direction * index * run;
  const secondZ = startZ + direction * (index + 1) * run;
  return box(
    `${prefix}-${index + 1}`,
    [xCenter - width * 0.5, baseY, Math.min(firstZ, secondZ)],
    [xCenter + width * 0.5, baseY + rise * (index + 1), Math.max(firstZ, secondZ)],
    'platform',
    color,
  );
});

interface TurretLayoutContract {
  platformTopOffset: number;
}

/**
 * A deliberately authored navigation graph. The arena has three stacked
 * combat bands, so relying on sight alone would make a bot run into the floor
 * below a visible pickup. Named edges encode doors, stair flights, bridges and
 * the two physical jump-pad arcs.
 */
const createUmbraNavigationGraph = () => {
  const nodes: Record<string, Vec3> = {
    westFlag: point(-32.2, 0.37, 0),
    westDoor: point(-25.2, 0.05, 0),
    westNorthGround: point(-25, 0.05, -18),
    westSouthGround: point(-23, 0.05, 16),
    westMidGround: point(-16, 0.05, 0),
    westPad: point(-11.8, 0.05, 0),
    northWestGround: point(-11, 0.05, -21),
    northUnder: point(0, 0.05, -18.5),
    northEastGround: point(11, 0.05, -21),
    eastPad: point(11.8, 0.05, 0),
    eastMidGround: point(16, 0.05, 0),
    eastNorthGround: point(25, 0.05, -18),
    eastSouthGround: point(23, 0.05, 16),
    eastDoor: point(25.2, 0.05, 0),
    eastFlag: point(32.2, 0.37, 0),
    southWestGround: point(-11, 0.05, 21),
    southUnder: point(0, 0.23, 19),
    southEastGround: point(11, 0.05, 21),
    westBaseStairBottom: point(-24.45, 0.42, -15),
    westBaseStairMid: point(-21.15, 1.54, -15),
    westBaseUpper: point(-16.75, 2.99, -14.2),
    westBaseStairCorner: point(-17.4, 2.99, -11.65),
    westUpperCenter: point(-32.2, 2.99, 0),
    westNorthDoor: point(-31.1, 2.99, -10.7),
    westNorthDoorCorner: point(-29.65, 2.99, -11.55),
    westNorthBridge: point(-20, 2.99, -11.5),
    northWestCorner: point(-8.75, 2.99, -12.15),
    northWestEntry: point(-7.2, 2.99, -12.15),
    northWestMid: point(-2.8, 2.99, -12.4),
    northStairApproach: point(0, 2.99, -12.4),
    northEastMid: point(2.8, 2.99, -12.4),
    northStairLow: point(0, 3.37, -13.7),
    northStairMid: point(0, 4.51, -16.7),
    northStairHigh: point(0, 5.65, -19.7),
    northStairTop: point(0, 6.79, -22.5),
    northRoof: point(3, 6.8, -21.5),
    northRoofFront: point(2.5, 6.8, -14.4),
    northBridgeLanding: point(0, 6.38, -13.85),
    northSkybridge: point(0, 6.02, -10.8),
    towerNorth: point(0, 6, -6.2),
    towerWest: point(-6.2, 6, 0),
    towerSouth: point(0, 6, 6.2),
    towerEast: point(6.2, 6, 0),
    westSouthDoor: point(-31.1, 2.99, 10.7),
    westSouthDoorCorner: point(-29.65, 2.99, 11.55),
    westSouthBridge: point(-20, 2.99, 11.5),
    southWestCorner: point(-8.75, 2.99, 12.15),
    southWestEntry: point(-7.2, 2.99, 14.5),
    southWestMid: point(-3.1, 2.99, 16.2),
    southWestRear: point(-2.05, 2.99, 19.75),
    southStairApproach: point(0, 2.99, 19.75),
    southEastRear: point(2.05, 2.99, 19.75),
    southEastMid: point(3.1, 2.99, 16.2),
    southStairLow: point(0, 3.37, 18.7),
    southStairMid: point(0, 4.13, 16.7),
    southStairHigh: point(0, 5.27, 13.7),
    southRoofFront: point(2.3, 5.52, 14.45),
    southRoof: point(3, 5.52, 17),
    southSkybridge: point(0, 5.66, 10.7),
    eastBaseStairBottom: point(24.45, 0.42, -15),
    eastBaseStairMid: point(21.15, 1.54, -15),
    eastBaseUpper: point(16.75, 2.99, -14.2),
    eastBaseStairCorner: point(17.4, 2.99, -11.65),
    eastUpperCenter: point(32.2, 2.99, 0),
    eastNorthDoor: point(31.1, 2.99, -10.7),
    eastNorthDoorCorner: point(29.65, 2.99, -11.55),
    eastNorthBridge: point(20, 2.99, -11.5),
    northEastCorner: point(8.75, 2.99, -12.15),
    northEastEntry: point(7.2, 2.99, -12.15),
    eastSouthDoor: point(31.1, 2.99, 10.7),
    eastSouthDoorCorner: point(29.65, 2.99, 11.55),
    eastSouthBridge: point(20, 2.99, 11.5),
    southEastCorner: point(8.75, 2.99, 12.15),
    southEastEntry: point(7.2, 2.99, 14.5),
    southGroundWestCorner: point(-8.8, 0.05, 12.2),
    southGroundFront: point(0, 0.05, 12.2),
    southGroundInside: point(0, 0.23, 15),
    southGroundEastCorner: point(8.8, 0.05, 12.2),
  };
  const edges: Array<readonly [string, string]> = [
    ['westFlag', 'westDoor'],
    ['westDoor', 'westNorthGround'], ['westDoor', 'westSouthGround'], ['westDoor', 'westMidGround'],
    ['westNorthGround', 'northWestGround'], ['westNorthGround', 'westBaseStairBottom'], ['westSouthGround', 'southWestGround'],
    ['westMidGround', 'westPad'], ['westMidGround', 'northWestGround'], ['westMidGround', 'southWestGround'],
    ['northWestGround', 'northUnder'], ['northUnder', 'northEastGround'],
    ['northEastGround', 'eastNorthGround'],
    ['southWestGround', 'southGroundWestCorner'], ['southGroundWestCorner', 'southGroundFront'],
    ['southGroundFront', 'southGroundInside'], ['southGroundInside', 'southUnder'],
    ['southGroundFront', 'southGroundEastCorner'], ['southGroundEastCorner', 'southEastGround'],
    ['southEastGround', 'eastSouthGround'],
    ['northEastGround', 'eastMidGround'], ['southEastGround', 'eastMidGround'],
    ['eastMidGround', 'eastPad'], ['eastMidGround', 'eastDoor'],
    ['eastDoor', 'eastNorthGround'], ['eastDoor', 'eastSouthGround'], ['eastDoor', 'eastFlag'],
    ['westBaseStairBottom', 'westBaseStairMid'], ['westBaseStairMid', 'westBaseUpper'],
    ['westBaseUpper', 'westBaseStairCorner'], ['westBaseStairCorner', 'westNorthBridge'],
    ['westUpperCenter', 'westNorthDoor'], ['westUpperCenter', 'westSouthDoor'],
    ['westNorthDoor', 'westNorthDoorCorner'], ['westNorthDoorCorner', 'westNorthBridge'],
    ['westNorthBridge', 'northWestCorner'], ['northWestCorner', 'northWestEntry'],
    ['northWestEntry', 'northWestMid'], ['northWestMid', 'northStairApproach'],
    ['northStairApproach', 'northStairLow'], ['northStairApproach', 'northEastMid'],
    ['northEastMid', 'northEastEntry'],
    ['northEastEntry', 'northEastCorner'], ['northEastCorner', 'eastNorthBridge'],
    ['eastNorthBridge', 'eastNorthDoorCorner'], ['eastNorthDoorCorner', 'eastNorthDoor'],
    ['northStairLow', 'northStairMid'],
    ['northStairMid', 'northStairHigh'], ['northStairHigh', 'northStairTop'], ['northStairTop', 'northRoof'],
    ['northRoof', 'northRoofFront'], ['northRoofFront', 'northBridgeLanding'],
    ['northBridgeLanding', 'northSkybridge'], ['northSkybridge', 'towerNorth'],
    ['westSouthDoor', 'westSouthDoorCorner'], ['westSouthDoorCorner', 'westSouthBridge'],
    ['westSouthBridge', 'southWestCorner'], ['southWestCorner', 'southWestEntry'],
    ['southWestEntry', 'southWestMid'], ['southWestMid', 'southWestRear'],
    ['southWestRear', 'southStairApproach'], ['southStairApproach', 'southStairLow'],
    ['southStairApproach', 'southEastRear'],
    ['southEastRear', 'southEastMid'], ['southEastMid', 'southEastEntry'],
    ['southEastEntry', 'southEastCorner'], ['southEastCorner', 'eastSouthBridge'],
    ['eastSouthBridge', 'eastSouthDoorCorner'], ['eastSouthDoorCorner', 'eastSouthDoor'],
    ['southStairLow', 'southStairMid'],
    ['southStairMid', 'southStairHigh'], ['southStairHigh', 'southRoofFront'],
    ['southRoofFront', 'southRoof'], ['southStairHigh', 'southSkybridge'], ['southSkybridge', 'towerSouth'],
    ['eastNorthGround', 'eastBaseStairBottom'], ['eastBaseStairBottom', 'eastBaseStairMid'],
    ['eastBaseStairMid', 'eastBaseUpper'], ['eastBaseUpper', 'eastBaseStairCorner'],
    ['eastBaseStairCorner', 'eastNorthBridge'],
    ['eastUpperCenter', 'eastNorthDoor'], ['eastUpperCenter', 'eastSouthDoor'],
    ['towerWest', 'towerNorth'], ['towerNorth', 'towerEast'],
    ['towerEast', 'towerSouth'], ['towerSouth', 'towerWest'],
  ];
  const directedEdges = [
    ['westPad', 'towerWest', 'launch'],
    ['towerWest', 'westPad', 'drop'],
    ['eastPad', 'towerEast', 'launch'],
    ['towerEast', 'eastPad', 'drop'],
  ] as const;
  return createNamedNavigationGraph(nodes, edges, directedEdges);
};

export const UMBRA_STATION_JUMP_PADS: JumpPadZone[] = [
  {
    id: 'umbra-west-grav-lift',
    center: point(-11.8, 0, 0),
    halfSize: { x: 1.65, z: 2.35 },
    launchVelocity: point(5.4, 14.4, 0),
  },
  {
    id: 'umbra-east-grav-lift',
    center: point(11.8, 0, 0),
    halfSize: { x: 1.65, z: 2.35 },
    launchVelocity: point(-5.4, 14.4, 0),
  },
];

/**
 * Compact, vertical arena inspired by the spatial lessons of classic orbital
 * arenas: every strong height has at least two approaches, exposed bridges
 * trade safety for speed, and a complete ground loop remains available to a
 * flag carrier. The layout and fiction are original to Astral Arena.
 */
export const createUmbraStation = (turretLayout: TurretLayoutContract): MapDefinition => {
  const navigation = createUmbraNavigationGraph();
  const towerCenterY = 6.05;
  return {
    id: 'umbra-station',
    name: 'Estación Umbra',
    bounds: { minX: -38, maxX: 38, minZ: -32, maxZ: 32, floorY: 0, ceilingY: 28 },
    obstacles: [
      // A suspended research station protected by low alloy parapets and a
      // translucent containment field rendered above them.
      box('umbra-north-wall', [-38, 0, -33], [38, 8.5, -32], 'wall', COLORS.boundary),
      box('umbra-south-wall', [-38, 0, 32], [38, 8.5, 33], 'wall', COLORS.boundary),
      box('umbra-west-wall', [-39, 0, -32], [-38, 8.5, 32], 'wall', COLORS.boundaryDark),
      box('umbra-east-wall', [38, 0, -32], [39, 8.5, 32], 'wall', COLORS.boundaryDark),

      // Central communications mast and Towah objective. North and south rails
      // deliberately leave bridge-width gaps instead of sealing the deck.
      box('tower-core', [-4.4, 0, -4.4], [4.4, 5.4, 4.4], 'tower', COLORS.graphite),
      box('tower-deck', [-8.5, 5.4, -8.5], [8.5, 5.95, 8.5], 'platform', COLORS.ceramicBlue),
      box('tower-cap', [-1.9, 5.95, -1.9], [1.9, towerCenterY + turretLayout.platformTopOffset, 1.9], 'cover', COLORS.graphite),
      box('tower-rail-n-west', [-8.5, 5.95, -8.5], [-2.35, 6.72, -8.04], 'cover', COLORS.ceramic),
      box('tower-rail-n-east', [2.35, 5.95, -8.5], [8.5, 6.72, -8.04], 'cover', COLORS.ceramic),
      box('tower-rail-s-west', [-8.5, 5.95, 8.04], [-2.35, 6.72, 8.5], 'cover', COLORS.ceramic),
      box('tower-rail-s-east', [2.35, 5.95, 8.04], [8.5, 6.72, 8.5], 'cover', COLORS.ceramic),
      box('tower-rail-w-north', [-8.5, 5.95, -8.04], [-8.04, 6.72, -1.45], 'cover', COLORS.ceramic),
      box('tower-rail-w-south', [-8.5, 5.95, 1.45], [-8.04, 6.72, 8.04], 'cover', COLORS.ceramic),
      box('tower-rail-e-north', [8.04, 5.95, -8.04], [8.5, 6.72, -1.45], 'cover', COLORS.ceramic),
      box('tower-rail-e-south', [8.04, 5.95, 1.45], [8.5, 6.72, 8.04], 'cover', COLORS.ceramic),
      box('tower-screen-n-west', [-3.9, 5.95, -7.75], [-2.35, 7.18, -7.42], 'cover', COLORS.aurora),
      box('tower-screen-n-east', [2.35, 5.95, -7.75], [3.9, 7.18, -7.42], 'cover', COLORS.aurora),
      box('tower-screen-s-west', [-3.9, 5.95, 7.42], [-2.35, 7.18, 7.75], 'cover', COLORS.nova),
      box('tower-screen-s-east', [2.35, 5.95, 7.42], [3.9, 7.18, 7.75], 'cover', COLORS.nova),

      // Mirrored habitation/flag rooms. Wide inward airlocks serve the ground
      // route; the internal stair reaches a mezzanine with separate north and
      // south pressure doors onto the exposed upper circuit.
      box('umbra-west-base-floor', [-35.2, 0, -10.8], [-26.2, 0.32, 10.8], 'platform', COLORS.aurora),
      box('umbra-west-base-back', [-35.8, 0.32, -10.8], [-35.2, 5.4, 10.8], 'cover', COLORS.graphite),
      box('umbra-west-base-front-n', [-26.8, 0.32, -10.2], [-26.2, 5.4, -3.7], 'cover', COLORS.ceramic),
      box('umbra-west-base-front-s', [-26.8, 0.32, 3.7], [-26.2, 5.4, 10.2], 'cover', COLORS.ceramic),
      box('umbra-west-base-lintel', [-26.8, 4.0, -3.7], [-26.2, 5.4, 3.7], 'cover', COLORS.graphite),
      box('umbra-west-base-north-back', [-35.2, 0.32, -10.8], [-32.8, 5.4, -10.2], 'cover', COLORS.ceramicBlue),
      box('umbra-west-base-north-front', [-29.4, 0.32, -10.8], [-26.2, 5.4, -10.2], 'cover', COLORS.ceramicBlue),
      box('umbra-west-base-north-lintel', [-32.8, 4.85, -10.8], [-29.4, 5.4, -10.2], 'cover', COLORS.graphite),
      box('umbra-west-base-south-back', [-35.2, 0.32, 10.2], [-32.8, 5.4, 10.8], 'cover', COLORS.ceramicSage),
      box('umbra-west-base-south-front', [-29.4, 0.32, 10.2], [-26.2, 5.4, 10.8], 'cover', COLORS.ceramicSage),
      box('umbra-west-base-south-lintel', [-32.8, 4.85, 10.2], [-29.4, 5.4, 10.8], 'cover', COLORS.graphite),
      box('umbra-west-base-roof', [-35.2, 5.4, -10.2], [-26.2, 5.75, 10.2], 'platform', COLORS.ceramicBlue),
      box('umbra-west-base-balcony', [-35, 2.65, -8.5], [-29.15, 2.95, 8.5], 'platform', COLORS.ceramic),
      box('umbra-west-base-upper-landing-n', [-32.8, 2.65, -10.2], [-29.4, 2.95, -8.5], 'platform', COLORS.aurora),
      box('umbra-west-base-upper-landing-s', [-32.8, 2.65, 8.5], [-29.4, 2.95, 10.2], 'platform', COLORS.aurora),
      ...stairFlightX('umbra-west-base-stair', -25, 1, -15, 0, 7, 1.1, 0.375, 2.6, COLORS.ceramicBlue),
      box('umbra-west-base-stair-landing', [-17.3, 2.625, -15.5], [-16.2, 2.95, -13.02], 'platform', COLORS.aurora),
      box('umbra-west-base-crate-a', [-33.8, 0.32, -4.9], [-31.9, 1.55, -3], 'cover', COLORS.aurora),
      box('umbra-west-base-crate-b', [-33.8, 0.32, 3], [-31.9, 1.55, 4.9], 'cover', COLORS.aurora),

      box('umbra-east-base-floor', [26.2, 0, -10.8], [35.2, 0.32, 10.8], 'platform', COLORS.nova),
      box('umbra-east-base-back', [35.2, 0.32, -10.8], [35.8, 5.4, 10.8], 'cover', COLORS.graphite),
      box('umbra-east-base-front-n', [26.2, 0.32, -10.2], [26.8, 5.4, -3.7], 'cover', COLORS.ceramic),
      box('umbra-east-base-front-s', [26.2, 0.32, 3.7], [26.8, 5.4, 10.2], 'cover', COLORS.ceramic),
      box('umbra-east-base-lintel', [26.2, 4.0, -3.7], [26.8, 5.4, 3.7], 'cover', COLORS.graphite),
      box('umbra-east-base-north-front', [26.2, 0.32, -10.8], [29.4, 5.4, -10.2], 'cover', COLORS.ceramicBlue),
      box('umbra-east-base-north-back', [32.8, 0.32, -10.8], [35.2, 5.4, -10.2], 'cover', COLORS.ceramicBlue),
      box('umbra-east-base-north-lintel', [29.4, 4.85, -10.8], [32.8, 5.4, -10.2], 'cover', COLORS.graphite),
      box('umbra-east-base-south-front', [26.2, 0.32, 10.2], [29.4, 5.4, 10.8], 'cover', COLORS.ceramicSage),
      box('umbra-east-base-south-back', [32.8, 0.32, 10.2], [35.2, 5.4, 10.8], 'cover', COLORS.ceramicSage),
      box('umbra-east-base-south-lintel', [29.4, 4.85, 10.2], [32.8, 5.4, 10.8], 'cover', COLORS.graphite),
      box('umbra-east-base-roof', [26.2, 5.4, -10.2], [35.2, 5.75, 10.2], 'platform', COLORS.ceramicBlue),
      box('umbra-east-base-balcony', [29.15, 2.65, -8.5], [35, 2.95, 8.5], 'platform', COLORS.ceramic),
      box('umbra-east-base-upper-landing-n', [29.4, 2.65, -10.2], [32.8, 2.95, -8.5], 'platform', COLORS.nova),
      box('umbra-east-base-upper-landing-s', [29.4, 2.65, 8.5], [32.8, 2.95, 10.2], 'platform', COLORS.nova),
      ...stairFlightX('umbra-east-base-stair', 25, -1, -15, 0, 7, 1.1, 0.375, 2.6, COLORS.ceramicBlue),
      box('umbra-east-base-stair-landing', [16.2, 2.625, -15.5], [17.3, 2.95, -13.02], 'platform', COLORS.nova),
      box('umbra-east-base-crate-a', [31.9, 0.32, -4.9], [33.8, 1.55, -3], 'cover', COLORS.nova),
      box('umbra-east-base-crate-b', [31.9, 0.32, 3], [33.8, 1.55, 4.9], 'cover', COLORS.nova),

      // Exposed upper ring. It is faster than the ground loop but its waist-high
      // rails still leave players readable from both central and outer lanes.
      box('umbra-west-north-catwalk', [-31.6, 2.65, -13.4], [-8, 2.95, -10.2], 'platform', COLORS.ceramicBlue),
      box('umbra-west-north-catwalk-outer-rail-a', [-31.6, 2.95, -13.4], [-19, 3.72, -13.02], 'cover', COLORS.graphite),
      box('umbra-west-north-catwalk-outer-rail-b', [-16, 2.95, -13.4], [-10.7, 3.72, -13.02], 'cover', COLORS.graphite),
      box('umbra-west-north-catwalk-inner-rail-a', [-28.8, 2.95, -10.58], [-18.2, 3.72, -10.2], 'cover', COLORS.graphite),
      box('umbra-west-north-catwalk-inner-rail-b', [-15.5, 2.95, -10.58], [-8, 3.72, -10.2], 'cover', COLORS.graphite),
      box('umbra-east-north-catwalk', [8, 2.65, -13.4], [31.6, 2.95, -10.2], 'platform', COLORS.ceramicBlue),
      box('umbra-east-north-catwalk-outer-rail-a', [10.7, 2.95, -13.4], [16, 3.72, -13.02], 'cover', COLORS.graphite),
      box('umbra-east-north-catwalk-outer-rail-b', [19, 2.95, -13.4], [31.6, 3.72, -13.02], 'cover', COLORS.graphite),
      box('umbra-east-north-catwalk-inner-rail-a', [8, 2.95, -10.58], [15.5, 3.72, -10.2], 'cover', COLORS.graphite),
      box('umbra-east-north-catwalk-inner-rail-b', [18.2, 2.95, -10.58], [28.8, 3.72, -10.2], 'cover', COLORS.graphite),
      box('umbra-west-south-catwalk', [-31.6, 2.65, 10.2], [-8, 2.95, 13.4], 'platform', COLORS.ceramicSage),
      box('umbra-west-south-catwalk-outer-rail', [-31.6, 2.95, 13.02], [-10.7, 3.72, 13.4], 'cover', COLORS.graphite),
      box('umbra-west-south-catwalk-inner-rail-a', [-28.8, 2.95, 10.2], [-18.2, 3.72, 10.58], 'cover', COLORS.graphite),
      box('umbra-west-south-catwalk-inner-rail-b', [-15.5, 2.95, 10.2], [-8, 3.72, 10.58], 'cover', COLORS.graphite),
      box('umbra-east-south-catwalk', [8, 2.65, 10.2], [31.6, 2.95, 13.4], 'platform', COLORS.ceramicSage),
      box('umbra-east-south-catwalk-outer-rail', [10.7, 2.95, 13.02], [31.6, 3.72, 13.4], 'cover', COLORS.graphite),
      box('umbra-east-south-catwalk-inner-rail-a', [8, 2.95, 10.2], [15.5, 3.72, 10.58], 'cover', COLORS.graphite),
      box('umbra-east-south-catwalk-inner-rail-b', [18.2, 2.95, 10.2], [28.8, 3.72, 10.58], 'cover', COLORS.graphite),

      // North signal tower: open undercroft, enclosed middle control room and
      // the highest non-Towah sniper roof. Its internal stair and skybridge are
      // separate approaches, avoiding a single campable lift exit.
      box('umbra-north-relay-mid-deck', [-8, 2.65, -23.5], [8, 2.95, -13.2], 'platform', COLORS.ceramicBlue),
      box('umbra-north-relay-front-apron', [-8, 2.65, -13.2], [8, 2.95, -10.6], 'platform', COLORS.ceramicBlue),
      box('umbra-north-relay-support-nw', [-7.6, 0, -23.1], [-6.8, 2.65, -22.3], 'cover', COLORS.graphite),
      box('umbra-north-relay-support-ne', [6.8, 0, -23.1], [7.6, 2.65, -22.3], 'cover', COLORS.graphite),
      box('umbra-north-relay-support-sw', [-7.6, 0, -14.4], [-6.8, 2.65, -13.6], 'cover', COLORS.graphite),
      box('umbra-north-relay-support-se', [6.8, 0, -14.4], [7.6, 2.65, -13.6], 'cover', COLORS.graphite),
      box('umbra-north-relay-back', [-8, 2.95, -23.5], [8, 6.42, -22.9], 'cover', COLORS.ceramicBlue),
      box('umbra-north-relay-west', [-8, 2.95, -22.9], [-7.4, 6.42, -16], 'cover', COLORS.ceramic),
      box('umbra-north-relay-east', [7.4, 2.95, -22.9], [8, 6.42, -16], 'cover', COLORS.ceramic),
      box('umbra-north-relay-front-west', [-7.4, 2.95, -13.8], [-2.1, 6.42, -13.2], 'cover', COLORS.ceramic),
      box('umbra-north-relay-front-east', [2.1, 2.95, -13.8], [7.4, 6.42, -13.2], 'cover', COLORS.ceramic),
      box('umbra-north-relay-roof', [-8, 6.42, -23.5], [8, 6.76, -22.2], 'platform', COLORS.ceramicBlue),
      box('umbra-north-relay-roof-west', [-8, 6.42, -22.2], [-1.6, 6.76, -13.2], 'platform', COLORS.ceramicBlue),
      box('umbra-north-relay-roof-east', [1.6, 6.42, -22.2], [8, 6.76, -13.2], 'platform', COLORS.ceramicBlue),
      ...stairFlightZ('umbra-north-relay-stair', 0, -13.2, -1, 2.95, 10, 1, 0.38, 2.7, COLORS.ceramicSage),
      box('umbra-north-relay-roof-rail-w', [-8, 6.76, -23.5], [-7.58, 7.53, -13.2], 'cover', COLORS.graphite),
      box('umbra-north-relay-roof-rail-e', [7.58, 6.76, -23.5], [8, 7.53, -13.2], 'cover', COLORS.graphite),
      box('umbra-north-relay-roof-rail-n', [-7.58, 6.76, -23.5], [7.58, 7.53, -23.08], 'cover', COLORS.graphite),
      box('umbra-north-skybridge', [-2.05, 5.62, -13.2], [2.05, 5.95, -8.5], 'platform', COLORS.ceramicBlue),
      box('umbra-north-skybridge-step', [-2.4, 5.62, -14.2], [2.4, 6.34, -13.2], 'platform', COLORS.ceramicBlue),
      box('umbra-north-skybridge-rail-w', [-2.05, 5.95, -13.2], [-1.7, 6.72, -8.5], 'cover', COLORS.graphite),
      box('umbra-north-skybridge-rail-e', [1.7, 5.95, -13.2], [2.05, 6.72, -8.5], 'cover', COLORS.graphite),

      // South power annex: a lower roof, close-range interior and two broad
      // ground doors. This offsets the sniper tower with a shotgun/rocket route.
      box('umbra-south-annex-floor', [-8, 0, 13.2], [8, 0.22, 24], 'platform', COLORS.ceramicSage),
      box('umbra-south-annex-mid-deck', [-8, 2.65, 13.2], [8, 2.95, 24], 'platform', COLORS.ceramicSage),
      box('umbra-south-annex-back', [-8, 0.22, 23.4], [8, 5.15, 24], 'cover', COLORS.graphite),
      box('umbra-south-annex-west', [-8, 0.22, 16], [-7.4, 5.15, 23.4], 'cover', COLORS.ceramicSage),
      box('umbra-south-annex-east', [7.4, 0.22, 16], [8, 5.15, 23.4], 'cover', COLORS.ceramicSage),
      box('umbra-south-annex-front-west', [-7.4, 0.22, 13.2], [-2.15, 5.15, 13.8], 'cover', COLORS.ceramic),
      box('umbra-south-annex-front-east', [2.15, 0.22, 13.2], [7.4, 5.15, 13.8], 'cover', COLORS.ceramic),
      box('umbra-south-annex-lintel', [-2.15, 3.95, 13.2], [2.15, 5.15, 13.8], 'cover', COLORS.graphite),
      box('umbra-south-annex-roof', [-8, 5.15, 19.2], [8, 5.48, 24], 'platform', COLORS.ceramicSage),
      box('umbra-south-annex-roof-west', [-8, 5.15, 13.2], [-1.6, 5.48, 19.2], 'platform', COLORS.ceramicSage),
      box('umbra-south-annex-roof-east', [1.6, 5.15, 13.2], [8, 5.48, 19.2], 'platform', COLORS.ceramicSage),
      box('umbra-south-annex-console-west', [-6.2, 0.22, 18], [-3.7, 1.42, 20.2], 'cover', COLORS.aurora),
      box('umbra-south-annex-console-east', [3.7, 0.22, 18], [6.2, 1.42, 20.2], 'cover', COLORS.nova),
      ...stairFlightZ('umbra-south-annex-stair', 0, 19.2, -1, 2.95, 6, 1, 0.38, 2.7, COLORS.ceramicSage),
      box('umbra-south-skybridge', [-2.05, 5.28, 8.5], [2.05, 5.62, 13.2], 'platform', COLORS.ceramicSage),
      box('umbra-south-skybridge-rail-w', [-2.05, 5.62, 8.5], [-1.7, 6.39, 13.2], 'cover', COLORS.graphite),
      box('umbra-south-skybridge-rail-e', [1.7, 5.62, 8.5], [2.05, 6.39, 13.2], 'cover', COLORS.graphite),

      // Ground-level cover follows station functions: coolant manifolds,
      // pressure tanks and a few natural crater intrusions at the outer edge.
      box('umbra-west-coolant-manifold-n', [-22, 0, -7.2], [-18.5, 2.2, -4], 'cover', COLORS.ceramicBlue),
      box('umbra-west-coolant-manifold-s', [-22, 0, 4], [-18.5, 2.2, 7.2], 'cover', COLORS.ceramicSage),
      box('umbra-east-coolant-manifold-n', [18.5, 0, -7.2], [22, 2.2, -4], 'cover', COLORS.ceramicBlue),
      box('umbra-east-coolant-manifold-s', [18.5, 0, 4], [22, 2.2, 7.2], 'cover', COLORS.ceramicSage),
      box('umbra-north-ground-cover-west', [-15.8, 0, -26], [-11.8, 2.4, -22.5], 'cover', COLORS.graphite),
      box('umbra-north-ground-cover-east', [11.8, 0, -26], [15.8, 2.4, -22.5], 'cover', COLORS.graphite),
      box('umbra-south-ground-cover-west', [-15.8, 0, 23], [-11.8, 2.2, 26.5], 'cover', COLORS.graphite),
      box('umbra-south-ground-cover-east', [11.8, 0, 23], [15.8, 2.2, 26.5], 'cover', COLORS.graphite),
      box('umbra-north-earth-berm-west', [-35.5, 0, -29.5], [-27.5, 0.38, -25.8], 'platform', COLORS.earth),
      box('umbra-north-earth-outcrop-west', [-34.2, 0.38, -28.8], [-30.2, 2.25, -26.3], 'cover', COLORS.rock),
      box('umbra-north-earth-berm-east', [27.5, 0, -29.5], [35.5, 0.38, -25.8], 'platform', COLORS.earth),
      box('umbra-north-earth-outcrop-east', [30.2, 0.38, -28.8], [34.2, 2.25, -26.3], 'cover', COLORS.rock),
      box('umbra-south-earth-berm-west', [-35.5, 0, 26], [-27.5, 0.36, 29.6], 'platform', COLORS.earth),
      box('umbra-south-earth-outcrop-west', [-34, 0.36, 26.5], [-30.4, 1.85, 29], 'cover', COLORS.rock),
      box('umbra-south-earth-berm-east', [27.5, 0, 26], [35.5, 0.36, 29.6], 'platform', COLORS.earth),
      box('umbra-south-earth-outcrop-east', [30.4, 0.36, 26.5], [34, 1.85, 29], 'cover', COLORS.rock),
    ],
    spawns: [
      { position: point(-32.2, 0.37, 0), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-32.2, 0.37, -6.5), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-32.2, 0.37, 6.5), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-24, 0.05, -24), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-24, 0.05, 17), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-31.2, 2.99, 0), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-19, 0.05, -24), yaw: -Math.PI / 2, team: 'aurora' },
      { position: point(-19, 0.05, 19), yaw: -Math.PI / 2, team: 'aurora' },

      { position: point(32.2, 0.37, 0), yaw: Math.PI / 2, team: 'nova' },
      { position: point(32.2, 0.37, -6.5), yaw: Math.PI / 2, team: 'nova' },
      { position: point(32.2, 0.37, 6.5), yaw: Math.PI / 2, team: 'nova' },
      { position: point(24, 0.05, -24), yaw: Math.PI / 2, team: 'nova' },
      { position: point(24, 0.05, 17), yaw: Math.PI / 2, team: 'nova' },
      { position: point(31.2, 2.99, 0), yaw: Math.PI / 2, team: 'nova' },
      { position: point(19, 0.05, -24), yaw: Math.PI / 2, team: 'nova' },
      { position: point(19, 0.05, 19), yaw: Math.PI / 2, team: 'nova' },

      { position: point(0, 0.05, -27), yaw: 0, team: 'neutral' },
      { position: point(0, 0.27, 18.5), yaw: Math.PI, team: 'neutral' },
      { position: point(-13, 0.05, -17), yaw: -Math.PI / 2, team: 'neutral' },
      { position: point(13, 0.05, 17), yaw: Math.PI / 2, team: 'neutral' },
      { position: point(-16, 0.05, 1.8), yaw: -Math.PI / 2, team: 'neutral' },
      { position: point(16, 0.05, -1.8), yaw: Math.PI / 2, team: 'neutral' },
      { position: point(3.5, 2.99, -15.5), yaw: 0, team: 'neutral' },
      { position: point(3, 5.52, 20.5), yaw: Math.PI, team: 'neutral' },
    ],
    waypoints: navigation.waypoints,
    waypointLinks: navigation.links,
    jumpPads: UMBRA_STATION_JUMP_PADS,
    pickups: [
      { id: 'umbra-pickup-sniper', kind: 'weapon', weaponId: 'sniper', position: point(3, 7.15, -20.5), respawnSeconds: 50 },
      { id: 'umbra-pickup-rocket', kind: 'weapon', weaponId: 'rocket-launcher', position: point(0, 0.62, 21.5), respawnSeconds: 60 },
      { id: 'umbra-pickup-shotgun', kind: 'weapon', weaponId: 'shotgun', position: point(3.5, 3.38, -15.5), respawnSeconds: 35 },
      { id: 'umbra-pickup-overshield', kind: 'overshield', position: point(0, 6.02, 10.3), respawnSeconds: 60 },
      { id: 'umbra-pickup-battle-west', kind: 'weapon', weaponId: 'battle-rifle', position: point(-23, 3.38, -11.7), respawnSeconds: 30 },
      { id: 'umbra-pickup-battle-east', kind: 'weapon', weaponId: 'battle-rifle', position: point(23, 3.38, -11.7), respawnSeconds: 30 },
      { id: 'umbra-pickup-pulse-west', kind: 'weapon', weaponId: 'pulse-rifle', position: point(-14, 0.45, 18), respawnSeconds: 25 },
      { id: 'umbra-pickup-pulse-east', kind: 'weapon', weaponId: 'pulse-rifle', position: point(14, 0.45, 18), respawnSeconds: 25 },
      { id: 'umbra-pickup-ammo-west', kind: 'ammo', position: point(-17, 0.45, -18), respawnSeconds: 18 },
      { id: 'umbra-pickup-ammo-east', kind: 'ammo', position: point(17, 0.45, -18), respawnSeconds: 18 },
      { id: 'umbra-pickup-grenade-west', kind: 'grenade', position: point(-14.5, 0.45, 8.5), respawnSeconds: 20 },
      { id: 'umbra-pickup-grenade-east', kind: 'grenade', position: point(14.5, 0.45, 8.5), respawnSeconds: 20 },
      { id: 'umbra-pickup-grenade-north', kind: 'grenade', position: point(0, 0.45, -26.5), respawnSeconds: 20 },
      { id: 'umbra-pickup-grenade-south', kind: 'grenade', position: point(0, 6.02, 11.2), respawnSeconds: 20 },
    ],
    flagBases: {
      aurora: point(-32.2, 0.72, 0),
      nova: point(32.2, 0.72, 0),
    },
    towerCenter: point(0, towerCenterY, 0),
    towerZone: { radius: 7, controlMinY: 5.82, patrolRadius: 5.45 },
  };
};
