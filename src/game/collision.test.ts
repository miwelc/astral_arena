import { describe, expect, it } from 'vitest';

import { hasLineOfSight, moveCapsule, raycastWorld } from './collision';
import { CRATER_RIDGE } from './map';
import type { AabbObstacle, MapDefinition, PlayerState, Vec3 } from './types';

const box = (
  id: string,
  min: Vec3,
  max: Vec3,
  kind: AabbObstacle['kind'] = 'wall',
): AabbObstacle => ({ id, min, max, kind, color: 0xffffff });

const createMap = (obstacles: AabbObstacle[] = []): MapDefinition => ({
  id: 'crater-ridge',
  name: 'Collision test arena',
  bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8, floorY: 0, ceilingY: 8 },
  obstacles,
  spawns: [],
  waypoints: [],
  jumpPads: [],
  pickups: [],
  flagBases: {
    aurora: { x: -6, y: 0, z: 0 },
    nova: { x: 6, y: 0, z: 0 },
  },
  towerCenter: { x: 0, y: 0, z: 0 },
  towerZone: { radius: 2, controlMinY: 0, patrolRadius: 1 },
});

const player = (
  position: Vec3,
  velocity: Vec3,
): Pick<PlayerState, 'position' | 'velocity' | 'radius' | 'height' | 'grounded'> => ({
  position,
  velocity,
  radius: 0.5,
  height: 2,
  grounded: true,
});

const verticalWall = box(
  'vertical-wall',
  { x: 0, y: 0, z: -5 },
  { x: 1, y: 3, z: 5 },
);

describe('capsule wall sliding', () => {
  it('preserves tangential movement while already touching a wall', () => {
    const result = moveCapsule(
      player({ x: -0.5, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }),
      createMap([verticalWall]),
      0.25,
    );

    expect(result.position).toMatchObject({ x: -0.5, z: 1 });
    expect(result.velocity).toMatchObject({ x: 0, z: 4 });
    expect(result.hitWall).toBe(false);
  });

  it('turns diagonal impact into a smooth wall slide', () => {
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 3 }),
      createMap([verticalWall]),
      0.25,
    );

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.z).toBeCloseTo(0.75);
    expect(result.velocity.x).toBe(0);
    expect(result.velocity.z).toBe(3);
    expect(result.hitWall).toBe(true);
  });

  it('allows immediate movement away from a contacted wall', () => {
    const result = moveCapsule(
      player({ x: -0.5, y: 0, z: 0 }, { x: -2, y: 0, z: 1 }),
      createMap([verticalWall]),
      0.5,
    );

    expect(result.position).toMatchObject({ x: -1.5, z: 0.5 });
    expect(result.velocity).toMatchObject({ x: -2, z: 1 });
    expect(result.hitWall).toBe(false);
  });

  it('stops both blocked components at an inside corner without penetration', () => {
    const horizontalWall = box(
      'horizontal-wall',
      { x: -5, y: 0, z: 0 },
      { x: 5, y: 3, z: 1 },
    );
    const result = moveCapsule(
      player({ x: -1, y: 0, z: -1 }, { x: 4, y: 0, z: 4 }),
      createMap([verticalWall, horizontalWall]),
      0.25,
    );

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.z).toBeCloseTo(-0.5);
    expect(result.velocity).toMatchObject({ x: 0, z: 0 });
    expect(result.hitWall).toBe(true);
  });

  it('releases immediately when moving out of an inside corner', () => {
    const horizontalWall = box(
      'horizontal-wall',
      { x: -5, y: 0, z: 0 },
      { x: 5, y: 3, z: 1 },
    );
    const result = moveCapsule(
      player({ x: -0.5, y: 0, z: -0.5 }, { x: -2, y: 0, z: -2 }),
      createMap([verticalWall, horizontalWall]),
      0.5,
    );

    expect(result.position).toMatchObject({ x: -1.5, z: -1.5 });
    expect(result.velocity).toMatchObject({ x: -2, z: -2 });
    expect(result.hitWall).toBe(false);
  });

  it('slides along arena bounds and cancels only the outward component', () => {
    const result = moveCapsule(
      player({ x: -7.5, y: 0, z: 0 }, { x: -2, y: 0, z: 3 }),
      createMap(),
      0.5,
    );

    expect(result.position).toMatchObject({ x: -7.5, z: 1.5 });
    expect(result.velocity).toMatchObject({ x: 0, z: 3 });
    expect(result.hitWall).toBe(true);
  });
});

