import { createUmbraStation } from './maps/umbraStation';
import type { AabbObstacle, JumpPadZone, MapDefinition, Vec3 } from './types';

export type { JumpPadZone } from './types';

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

const TOWER_CENTER_Y = 6.05;

/**
 * Authoritative dimensions for the manually operated Towah emplacement.
 *
 * Presentation imports this contract too: keeping the physical platform,
 * operator capsule, muzzle ray and rendered turret on the same offsets avoids
 * the old situation where the camera used a turret while the astronaut stayed
 * behind on the lower control deck.
 */
export const TOWER_TURRET_LAYOUT = Object.freeze({
  /** Top of the narrow raised emplacement, measured from `towerCenter.y`. */
  platformTopOffset: 3.2,
  /** Feet of the mounted astronaut sit just clear of the platform collider. */
  operatorFeetOffset: 3.24,
  /** The astronaut follows this ring immediately behind the gun's yaw. */
  operatorDistance: 1.45,
  /** Ray/sight pivot; 1.9 m deck clearance keeps diagonal shots above the cap. */
  firingOriginOffset: 5.1,
  /** Group root sits almost flush; presentation adds a tall central pedestal. */
  renderedTurretRootOffset: 3.16,
  /** Safe lower-deck radius used after leaving the emplacement. */
  exitRadius: 3.15,
  /** Prevents the mounted hitbox from teleporting around the pedestal on flick turns. */
  turnRate: 5.4,
  minPitch: -0.6,
  maxPitch: 0.85,
} as const);

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
    box(
      'tower-cap',
      [-1.9, 5.95, -1.9],
      [1.9, TOWER_CENTER_Y + TOWER_TURRET_LAYOUT.platformTopOffset, 1.9],
      'cover',
      COLORS.graphite,
    ),
    box('tower-rail-n', [-9, 5.95, -9], [9, 6.72, -8.52], 'cover', COLORS.ceramic),
    box('tower-rail-s', [-9, 5.95, 8.52], [9, 6.72, 9], 'cover', COLORS.ceramic),
    box('tower-rail-w', [-9, 5.95, -8.52], [-8.52, 6.72, 8.52], 'cover', COLORS.ceramic),
    box('tower-rail-e', [8.52, 5.95, -8.52], [9, 6.72, 8.52], 'cover', COLORS.ceramic),
    box('tower-screen-n-west', [-3.8, 5.95, -7.7], [-1, 7.2, -7.35], 'cover', COLORS.aurora),
    box('tower-screen-n-east', [1, 5.95, -7.7], [3.8, 7.2, -7.35], 'cover', COLORS.aurora),
    box('tower-screen-s-west', [-3.8, 5.95, 7.35], [-1, 7.2, 7.7], 'cover', COLORS.nova),
    box('tower-screen-s-east', [1, 5.95, 7.35], [3.8, 7.2, 7.7], 'cover', COLORS.nova),

    // Team operations buildings. Each base is now a readable human bunker:
    // a roofed flag room, wide pressure-door opening, service mezzanine,
    // interior cargo and a shallow exterior loading ramp. The centre aisle
    // stays completely open for CTF bots while the side rooms support flanks.
    box('west-base', [-49.2, 0, -12.2], [-38.8, 0.34, 12.2], 'platform', COLORS.aurora),
    box('west-base-back', [-50, 0, -12.9], [-49.2, 5.7, 12.9], 'cover', COLORS.graphite),
    box('west-base-wing-n', [-49.2, 0.34, -12.9], [-38.8, 5.35, -12.2], 'cover', COLORS.ceramicDark),
    box('west-base-wing-s', [-49.2, 0.34, 12.2], [-38.8, 5.35, 12.9], 'cover', COLORS.ceramicDark),
    box('west-base-front-n', [-39.5, 0.34, -12.2], [-38.8, 5.25, -4.4], 'cover', COLORS.ceramic),
    box('west-base-front-s', [-39.5, 0.34, 4.4], [-38.8, 5.25, 12.2], 'cover', COLORS.ceramic),
    box('west-base-door-lintel', [-39.5, 4.05, -4.4], [-38.8, 5.25, 4.4], 'cover', COLORS.graphite),
    box('west-base-roof', [-49.2, 5.25, -12.2], [-38.8, 5.62, 12.2], 'platform', COLORS.ceramicDark),
    box('west-base-balcony', [-49, 2.5, -8], [-44, 2.82, 8], 'platform', COLORS.ceramic),
    box('west-base-balcony-step-low', [-43, 0.34, 5.4], [-41.7, 1.16, 8.6], 'platform', COLORS.aurora),
    box('west-base-balcony-step-high', [-44.3, 0.34, 5.4], [-43, 1.99, 8.6], 'platform', COLORS.ceramicDark),
    box('west-base-balcony-step-top', [-45.6, 0.34, 5.4], [-44.3, 2.82, 8.6], 'platform', COLORS.ceramic),
    box('west-base-balcony-rail-n', [-44.35, 2.82, -8], [-44, 3.68, 4.8], 'cover', COLORS.graphite),
    box('west-base-balcony-rail-s', [-44.35, 2.82, 8.6], [-44, 3.68, 9], 'cover', COLORS.graphite),
    box('west-base-interior-crate-n', [-47.6, 0.34, -5.2], [-45.9, 1.58, -3.35], 'cover', COLORS.aurora),
    box('west-base-interior-crate-s', [-47.6, 0.34, 3.35], [-45.9, 1.58, 5.2], 'cover', COLORS.aurora),
    box('west-base-cover-n', [-36, 0, -10], [-32.5, 3.2, -6.3], 'cover', COLORS.ceramic),
    box('west-base-cover-s', [-36, 0, 6.3], [-32.5, 3.2, 10], 'cover', COLORS.ceramic),
    box('west-base-step', [-38.8, 0, -3.4], [-37.6, 0.25, 3.4], 'platform', COLORS.aurora),
    box('west-base-ramp-low', [-37.6, 0, -3.4], [-36.4, 0.12, 3.4], 'platform', COLORS.aurora),

    box('east-base', [38.8, 0, -12.2], [49.2, 0.34, 12.2], 'platform', COLORS.nova),
    box('east-base-back', [49.2, 0, -12.9], [50, 5.7, 12.9], 'cover', COLORS.graphite),
    box('east-base-wing-n', [38.8, 0.34, -12.9], [49.2, 5.35, -12.2], 'cover', COLORS.ceramicDark),
    box('east-base-wing-s', [38.8, 0.34, 12.2], [49.2, 5.35, 12.9], 'cover', COLORS.ceramicDark),
    box('east-base-front-n', [38.8, 0.34, -12.2], [39.5, 5.25, -4.4], 'cover', COLORS.ceramic),
    box('east-base-front-s', [38.8, 0.34, 4.4], [39.5, 5.25, 12.2], 'cover', COLORS.ceramic),
    box('east-base-door-lintel', [38.8, 4.05, -4.4], [39.5, 5.25, 4.4], 'cover', COLORS.graphite),
    box('east-base-roof', [38.8, 5.25, -12.2], [49.2, 5.62, 12.2], 'platform', COLORS.ceramicDark),
    box('east-base-balcony', [44, 2.5, -8], [49, 2.82, 8], 'platform', COLORS.ceramic),
    box('east-base-balcony-step-low', [41.7, 0.34, 5.4], [43, 1.16, 8.6], 'platform', COLORS.nova),
    box('east-base-balcony-step-high', [43, 0.34, 5.4], [44.3, 1.99, 8.6], 'platform', COLORS.ceramicDark),
    box('east-base-balcony-step-top', [44.3, 0.34, 5.4], [45.6, 2.82, 8.6], 'platform', COLORS.ceramic),
    box('east-base-balcony-rail-n', [44, 2.82, -8], [44.35, 3.68, 4.8], 'cover', COLORS.graphite),
    box('east-base-balcony-rail-s', [44, 2.82, 8.6], [44.35, 3.68, 9], 'cover', COLORS.graphite),
    box('east-base-interior-crate-n', [45.9, 0.34, -5.2], [47.6, 1.58, -3.35], 'cover', COLORS.nova),
    box('east-base-interior-crate-s', [45.9, 0.34, 3.35], [47.6, 1.58, 5.2], 'cover', COLORS.nova),
    box('east-base-cover-n', [32.5, 0, -10], [36, 3.2, -6.3], 'cover', COLORS.ceramic),
    box('east-base-cover-s', [32.5, 0, 6.3], [36, 3.2, 10], 'cover', COLORS.ceramic),
    box('east-base-step', [37.6, 0, -3.4], [38.8, 0.25, 3.4], 'platform', COLORS.nova),
    box('east-base-ramp-low', [36.4, 0, -3.4], [37.6, 0.12, 3.4], 'platform', COLORS.nova),

    // Mirrored logistics checkpoints break up the base-to-tower sprint. The
    // raised loading docks and consoles have a real canopy on four narrow
    // columns, leaving the central service corridor open underneath.
    box('west-mid-gallery', [-27, 0, -5.2], [-19, 1.25, -3.2], 'platform', COLORS.ceramicDark),
    box('west-mid-gallery-south', [-27, 0, 3.2], [-19, 1.25, 5.2], 'platform', COLORS.ceramicDark),
    box('west-mid-console-n', [-25.7, 1.25, -4.9], [-22.7, 2.55, -3.45], 'cover', COLORS.graphite),
    box('west-mid-console-s', [-23.3, 1.25, 3.45], [-20.3, 2.55, 4.9], 'cover', COLORS.graphite),
    box('west-mid-step-n', [-21.5, 0, -7], [-19, 0.58, -5.2], 'platform', COLORS.aurora),
    box('west-mid-step-s', [-27, 0, 5.2], [-24.5, 0.58, 7], 'platform', COLORS.aurora),
    box('west-mid-canopy', [-27, 3.25, -5.2], [-19, 3.58, 5.2], 'platform', COLORS.ceramic),
    box('west-mid-pillar-nw', [-26.9, 0, -5.1], [-26.35, 3.25, -4.55], 'cover', COLORS.graphite),
    box('west-mid-pillar-sw', [-26.9, 0, 4.55], [-26.35, 3.25, 5.1], 'cover', COLORS.graphite),
    box('west-mid-pillar-ne', [-19.65, 0, -5.1], [-19.1, 3.25, -4.55], 'cover', COLORS.graphite),
    box('west-mid-pillar-se', [-19.65, 0, 4.55], [-19.1, 3.25, 5.1], 'cover', COLORS.graphite),

    box('east-mid-gallery', [19, 0, -5.2], [27, 1.25, -3.2], 'platform', COLORS.ceramicDark),
    box('east-mid-gallery-south', [19, 0, 3.2], [27, 1.25, 5.2], 'platform', COLORS.ceramicDark),
    box('east-mid-console-n', [22.7, 1.25, -4.9], [25.7, 2.55, -3.45], 'cover', COLORS.graphite),
    box('east-mid-console-s', [20.3, 1.25, 3.45], [23.3, 2.55, 4.9], 'cover', COLORS.graphite),
    box('east-mid-step-n', [19, 0, -7], [21.5, 0.58, -5.2], 'platform', COLORS.nova),
    box('east-mid-step-s', [24.5, 0, 5.2], [27, 0.58, 7], 'platform', COLORS.nova),
    box('east-mid-canopy', [19, 3.25, -5.2], [27, 3.58, 5.2], 'platform', COLORS.ceramic),
    box('east-mid-pillar-nw', [19.1, 0, -5.1], [19.65, 3.25, -4.55], 'cover', COLORS.graphite),
    box('east-mid-pillar-sw', [19.1, 0, 4.55], [19.65, 3.25, 5.1], 'cover', COLORS.graphite),
    box('east-mid-pillar-ne', [26.35, 0, -5.1], [26.9, 3.25, -4.55], 'cover', COLORS.graphite),
    box('east-mid-pillar-se', [26.35, 0, 4.55], [26.9, 3.25, 5.1], 'cover', COLORS.graphite),

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
    // Observatory relay: a small weather-tight building with an actual
    // traversable interior. Its central south door connects the sniper route;
    // consoles sit against the sides so the bot waypoint through x=0 is clear.
    box('north-relay-floor', [-7.8, 0, -36.5], [7.8, 0.16, -30.2], 'platform', COLORS.ceramicDark),
    box('north-relay', [-7.8, 0.16, -37.2], [7.8, 4.8, -36.5], 'cover', COLORS.graphite),
    box('north-relay-wall-west', [-7.8, 0.16, -36.5], [-7.1, 4.8, -30.2], 'cover', COLORS.ceramicDark),
    box('north-relay-wall-east', [7.1, 0.16, -36.5], [7.8, 4.8, -30.2], 'cover', COLORS.ceramicDark),
    box('north-relay-front-west', [-7.1, 0.16, -30.2], [-2.2, 4.8, -29.5], 'cover', COLORS.ceramic),
    box('north-relay-front-east', [2.2, 0.16, -30.2], [7.1, 4.8, -29.5], 'cover', COLORS.ceramic),
    box('north-relay-lintel', [-2.2, 3.55, -30.2], [2.2, 4.8, -29.5], 'cover', COLORS.graphite),
    box('north-relay-roof', [-7.8, 4.8, -36.5], [7.8, 5.18, -30.2], 'platform', COLORS.ceramicDark),
    box('north-relay-console-west', [-6.25, 0.16, -34.8], [-3.75, 1.38, -32.7], 'cover', COLORS.aurora),
    box('north-relay-console-east', [3.75, 0.16, -34.8], [6.25, 1.38, -32.7], 'cover', COLORS.nova),
    box('north-relay-cover-west', [-10.5, 0, -34], [-7.2, 2, -31.3], 'cover', COLORS.ceramic),
    box('north-relay-cover-east', [7.2, 0, -34], [10.5, 2, -31.3], 'cover', COLORS.ceramic),
    box('north-mid-cover-west', [-15.5, 0, -22], [-11.5, 2.65, -18.5], 'cover', COLORS.terrainLight),
    box('north-mid-cover-east', [11.5, 0, -22], [15.5, 2.65, -18.5], 'cover', COLORS.terrainLight),
    box('north-mid-slab', [-4.2, 0, -21.5], [4.2, 1.35, -18.8], 'cover', COLORS.ceramicDark),
    // Low physical earthwork stays outside the poured facility corridors. The
    // shallow approach shelves lead to playable berm tops; compact outcrops
    // provide natural cover without closing the observatory circuit.
    box('north-earth-approach-west', [-49, 0, -34.8], [-45, 0.18, -33.2], 'platform', COLORS.terrainLight),
    box('north-earth-berm-west', [-49, 0, -39.5], [-41, 0.38, -34.8], 'platform', COLORS.terrain),
    box('north-earth-outcrop-west', [-47.6, 0.38, -38.5], [-44.2, 1.55, -36.1], 'cover', COLORS.terrainLight),
    box('north-earth-approach-east', [45, 0, -34.8], [49, 0.18, -33.2], 'platform', COLORS.terrainLight),
    box('north-earth-berm-east', [41, 0, -39.5], [49, 0.38, -34.8], 'platform', COLORS.terrain),
    box('north-earth-outcrop-east', [44.2, 0.38, -38.5], [47.6, 1.55, -36.1], 'cover', COLORS.terrainLight),
    // The boundary berm flows into a second, shallow knoll instead of ending
    // as a flat rectangular island. Both shelves stay within auto-step height;
    // the irregular renderer surface shares these collision extrema.
    box('north-earth-shoulder-west', [-41, 0, -37.6], [-38.6, 0.18, -34.2], 'platform', COLORS.terrainLight),
    box('north-earth-knoll-west', [-41, 0, -40.2], [-35.8, 0.38, -35.2], 'platform', COLORS.terrain),
    box('north-earth-knoll-outcrop-west', [-39.9, 0.38, -39.4], [-37, 1.7, -36.3], 'cover', COLORS.terrainLight),
    box('north-earth-shoulder-east', [38.6, 0, -37.6], [41, 0.18, -34.2], 'platform', COLORS.terrainLight),
    box('north-earth-knoll-east', [35.8, 0, -40.2], [41, 0.38, -35.2], 'platform', COLORS.terrain),
    box('north-earth-knoll-outcrop-east', [37, 0.38, -39.4], [39.9, 1.7, -36.3], 'cover', COLORS.terrainLight),

    // South hydroponics lane: denser, lower cover for shotgun fights and flag
    // flanks. Beyond the earth planters is a roofed greenhouse laboratory with
    // a central door, glass-wall locations and two interior grow beds.
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
    box('south-greenhouse-floor', [-9, 0, 29.2], [9, 0.15, 35.6], 'platform', COLORS.terrainLight),
    box('south-greenhouse-core', [-9, 0.15, 35.6], [9, 4.2, 36.3], 'cover', COLORS.graphite),
    box('south-greenhouse-west', [-9, 0.15, 29.2], [-8.3, 4.2, 35.6], 'cover', COLORS.ceramicDark),
    box('south-greenhouse-east', [8.3, 0.15, 29.2], [9, 4.2, 35.6], 'cover', COLORS.ceramicDark),
    box('south-greenhouse-front-west', [-9, 0.15, 28.5], [-2.2, 4.2, 29.2], 'cover', COLORS.ceramic),
    box('south-greenhouse-front-east', [2.2, 0.15, 28.5], [9, 4.2, 29.2], 'cover', COLORS.ceramic),
    box('south-greenhouse-lintel', [-2.2, 3.15, 28.5], [2.2, 4.2, 29.2], 'cover', COLORS.graphite),
    box('south-greenhouse-roof', [-9, 4.2, 29.2], [9, 4.48, 35.6], 'platform', COLORS.ceramicDark),
    box('south-greenhouse-growbed-west', [-6.8, 0.15, 30.7], [-3.2, 1.08, 34.4], 'cover', COLORS.terrainLight),
    box('south-greenhouse-growbed-east', [3.2, 0.15, 30.7], [6.8, 1.08, 34.4], 'cover', COLORS.terrainLight),
    box('south-mid-cover-west', [-16.5, 0, 18.5], [-12.5, 2.2, 22], 'cover', COLORS.terrainLight),
    box('south-mid-cover-east', [12.5, 0, 18.5], [16.5, 2.2, 22], 'cover', COLORS.terrainLight),
    box('south-mid-slab-west', [-7.2, 0, 18.8], [-3.2, 1.25, 21.5], 'cover', COLORS.ceramicDark),
    box('south-mid-slab-east', [3.2, 0, 18.8], [7.2, 1.25, 21.5], 'cover', COLORS.ceramicDark),
    box('south-earth-approach-west', [-49, 0, 33.2], [-45, 0.16, 34.8], 'platform', COLORS.terrainLight),
    box('south-earth-berm-west', [-49, 0, 34.8], [-41, 0.34, 39.5], 'platform', COLORS.terrain),
    box('south-earth-outcrop-west', [-47.4, 0.34, 36], [-44, 1.42, 38.4], 'cover', COLORS.terrainLight),
    box('south-earth-approach-east', [45, 0, 33.2], [49, 0.16, 34.8], 'platform', COLORS.terrainLight),
    box('south-earth-berm-east', [41, 0, 34.8], [49, 0.34, 39.5], 'platform', COLORS.terrain),
    box('south-earth-outcrop-east', [44, 0.34, 36], [47.4, 1.42, 38.4], 'cover', COLORS.terrainLight),
    box('south-earth-shoulder-west', [-41, 0, 34.2], [-38.6, 0.18, 37.6], 'platform', COLORS.terrainLight),
    box('south-earth-knoll-west', [-41, 0, 35.2], [-35.8, 0.38, 40.2], 'platform', COLORS.terrain),
    box('south-earth-knoll-outcrop-west', [-39.9, 0.38, 36.3], [-37, 1.7, 39.4], 'cover', COLORS.terrainLight),
    box('south-earth-shoulder-east', [38.6, 0, 34.2], [41, 0.18, 37.6], 'platform', COLORS.terrainLight),
    box('south-earth-knoll-east', [35.8, 0, 35.2], [41, 0.38, 40.2], 'platform', COLORS.terrain),
    box('south-earth-knoll-outcrop-east', [37, 0.38, 36.3], [39.9, 1.7, 39.4], 'cover', COLORS.terrainLight),

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
    { position: point(-42.5, 0.39, 0), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-42.5, 0.39, -7), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-40.7, 0.39, 7), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-35, 0.05, -18), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-35, 0.05, 18), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-29.5, 1.45, -29), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-29.5, 1.25, 29), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-25, 0.05, -10), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-25, 0.05, 10), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-15, 0.05, -7), yaw: -Math.PI / 2, team: 'aurora' },

    { position: point(42.5, 0.39, 0), yaw: Math.PI / 2, team: 'nova' },
    { position: point(42.5, 0.39, -7), yaw: Math.PI / 2, team: 'nova' },
    { position: point(40.7, 0.39, 7), yaw: Math.PI / 2, team: 'nova' },
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
    point(-43, 0.39, 0), point(-39.8, 0.39, 0), point(-38.2, 0.3, 0), point(-36.8, 0.17, 0), point(-32, 0.05, 0),
    point(-36, 0.05, -14), point(-36, 0.05, 14),
    point(-29, 0.05, -9), point(-29, 0.05, 9), point(-24, 1.3, 0),
    point(-18, 0.05, -7), point(-18, 0.05, 7), point(-14.2, 0.05, 0),
    point(-12.4, 0.05, 0), point(-10, 0.05, -10), point(-10, 0.05, 10),
    // Central deck and its four escape corners.
    point(-7.4, 6, -6.5), point(-7.4, 6, 6.5), point(7.4, 6, -6.5), point(7.4, 6, 6.5),
    point(12.4, 0.05, 0), point(14.2, 0.05, 0), point(18, 0.05, -7), point(18, 0.05, 7),
    point(24, 1.3, 0), point(29, 0.05, -9), point(29, 0.05, 9),
    point(32, 0.05, 0), point(36.8, 0.17, 0), point(38.2, 0.3, 0), point(39.8, 0.39, 0),
    point(36, 0.05, -14), point(36, 0.05, 14), point(43, 0.39, 0),
    // North observatory circuit.
    point(-43, 0.05, -25), point(-34, 0.05, -35), point(-30, 1.45, -29), point(-17, 0.65, -30),
    point(-13, 0.05, -27), point(-8.8, 0.05, -28), point(-2, 0.05, -28), point(0, 0.21, -32.5),
    point(2, 0.05, -28), point(8.8, 0.05, -28),
    point(13, 0.05, -27), point(17, 0.65, -30), point(30, 1.45, -29), point(34, 0.05, -35), point(43, 0.05, -25),
    // South hydroponics circuit.
    point(-43, 0.05, 25), point(-34, 0.05, 35), point(-30, 1.25, 29), point(-18, 0.6, 30),
    point(-14, 0.05, 25), point(-6, 0.05, 26), point(0, 0.05, 26), point(0, 0.2, 32.2), point(6, 0.05, 26),
    point(14, 0.05, 25), point(18, 0.6, 30), point(30, 1.25, 29), point(34, 0.05, 35), point(43, 0.05, 25),
  ],
  jumpPads: [...JUMP_PAD_ZONES],
  pickups: [
    { id: 'pickup-sniper', kind: 'weapon', weaponId: 'sniper', position: point(0, 6.38, -5.8), respawnSeconds: 50 },
    { id: 'pickup-rocket', kind: 'weapon', weaponId: 'rocket-launcher', position: point(0, 0.56, -33.3), respawnSeconds: 60 },
    { id: 'pickup-shotgun', kind: 'weapon', weaponId: 'shotgun', position: point(0, 0.55, 32.2), respawnSeconds: 35 },
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
    aurora: point(-42.5, 0.72, 0),
    nova: point(42.5, 0.72, 0),
  },
  towerCenter: point(0, TOWER_CENTER_Y, 0),
  towerZone: { radius: 7, controlMinY: 5.15, patrolRadius: 5.45 },
};

export const UMBRA_STATION: MapDefinition = createUmbraStation(TOWER_TURRET_LAYOUT);

export const MAPS: Record<MapDefinition['id'], MapDefinition> = {
  'crater-ridge': CRATER_RIDGE,
  'umbra-station': UMBRA_STATION,
};

export const jumpPadAt = (position: Vec3, map: MapDefinition = CRATER_RIDGE): JumpPadZone | null =>
  map.jumpPads.find((pad) =>
    Math.abs(position.x - pad.center.x) <= pad.halfSize.x
    && Math.abs(position.z - pad.center.z) <= pad.halfSize.z
    && position.y < 1.8,
  ) ?? null;

export const isJumpPad = (position: Vec3, map: MapDefinition = CRATER_RIDGE): boolean =>
  jumpPadAt(position, map) !== null;
