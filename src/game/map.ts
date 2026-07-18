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

export const CRATER_RIDGE: MapDefinition = {
  id: 'crater-ridge',
  name: 'Cresta del Cráter',
  bounds: { minX: -36, maxX: 36, minZ: -30, maxZ: 30, floorY: 0, ceilingY: 18 },
  obstacles: [
    box('north-wall', [-36, 0, -31], [36, 7, -30], 'wall', 0x315c68),
    box('south-wall', [-36, 0, 30], [36, 7, 31], 'wall', 0x315c68),
    box('west-wall', [-37, 0, -30], [-36, 7, 30], 'wall', 0x294e5d),
    box('east-wall', [36, 0, -30], [37, 7, 30], 'wall', 0x294e5d),

    box('tower-core', [-4.2, 0, -4.2], [4.2, 5.3, 4.2], 'tower', 0x274b63),
    box('tower-deck', [-7, 5.3, -7], [7, 5.85, 7], 'platform', 0x4a7683),
    box('tower-cap', [-2.2, 5.85, -2.2], [2.2, 7.7, 2.2], 'cover', 0x17394d),
    box('tower-rail-n', [-7, 5.85, -7], [7, 6.65, -6.55], 'cover', 0x60909a),
    box('tower-rail-s', [-7, 5.85, 6.55], [7, 6.65, 7], 'cover', 0x60909a),
    box('tower-rail-w', [-7, 5.85, -6.55], [-6.55, 6.65, 6.55], 'cover', 0x60909a),
    box('tower-rail-e', [6.55, 5.85, -6.55], [7, 6.65, 6.55], 'cover', 0x60909a),

    box('west-base', [-32, 0, -8], [-24, 0.8, 8], 'platform', 0x34546d),
    box('west-base-back', [-34, 0, -10], [-32, 6, 10], 'wall', 0x203d57),
    box('west-base-cover-n', [-24, 0, -8], [-21, 3.1, -5], 'cover', 0x567d86),
    box('west-base-cover-s', [-24, 0, 5], [-21, 3.1, 8], 'cover', 0x567d86),
    box('east-base', [24, 0, -8], [32, 0.8, 8], 'platform', 0x4c4c78),
    box('east-base-back', [32, 0, -10], [34, 6, 10], 'wall', 0x33345f),
    box('east-base-cover-n', [21, 0, -8], [24, 3.1, -5], 'cover', 0x75769b),
    box('east-base-cover-s', [21, 0, 5], [24, 3.1, 8], 'cover', 0x75769b),

    box('north-ridge-west', [-25, 0, -24], [-10, 3.5, -19], 'platform', 0x3d6972),
    box('north-ridge-east', [10, 0, -24], [25, 3.5, -19], 'platform', 0x526b81),
    box('south-ridge-west', [-27, 0, 19], [-12, 2.7, 24], 'platform', 0x476f72),
    box('south-ridge-east', [12, 0, 19], [27, 2.7, 24], 'platform', 0x5e6683),

    box('cover-nw-a', [-17, 0, -12], [-13, 2.4, -8], 'cover', 0x517c80),
    box('cover-nw-b', [-12, 0, -17], [-8, 1.8, -13], 'cover', 0x416f7a),
    box('cover-ne-a', [13, 0, -12], [17, 2.4, -8], 'cover', 0x69748f),
    box('cover-ne-b', [8, 0, -17], [12, 1.8, -13], 'cover', 0x596987),
    box('cover-sw-a', [-17, 0, 8], [-13, 2.4, 12], 'cover', 0x547d78),
    box('cover-sw-b', [-12, 0, 13], [-8, 1.8, 17], 'cover', 0x4b7378),
    box('cover-se-a', [13, 0, 8], [17, 2.4, 12], 'cover', 0x72728c),
    box('cover-se-b', [8, 0, 13], [12, 1.8, 17], 'cover', 0x626c88),

  ],
  spawns: [
    { position: point(-29, 0.85, 0), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-27, 0.05, -15), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-27, 0.05, 15), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-18, 0.05, -25), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-18, 0.05, 25), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-12, 0.05, -5), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-12, 0.05, 5), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(-23, 0.05, 11), yaw: -Math.PI / 2, team: 'aurora' },
    { position: point(29, 0.85, 0), yaw: Math.PI / 2, team: 'nova' },
    { position: point(27, 0.05, -15), yaw: Math.PI / 2, team: 'nova' },
    { position: point(27, 0.05, 15), yaw: Math.PI / 2, team: 'nova' },
    { position: point(18, 0.05, -25), yaw: Math.PI / 2, team: 'nova' },
    { position: point(18, 0.05, 25), yaw: Math.PI / 2, team: 'nova' },
    { position: point(12, 0.05, -5), yaw: Math.PI / 2, team: 'nova' },
    { position: point(12, 0.05, 5), yaw: Math.PI / 2, team: 'nova' },
    { position: point(23, 0.05, -11), yaw: Math.PI / 2, team: 'nova' },
    { position: point(0, 0.05, -27), yaw: 0, team: 'neutral' },
    { position: point(0, 0.05, 27), yaw: Math.PI, team: 'neutral' },
    { position: point(-18, 0.05, 0), yaw: -Math.PI / 2, team: 'neutral' },
    { position: point(18, 0.05, 0), yaw: Math.PI / 2, team: 'neutral' },
  ],
  waypoints: [
    point(-29, 0.85, 0), point(-24, 0, -12), point(-24, 0, 12), point(-15, 0, -20), point(-15, 0, 20),
    point(-12, 0, 0), point(-9.6, 0, 0), point(-5.8, 5.9, 0), point(-9, 0, -10), point(-9, 0, 10), point(0, 0, -15), point(0, 0, 15),
    point(-4.5, 5.9, -4), point(-4.5, 5.9, 4), point(4.5, 5.9, -4), point(4.5, 5.9, 4), point(5.8, 5.9, 0), point(9.6, 0, 0), point(9, 0, -10), point(9, 0, 10), point(12, 0, 0), point(15, 0, -20),
    point(15, 0, 20), point(24, 0, -12), point(24, 0, 12), point(29, 0.85, 0),
  ],
  pickups: [
    { id: 'pickup-sniper', kind: 'weapon', weaponId: 'sniper', position: point(-4.6, 6.25, 0), respawnSeconds: 45 },
    { id: 'pickup-shotgun', kind: 'weapon', weaponId: 'shotgun', position: point(0, 0.45, 10), respawnSeconds: 30 },
    { id: 'pickup-rocket', kind: 'weapon', weaponId: 'rocket-launcher', position: point(0, 0.45, -24), respawnSeconds: 60 },
    { id: 'pickup-battle-west', kind: 'weapon', weaponId: 'battle-rifle', position: point(-20, 0.45, -15), respawnSeconds: 25 },
    { id: 'pickup-battle-east', kind: 'weapon', weaponId: 'battle-rifle', position: point(20, 0.45, 15), respawnSeconds: 25 },
    { id: 'pickup-overshield', kind: 'overshield', position: point(0, 0.45, 24), respawnSeconds: 60 },
    { id: 'pickup-ammo-west', kind: 'ammo', position: point(-19, 0.45, 14), respawnSeconds: 15 },
    { id: 'pickup-ammo-east', kind: 'ammo', position: point(19, 0.45, -14), respawnSeconds: 15 },
    { id: 'pickup-grenade-west', kind: 'grenade', position: point(-8, 0.45, -20), respawnSeconds: 20 },
    { id: 'pickup-grenade-east', kind: 'grenade', position: point(8, 0.45, 20), respawnSeconds: 20 },
  ],
  flagBases: {
    aurora: point(-29, 1.15, 0),
    nova: point(29, 1.15, 0),
  },
  towerCenter: point(0, 6, 0),
};

export const MAPS: Record<MapDefinition['id'], MapDefinition> = {
  'crater-ridge': CRATER_RIDGE,
};

export const isJumpPad = (position: Vec3): boolean =>
  (Math.abs(position.x + 9.6) < 1.6 || Math.abs(position.x - 9.6) < 1.6) && Math.abs(position.z) < 2.5 && position.y < 1.8;