describe('capsule auto-step', () => {
  const shallowPlatform = box(
    'shallow-platform',
    { x: 0, y: 0, z: -2 },
    { x: 3, y: 0.34, z: 2 },
    'platform',
  );

  it('walks smoothly onto a shallow platform without losing forward speed', () => {
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      createMap([shallowPlatform]),
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.2);
    expect(result.position.y).toBeCloseTo(0.34);
    expect(result.position.z).toBeCloseTo(0);
    expect(result.velocity).toMatchObject({ x: 4, y: 0, z: 0 });
    expect(result.grounded).toBe(true);
    expect(result.hitWall).toBe(false);
  });

  it('does not stall when a short frame only moves slightly past the tread edge', () => {
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      createMap([shallowPlatform]),
      0.13,
    );

    expect(result.position.x).toBeCloseTo(-0.48);
    expect(result.position.y).toBeCloseTo(0.34);
    expect(result.velocity.x).toBe(4);
    expect(result.grounded).toBe(true);
    expect(result.hitWall).toBe(false);
  });

  it('preserves both components while stepping onto a platform diagonally', () => {
    const result = moveCapsule(
      player({ x: -1, y: 0, z: -0.6 }, { x: 4, y: 0, z: 2 }),
      createMap([shallowPlatform]),
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.2);
    expect(result.position.y).toBeCloseTo(0.34);
    expect(result.position.z).toBeCloseTo(-0.2);
    expect(result.velocity).toMatchObject({ x: 4, y: 0, z: 2 });
    expect(result.grounded).toBe(true);
    expect(result.hitWall).toBe(false);
  });

  it('allows a descending capsule to settle onto a shallow tread', () => {
    const descending = {
      ...player({ x: -1, y: 0.1, z: 0 }, { x: 4, y: -0.5, z: 0 }),
      grounded: false,
    };
    const result = moveCapsule(descending, createMap([shallowPlatform]), 0.2);

    expect(result.position.x).toBeCloseTo(-0.2);
    expect(result.position.y).toBeCloseTo(0.34);
    expect(result.position.z).toBeCloseTo(0);
    expect(result.velocity).toMatchObject({ x: 4, y: 0, z: 0 });
    expect(result.grounded).toBe(true);
  });

  it('does not auto-step while an airborne capsule is ascending', () => {
    const ascending = {
      ...player({ x: -1, y: 0, z: 0 }, { x: 4, y: 1, z: 0 }),
      grounded: false,
    };
    const result = moveCapsule(ascending, createMap([shallowPlatform]), 0.2);

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.y).toBeCloseTo(0.2);
    expect(result.velocity.x).toBe(0);
    expect(result.grounded).toBe(false);
    expect(result.hitWall).toBe(true);
  });

  it('does not climb a platform above the step-height limit', () => {
    const tallPlatform = box(
      'tall-platform',
      { x: 0, y: 0, z: -2 },
      { x: 3, y: 0.55, z: 2 },
      'platform',
    );
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 1 }),
      createMap([tallPlatform]),
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.z).toBeCloseTo(0.2);
    expect(result.velocity).toMatchObject({ x: 0, z: 1 });
    expect(result.hitWall).toBe(true);
  });

  it('never treats low combat cover as a stair tread', () => {
    const lowCover = box(
      'low-cover',
      { x: 0, y: 0, z: -2 },
      { x: 3, y: 0.3, z: 2 },
      'cover',
    );
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      createMap([lowCover]),
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.y).toBe(0);
    expect(result.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('requires enough headroom for the complete stepped capsule', () => {
    const ceiling = box(
      'low-ceiling',
      { x: -0.5, y: 2.1, z: -2 },
      { x: 3, y: 2.4, z: 2 },
      'cover',
    );
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      createMap([shallowPlatform, ceiling]),
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.5);
    expect(result.position.y).toBe(0);
    expect(result.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('walks continuously across the authored loading ramp into a team base', () => {
    let current = player({ x: -35.5, y: 0, z: 0 }, { x: -4, y: 0, z: 0 });
    for (let frame = 0; frame < 80; frame += 1) {
      const result = moveCapsule(current, CRATER_RIDGE, 1 / 60);
      current = {
        ...current,
        position: result.position,
        velocity: result.velocity,
        grounded: result.grounded,
      };
    }

    expect(current.position.x).toBeLessThan(-39.5);
    expect(current.position.y).toBeCloseTo(0.34);
    expect(current.velocity.x).toBe(-4);
    expect(current.grounded).toBe(true);
  });
});

describe('authored terrain relief', () => {
  it('retains below-floor correction recovery on legacy flat maps', () => {
    const result = moveCapsule(
      player({ x: 0, y: -0.2, z: 0 }, { x: 0, y: 2, z: 0 }),
      createMap(),
      0.05,
    );

    expect(result.position.y).toBe(0);
  });

  it('keeps a grounded capsule attached to a smooth rising surface', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => Math.max(0, (x + 1) * 0.2),
    };
    const result = moveCapsule(
      player({ x: -1, y: 0, z: 0 }, { x: 4, y: -1, z: 0 }),
      map,
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.2);
    expect(result.position.y).toBeCloseTo(0.16);
    expect(result.velocity.x).toBe(4);
    expect(result.grounded).toBe(true);
  });

  it('follows a smooth descending surface instead of briefly floating', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => Math.max(0, -x * 0.2),
    };
    const result = moveCapsule(
      player({ x: -1, y: 0.2, z: 0 }, { x: 4, y: -0.2, z: 0 }),
      map,
      0.2,
    );

    expect(result.position.x).toBeCloseTo(-0.2);
    expect(result.position.y).toBeCloseTo(0.04);
    expect(result.grounded).toBe(true);
  });

  it('treats a terrain rise above the auto-step limit as a wall', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => x >= 0 ? 1 : 0,
    };
    const result = moveCapsule(
      player({ x: -0.6, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }),
      map,
      0.2,
    );

    // The leading edge, not the centre, stops at the terrain face.
    expect(result.position.x).toBeCloseTo(-0.5, 2);
    expect(result.velocity.x).toBe(0);
    expect(result.hitWall).toBe(true);
  });

  it('makes a steep slope decision independent of fixed-tick subdivision', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => Math.max(0, (x + 1) * 2),
    };
    const initial = player({ x: -1.6, y: 0, z: 0 }, { x: 6.35, y: 0, z: 0 });
    const single = moveCapsule(initial, map, 0.05);
    let subdivided = initial;
    for (let tick = 0; tick < 3; tick += 1) subdivided = {
      ...subdivided,
      ...moveCapsule(subdivided, map, 1 / 60),
    };

    expect(single.position.x).toBeCloseTo(subdivided.position.x, 2);
    expect(single.velocity.x).toBe(0);
    expect(subdivided.velocity.x).toBe(0);
  });

  it('resolves a symmetric diagonal rise without an X-before-Z bias', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x, z) => Math.max(0, x + z),
    };
    const result = moveCapsule(
      player({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 }),
      map,
      0.3,
    );

    expect(result.position.x).toBeCloseTo(result.position.z, 8);
    expect(result.velocity.x).toBe(result.velocity.z);
  });

  it('blocks an airborne capsule at a lateral rise without lifting its feet', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => x >= 0 ? 0.3 : 0,
    };
    const airborne = {
      ...player({ x: -0.6, y: 0.1, z: 0 }, { x: 4, y: 0.2, z: 0 }),
      grounded: false,
    };
    const result = moveCapsule(airborne, map, 0.2);

    expect(result.position.x).toBeCloseTo(-0.5, 2);
    expect(result.position.y).toBeCloseTo(0.14, 6);
    expect(result.grounded).toBe(false);
    expect(result.hitWall).toBe(true);
  });

  it('blocks shots and sightlines at the rendered terrain surface', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (_x, z) => Math.max(0, 2 - Math.abs(z)),
    };
    const origin = { x: 0, y: 1, z: -4 };
    const target = { x: 0, y: 1, z: 4 };
    const hit = raycastWorld(origin, { x: 0, y: 0, z: 1 }, 8, map, []);

    expect(hit?.obstacleId).toBe('terrain-surface');
    expect(hit?.point.z).toBeLessThan(0);
    expect(hasLineOfSight(origin, target, map)).toBe(false);
  });

  it('finds a smooth crest that rises and falls between coarse ray samples', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: (x) => 1.2 - (x - 0.375) ** 2,
    };
    const origin = { x: 0, y: 1.1, z: 0 };
    const hit = raycastWorld(origin, { x: 1, y: 0, z: 0 }, 0.75, map, []);

    expect(hit?.obstacleId).toBe('terrain-surface');
    expect(hit?.distance).toBeGreaterThan(0);
    expect(hit?.distance).toBeLessThan(0.375);
  });

  it('starts terrain traversal exactly where a ray enters the map bounds', () => {
    const map: MapDefinition = {
      ...createMap(),
      groundHeightAt: () => 2,
    };
    const hit = raycastWorld(
      { x: -10, y: 1, z: 0 },
      { x: 1, y: 0, z: 0 },
      20,
      map,
      [],
    );

    expect(hit?.obstacleId).toBe('terrain-surface');
    expect(hit?.distance).toBeCloseTo(2, 8);
  });

  it('caps terrain traversal at a nearer indexed obstacle', () => {
    let terrainSamples = 0;
    const blocker = box(
      'near-blocker',
      { x: 1, y: 0, z: -1 },
      { x: 2, y: 6, z: 1 },
    );
    const map: MapDefinition = {
      ...createMap([blocker]),
      groundHeightAt: () => {
        terrainSamples += 1;
        return 0;
      },
    };
    const hit = raycastWorld(
      { x: 0, y: 5, z: 0 },
      { x: 1, y: 0, z: 0 },
      100,
      map,
      [],
    );

    expect(hit?.obstacleId).toBe(blocker.id);
    expect(terrainSamples).toBeLessThan(10);
  });
});

