import type { AabbObstacle, MapDefinition, Vec3 } from './types';

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
  boundaryDark: 0x203b48,
  ceramic: 0xc7d1cb,
  ceramicDark: 0x65777a,
  graphite: 0x182d38,
  aurora: 0x315e67,
  nova: 0x514c69,
  terrain: 0x3f6860,
  terrainLight: 0x587a68,
} as const;

export interface JumpPadZone {
  id: 'west-tower-lift' | 'east-tower-lift';
  center: Vec3;
  halfSize: { x: number; z: number };
  /** Suggested launch velocity. Simulation owns the actual impulse. */
  launchVelocity: Vec3;
}

/**
 * The old lifts used to relocate players directly onto the tower. They now
 * describe physical launch zones so movement can apply a continuous arc.
 */
export const JUMP_PAD_ZONES: readonly JumpPadZone[] = [
  {
    id: 'west-tower-lift',
    center: point(-12.4, 0, 0),
    halfSize: { x: 1.8, z: 2.7 },
    launchVelocity: point(5.8, 14.2, 0),
  },
  {
    id: 'east-tower-lift',
    center: point(12.4, 0, 0),
    halfSize: { x: 1.8, z: 2.7 },
    launchVelocity: point(-5.8, 14.2, 0),
  },
] as const;

