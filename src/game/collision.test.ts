import { describe, expect, it } from 'vitest';

import { moveCapsule } from './collision';
import type { AabbObstacle, MapDefinition, PlayerState, Vec3 } from './types';

const box = (
  id: string,
  min: Vec3,
  max: Vec3,
): AabbObstacle => ({ id, min, max, kind: 'wall', color: 0xffffff });

const createMap = (obstacles: AabbObstacle[] = []): MapDefinition => ({
  id: 'crater-ridge',
  name: 'Collision test arena',
  bounds: { minX: -8, maxX: 8, minZ: -8, maxZ: 8, floorY: 0, ceilingY: 8 },
  obstacles,
  spawns: [],
  waypoints: [],
  pickups: [],
  flagBases: {
    aurora: { x: -6, y: 0, z: 0 },
    nova: { x: 6, y: 0, z: 0 },
  },
  towerCenter: { x: 0, y: 0, z: 0 },
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