describe('combat hitboxes', () => {
  const target = {
    id: 'target',
    alive: true,
    position: { x: 0, y: 0, z: 0 },
    radius: 0.48,
    height: 1.8,
  } as PlayerState;
  const forward = { x: 0, y: 0, z: 1 };

  it('accepts shots that touch the visible edge of the torso armour', () => {
    const hit = raycastWorld(
      { x: 0.54, y: 1.04, z: -4 },
      forward,
      8,
      createMap(),
      [target],
    );

    expect(hit?.playerId).toBe(target.id);
    expect(hit?.headshot).toBe(false);
  });

  it('gives the helmet a forgiving but distinct headshot volume', () => {
    const hit = raycastWorld(
      { x: 0.33, y: 1.65, z: -4 },
      forward,
      8,
      createMap(),
      [target],
    );

    expect(hit?.playerId).toBe(target.id);
    expect(hit?.headshot).toBe(true);
  });

  it('keeps a high-chest shot outside the upper helmet band', () => {
    const hit = raycastWorld(
      { x: 0, y: 1.36, z: -4 },
      forward,
      8,
      createMap(),
      [target],
    );

    expect(hit?.playerId).toBe(target.id);
    expect(hit?.headshot).toBe(false);
  });

  it('keeps the first torso impact when the torso and helmet volumes overlap', () => {
    const hit = raycastWorld(
      { x: 0, y: 1.5, z: -4 },
      forward,
      8,
      createMap(),
      [target],
    );

    expect(hit?.playerId).toBe(target.id);
    expect(hit?.headshot).toBe(false);
  });

  it('still rejects a clearly missed shot outside the armour silhouette', () => {
    const hit = raycastWorld(
      { x: 0.68, y: 1.04, z: -4 },
      forward,
      8,
      createMap(),
      [target],
    );

    expect(hit).toBeNull();
  });
});