export const CRATER_RIDGE: MapDefinition = {
  id: 'crater-ridge',
  name: 'Cresta del Cráter',
  bounds: { minX: -52, maxX: 52, minZ: -42, maxZ: 42, floorY: 0, ceilingY: 24 },
  obstacles: [
    // Arena shell. The larger footprint gives each team three meaningful
    // routes: the exposed observatory, the central tower and the close-range
    // hydroponics lane.
    box('north-wall', [-52, 0, -43], [52, 9, -42], 'wall', COLORS.boundary),
    box('south-wall', [-52, 0, 42], [52, 9, 43], 'wall', COLORS.boundary),
    box('west-wall', [-53, 0, -42], [-52, 9, 42], 'wall', COLORS.boundaryDark),
    box('east-wall', [52, 0, -42], [53, 9, 42], 'wall', COLORS.boundaryDark),

    // Central command tower. Its footprint remains deliberately compact so it
    // blocks the cross-map sightline without choking movement around mid.
    box('tower-core', [-4.8, 0, -4.8], [4.8, 5.4, 4.8], 'tower', COLORS.graphite),
    box('tower-deck', [-9, 5.4, -9], [9, 5.95, 9], 'platform', COLORS.ceramicDark),
    box('tower-cap', [-2.35, 5.95, -2.35], [2.35, 8.1, 2.35], 'cover', COLORS.graphite),
    box('tower-rail-n', [-9, 5.95, -9], [9, 6.72, -8.52], 'cover', COLORS.ceramic),
    box('tower-rail-s', [-9, 5.95, 8.52], [9, 6.72, 9], 'cover', COLORS.ceramic),
    box('tower-rail-w', [-9, 5.95, -8.52], [-8.52, 6.72, 8.52], 'cover', COLORS.ceramic),
    box('tower-rail-e', [8.52, 5.95, -8.52], [9, 6.72, 8.52], 'cover', COLORS.ceramic),
    box('tower-screen-n-west', [-3.8, 5.95, -7.7], [-1, 7.2, -7.35], 'cover', COLORS.aurora),
    box('tower-screen-n-east', [1, 5.95, -7.7], [3.8, 7.2, -7.35], 'cover', COLORS.aurora),
    box('tower-screen-s-west', [-3.8, 5.95, 7.35], [-1, 7.2, 7.7], 'cover', COLORS.nova),
    box('tower-screen-s-east', [1, 5.95, 7.35], [3.8, 7.2, 7.7], 'cover', COLORS.nova),

    // Team bases: larger protected spawn rooms with split exits and a short
    // elevated balcony. Geometry is mirrored exactly across the centre line.
    box('west-base', [-47, 0, -11], [-36, 0.82, 11], 'platform', COLORS.aurora),
    box('west-base-back', [-50, 0, -13], [-47, 7.2, 13], 'wall', COLORS.graphite),
    box('west-base-wing-n', [-47, 0.82, -13], [-40, 4.4, -10.2], 'wall', COLORS.ceramicDark),
    box('west-base-wing-s', [-47, 0.82, 10.2], [-40, 4.4, 13], 'wall', COLORS.ceramicDark),
    box('west-base-balcony', [-47, 3.15, -8], [-42, 3.62, 8], 'platform', COLORS.ceramic),
    box('west-base-cover-n', [-36, 0, -10], [-32.5, 3.2, -6.3], 'cover', COLORS.ceramic),
    box('west-base-cover-s', [-36, 0, 6.3], [-32.5, 3.2, 10], 'cover', COLORS.ceramic),
    box('west-base-step', [-36, 0, -3.2], [-34.4, 0.42, 3.2], 'platform', COLORS.aurora),
    box('west-base-balcony-step-low', [-40, 0.82, -4], [-38.2, 1.7, 0], 'platform', COLORS.aurora),
    box('west-base-balcony-step-high', [-42, 0.82, -4], [-40, 2.65, 0], 'platform', COLORS.ceramicDark),

    box('east-base', [36, 0, -11], [47, 0.82, 11], 'platform', COLORS.nova),
    box('east-base-back', [47, 0, -13], [50, 7.2, 13], 'wall', COLORS.graphite),
    box('east-base-wing-n', [40, 0.82, -13], [47, 4.4, -10.2], 'wall', COLORS.ceramicDark),
    box('east-base-wing-s', [40, 0.82, 10.2], [47, 4.4, 13], 'wall', COLORS.ceramicDark),
    box('east-base-balcony', [42, 3.15, -8], [47, 3.62, 8], 'platform', COLORS.ceramic),
    box('east-base-cover-n', [32.5, 0, -10], [36, 3.2, -6.3], 'cover', COLORS.ceramic),
    box('east-base-cover-s', [32.5, 0, 6.3], [36, 3.2, 10], 'cover', COLORS.ceramic),
    box('east-base-step', [34.4, 0, -3.2], [36, 0.42, 3.2], 'platform', COLORS.nova),
    box('east-base-balcony-step-low', [38.2, 0.82, -4], [40, 1.7, 0], 'platform', COLORS.nova),
    box('east-base-balcony-step-high', [40, 0.82, -4], [42, 2.65, 0], 'platform', COLORS.ceramicDark),

    // Mid galleries break up the former empty base-to-tower sprint. Players can
    // fight below, jump onto the 1.25 m deck or use its split side approaches.
    box('west-mid-gallery', [-27, 0, -5.2], [-19, 1.25, -3.2], 'platform', COLORS.ceramicDark),
    box('west-mid-gallery-south', [-27, 0, 3.2], [-19, 1.25, 5.2], 'platform', COLORS.ceramicDark),
    box('west-mid-console-n', [-25.7, 1.25, -4.9], [-22.7, 2.55, -3.45], 'cover', COLORS.graphite),
    box('west-mid-console-s', [-23.3, 1.25, 3.45], [-20.3, 2.55, 4.9], 'cover', COLORS.graphite),
    box('west-mid-step-n', [-21.5, 0, -7], [-19, 0.58, -5.2], 'platform', COLORS.aurora),
    box('west-mid-step-s', [-27, 0, 5.2], [-24.5, 0.58, 7], 'platform', COLORS.aurora),

    box('east-mid-gallery', [19, 0, -5.2], [27, 1.25, -3.2], 'platform', COLORS.ceramicDark),
    box('east-mid-gallery-south', [19, 0, 3.2], [27, 1.25, 5.2], 'platform', COLORS.ceramicDark),
    box('east-mid-console-n', [22.7, 1.25, -4.9], [25.7, 2.55, -3.45], 'cover', COLORS.graphite),
    box('east-mid-console-s', [20.3, 1.25, 3.45], [23.3, 2.55, 4.9], 'cover', COLORS.graphite),
    box('east-mid-step-n', [19, 0, -7], [21.5, 0.58, -5.2], 'platform', COLORS.nova),
    box('east-mid-step-s', [24.5, 0, 5.2], [27, 0.58, 7], 'platform', COLORS.nova),

    // North observatory lane: long sightlines, climbable two-level terraces and
    // enough hard cover to rotate without feeding the tower sniper.
    box('north-ridge-west', [-34, 0, -34], [-18, 1.4, -27], 'platform', COLORS.terrain),
    box('north-ridge-west-step', [-18, 0, -32.5], [-16.2, 0.62, -28.5], 'platform', COLORS.terrainLight),
    box('north-overlook-west', [-28, 1.4, -32.8], [-21, 2.82, -28.2], 'platform', COLORS.ceramicDark),
    box('north-overlook-west-step', [-21, 1.4, -31.8], [-19.2, 2.1, -29.2], 'platform', COLORS.terrainLight),
    box('north-overlook-west-cover', [-27.3, 2.82, -32.2], [-25.8, 4.25, -28.8], 'cover', COLORS.ceramic),
    box('north-ridge-east', [18, 0, -34], [34, 1.4, -27], 'platform', COLORS.terrain),
    box('north-ridge-east-step', [16.2, 0, -32.5], [18, 0.62, -28.5], 'platform', COLORS.terrainLight),
    box('north-overlook-east', [21, 1.4, -32.8], [28, 2.82, -28.2], 'platform', COLORS.ceramicDark),
    box('north-overlook-east-step', [19.2, 1.4, -31.8], [21, 2.1, -29.2], 'platform', COLORS.terrainLight),
    box('north-overlook-east-cover', [25.8, 2.82, -32.2], [27.3, 4.25, -28.8], 'cover', COLORS.ceramic),
    box('north-relay', [-3.2, 0, -36.2], [3.2, 3.8, -33.2], 'cover', COLORS.graphite),
    box('north-relay-cover-west', [-10.5, 0, -34], [-7.2, 2, -31.3], 'cover', COLORS.ceramic),
    box('north-relay-cover-east', [7.2, 0, -34], [10.5, 2, -31.3], 'cover', COLORS.ceramic),
    box('north-mid-cover-west', [-15.5, 0, -22], [-11.5, 2.65, -18.5], 'cover', COLORS.terrainLight),
    box('north-mid-cover-east', [11.5, 0, -22], [15.5, 2.65, -18.5], 'cover', COLORS.terrainLight),
    box('north-mid-slab', [-4.2, 0, -21.5], [4.2, 1.35, -18.8], 'cover', COLORS.ceramicDark),

    // South hydroponics lane: denser, lower cover for shotgun fights and flag
    // flanks. A raised planter on each side still provides a counter-angle.
    box('south-ridge-west', [-34, 0, 27], [-19, 1.2, 34], 'platform', COLORS.terrain),
    box('south-ridge-west-step', [-19, 0, 28.5], [-17.2, 0.55, 32.5], 'platform', COLORS.terrainLight),
    box('south-planter-west', [-28, 1.2, 28.2], [-21, 2.48, 32.8], 'platform', COLORS.terrainLight),
    box('south-planter-west-step', [-21, 1.2, 29.2], [-19.4, 1.85, 31.8], 'platform', COLORS.terrainLight),
    box('south-planter-west-cover', [-27.2, 2.48, 28.8], [-25.6, 3.9, 32.2], 'cover', COLORS.ceramic),
    box('south-ridge-east', [19, 0, 27], [34, 1.2, 34], 'platform', COLORS.terrain),
    box('south-ridge-east-step', [17.2, 0, 28.5], [19, 0.55, 32.5], 'platform', COLORS.terrainLight),
    box('south-planter-east', [21, 1.2, 28.2], [28, 2.48, 32.8], 'platform', COLORS.terrainLight),
    box('south-planter-east-step', [19.4, 1.2, 29.2], [21, 1.85, 31.8], 'platform', COLORS.terrainLight),
    box('south-planter-east-cover', [25.6, 2.48, 28.8], [27.2, 3.9, 32.2], 'cover', COLORS.ceramic),
    box('south-greenhouse-core', [-4.5, 0, 30.5], [4.5, 2.3, 34.8], 'cover', COLORS.terrainLight),
    box('south-greenhouse-west', [-11.5, 0, 27], [-7.2, 1.8, 30.2], 'cover', COLORS.ceramicDark),
    box('south-greenhouse-east', [7.2, 0, 27], [11.5, 1.8, 30.2], 'cover', COLORS.ceramicDark),
    box('south-mid-cover-west', [-16.5, 0, 18.5], [-12.5, 2.2, 22], 'cover', COLORS.terrainLight),
    box('south-mid-cover-east', [12.5, 0, 18.5], [16.5, 2.2, 22], 'cover', COLORS.terrainLight),
    box('south-mid-slab-west', [-7.2, 0, 18.8], [-3.2, 1.25, 21.5], 'cover', COLORS.ceramicDark),
    box('south-mid-slab-east', [3.2, 0, 18.8], [7.2, 1.25, 21.5], 'cover', COLORS.ceramicDark),

    // Four compact cover constellations protect rotations between lanes while
    // leaving generous diagonal gaps for combat readability.
    box('cover-nw-a', [-20, 0, -15], [-16, 2.7, -11.2], 'cover', COLORS.ceramic),
    box('cover-nw-b', [-12, 0, -15.8], [-8.5, 1.65, -12.5], 'cover', COLORS.graphite),
    box('cover-ne-a', [16, 0, -15], [20, 2.7, -11.2], 'cover', COLORS.ceramic),
    box('cover-ne-b', [8.5, 0, -15.8], [12, 1.65, -12.5], 'cover', COLORS.graphite),
    box('cover-sw-a', [-20, 0, 11.2], [-16, 2.7, 15], 'cover', COLORS.ceramic),
    box('cover-sw-b', [-12, 0, 12.5], [-8.5, 1.65, 15.8], 'cover', COLORS.graphite),
    box('cover-se-a', [16, 0, 11.2], [20, 2.7, 15], 'cover', COLORS.ceramic),
    box('cover-se-b', [8.5, 0, 12.5], [12, 1.65, 15.8], 'cover', COLORS.graphite),
  ],
  spawns: [
    { position: point(-42.5, 0.87, 0), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-43.5, 0.87, -7), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-43.5, 0.87, 7), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-35, 0.05, -18), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-35, 0.05, 18), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-29.5, 1.45, -29), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-29.5, 1.25, 29), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-25, 0.05, -10), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-25, 0.05, 10), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-15, 0.05, -7), yaw: -Math.PI / 2, team: 'aurora' },

    { position: point(42.5, 0.87, 0), yaw: Math.PI / 2, team: 'nova' },
    { position: point(43.5, 0.87, -7), yaw: Math.PI / 2, team: 'nova' },
    { position: point(43.5, 0.87, 7), yaw: Math.PI / 2, team: 'nova' },
    { position: point(35, 0.05, -18), yaw: Math.PI / 2, team: 'nova' },
    { position: point(35, 0.05, 18), yaw: Math.PI / 2, team: 'nova' },
    { position: point(29.5, 1.45, -29), yaw: Math.PI / 2, team: 'nova' },
    { position: point(29.5, 1.25, 29), yaw: Math.PI / 2, team: 'nova' },
    { position: point(25, 0.05, -10), yaw: Math.PI / 2, team: 'nova' },
    { position: point(25, 0.05, 10), yaw: Math.PI / 2, team: 'nova' },
    { position: point(15, 0.05, -7), yaw: Math.PI / 2, team: 'nova' },

    { position: point(0, 0.05, -29), yaw: 0, team: 'neutral' },
    { position: point(0, 0.05, 26), yaw: Math.PI, team: 'neutral' },
    { position: point(-29, 0.05, -20), yaw: -Math.PI / 2, team: 'neutral' },
    { position: point(29, 0.05, 20), yaw: Math.PI / 2, team: 'neutral' },
    { position: point(-14, 0.05, 5), yaw: -Math.PI / 2, team: 'neutral' },
    { position: point(14, 0.05, -5), yaw: Math.PI / 2, team: 'neutral' },
  ],
  waypoints: [
    // Base exits and the direct lane.
    point(-43, 0.87, 0), point(-38, 0.87, 0), point(-35.2, 0.47, 0), point(-32, 0.05, 0),
    point(-36, 0.05, -14), point(-36, 0.05, 14),
    point(-29, 0.05, -9), point(-29, 0.05, 9), point(-24, 1.3, 0),
    point(-18, 0.05, -7), point(-18, 0.05, 7), point(-14.2, 0.05, 0),
    point(-12.4, 0.05, 0), point(-10, 0.05, -10), point(-10, 0.05, 10),
    // Central deck and its four escape corners.
    point(-7.4, 6, -6.5), point(-7.4, 6, 6.5), point(7.4, 6, -6.5), point(7.4, 6, 6.5),
    point(12.4, 0.05, 0), point(14.2, 0.05, 0), point(18, 0.05, -7), point(18, 0.05, 7),
    point(24, 1.3, 0), point(29, 0.05, -9), point(29, 0.05, 9),
    point(32, 0.05, 0), point(35.2, 0.47, 0), point(38, 0.87, 0),
    point(36, 0.05, -14), point(36, 0.05, 14), point(43, 0.87, 0),
    // North observatory circuit.
    point(-43, 0.05, -25), point(-34, 0.05, -35), point(-30, 1.45, -29), point(-17, 0.65, -30),
    point(-13, 0.05, -27), point(-6, 0.05, -30), point(0, 0.05, -29), point(6, 0.05, -30),
    point(13, 0.05, -27), point(17, 0.65, -30), point(30, 1.45, -29), point(34, 0.05, -35), point(43, 0.05, -25),
    // South hydroponics circuit.
    point(-43, 0.05, 25), point(-34, 0.05, 35), point(-30, 1.25, 29), point(-18, 0.6, 30),
    point(-14, 0.05, 25), point(-6, 0.05, 26), point(0, 0.05, 26), point(6, 0.05, 26),
    point(14, 0.05, 25), point(18, 0.6, 30), point(30, 1.25, 29), point(34, 0.05, 35), point(43, 0.05, 25),
  ],
  pickups: [
    { id: 'pickup-sniper', kind: 'weapon', weaponId: 'sniper', position: point(0, 6.38, -5.8), respawnSeconds: 50 },
    { id: 'pickup-rocket', kind: 'weapon', weaponId: 'rocket-launcher', position: point(0, 0.45, -30), respawnSeconds: 60 },
    { id: 'pickup-shotgun', kind: 'weapon', weaponId: 'shotgun', position: point(0, 0.45, 26), respawnSeconds: 35 },
    { id: 'pickup-overshield', kind: 'overshield', position: point(0, 0.45, 15.5), respawnSeconds: 60 },
    { id: 'pickup-battle-west', kind: 'weapon', weaponId: 'battle-rifle', position: point(-30, 1.82, -30), respawnSeconds: 30 },
    { id: 'pickup-battle-east', kind: 'weapon', weaponId: 'battle-rifle', position: point(30, 1.82, -30), respawnSeconds: 30 },
    { id: 'pickup-pulse-west', kind: 'weapon', weaponId: 'pulse-rifle', position: point(-29, 0.45, 20), respawnSeconds: 25 },
    { id: 'pickup-pulse-east', kind: 'weapon', weaponId: 'pulse-rifle', position: point(29, 0.45, 20), respawnSeconds: 25 },
    { id: 'pickup-ammo-west', kind: 'ammo', position: point(-20, 0.45, 15.5), respawnSeconds: 18 },
    { id: 'pickup-ammo-east', kind: 'ammo', position: point(20, 0.45, 15.5), respawnSeconds: 18 },
    { id: 'pickup-ammo-north-west', kind: 'ammo', position: point(-14, 0.45, -24), respawnSeconds: 18 },
    { id: 'pickup-ammo-north-east', kind: 'ammo', position: point(14, 0.45, -24), respawnSeconds: 18 },
    { id: 'pickup-grenade-west', kind: 'grenade', position: point(-11, 0.45, -17), respawnSeconds: 20 },
    { id: 'pickup-grenade-east', kind: 'grenade', position: point(11, 0.45, -17), respawnSeconds: 20 },
    { id: 'pickup-grenade-south-west', kind: 'grenade', position: point(-9, 0.45, 23), respawnSeconds: 20 },
    { id: 'pickup-grenade-south-east', kind: 'grenade', position: point(9, 0.45, 23), respawnSeconds: 20 },
  ],
  flagBases: {
    aurora: point(-42.5, 1.16, 0),
    nova: point(42.5, 1.16, 0),
  },
  towerCenter: point(0, 6.05, 0),
};

export const MAPS: Record<MapDefinition['id'], MapDefinition> = {
  'crater-ridge': CRATER_RIDGE,
};

export const jumpPadAt = (position: Vec3): JumpPadZone | null =>
  JUMP_PAD_ZONES.find((pad) =>
    Math.abs(position.x - pad.center.x) <= pad.halfSize.x
    && Math.abs(position.z - pad.center.z) <= pad.halfSize.z
    && position.y < 1.8,
  ) ?? null;

export const isJumpPad = (position: Vec3): boolean => jumpPadAt(position) !== null;
