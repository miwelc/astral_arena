import { describe, expect, it } from 'vitest';

import { hasLineOfSight, raycastWorld } from './collision';
import { CRATER_RIDGE, TITAN_EXPANSE, UMBRA_STATION } from './map';
import type { AabbObstacle, MapDefinition, Vec3 } from './types';

const EPSILON = 0.00001;

const linearRayAabb = (
  origin: Vec3,
  direction: Vec3,
  obstacle: AabbObstacle,
): number | null => {
  let near = -Infinity;
  let far = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(direction[axis]) < EPSILON) {
      if (origin[axis] < obstacle.min[axis] || origin[axis] > obstacle.max[axis]) return null;
      continue;
    }
    const first = (obstacle.min[axis] - origin[axis]) / direction[axis];
    const second = (obstacle.max[axis] - origin[axis]) / direction[axis];
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }
  if (far < 0) return null;
  return Math.max(0, near);
};

const linearObstacleHit = (
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  map: MapDefinition,
): { obstacleId: string; distance: number } | null => {
  let nearestDistance = Number.POSITIVE_INFINITY;
  let obstacleId: string | null = null;
  for (const obstacle of map.obstacles) {
    const distance = linearRayAabb(origin, direction, obstacle);
    if (distance !== null && distance <= maxDistance && distance < nearestDistance) {
      nearestDistance = distance;
      obstacleId = obstacle.id;
    }
  }
  return obstacleId ? { obstacleId, distance: nearestDistance } : null;
};

const linearLineOfSight = (from: Vec3, to: Vec3, map: MapDefinition): boolean => {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const deltaZ = to.z - from.z;
  const distanceSquared = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
  if (distanceSquared < EPSILON) return true;
  const distance = Math.sqrt(distanceSquared);
  const inverseDistance = 1 / distance;
  const direction = {
    x: deltaX * inverseDistance,
    y: deltaY * inverseDistance,
    z: deltaZ * inverseDistance,
  };
  for (const obstacle of map.obstacles) {
    const hit = linearRayAabb(from, direction, obstacle);
    if (hit !== null && hit < distance - 0.08) return false;
  }
  return true;
};

const createRandom = (initialSeed: number): (() => number) => {
  let seed = initialSeed >>> 0;
  return () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 0x1_0000_0000;
  };
};

const randomBetween = (random: () => number, minimum: number, maximum: number): number =>
  minimum + (maximum - minimum) * random();

const withoutTerrainSurface = (map: MapDefinition): MapDefinition => {
  const obstacleOnlyMap = { ...map };
  delete obstacleOnlyMap.groundHeightAt;
  return obstacleOnlyMap;
};

describe('obstacle BVH differential', () => {
  it.each([
    ['Crater Ridge', CRATER_RIDGE, 0xc0ffee, 4_000],
    ['Umbra Station', UMBRA_STATION, 0x51a710, 4_000],
    // Titan's authoritative raycast also intersects its smooth heightfield.
    // Remove only that surface so this AABB reference remains a pure BVH differential.
    ['Titan Expanse obstacles', withoutTerrainSurface(TITAN_EXPANSE), 0x717a9, 2_500],
  ] as const)('matches the linear reference exactly across %s', (_name, map, seed, samples) => {
    const random = createRandom(seed);
    const failures: string[] = [];
    for (let index = 0; index < samples; index += 1) {
      const origin = {
        x: randomBetween(random, map.bounds.minX - 8, map.bounds.maxX + 8),
        y: randomBetween(random, map.bounds.floorY - 2, map.bounds.ceilingY + 2),
        z: randomBetween(random, map.bounds.minZ - 8, map.bounds.maxZ + 8),
      };
      const target = {
        x: randomBetween(random, map.bounds.minX - 4, map.bounds.maxX + 4),
        y: randomBetween(random, map.bounds.floorY - 1, map.bounds.ceilingY + 1),
        z: randomBetween(random, map.bounds.minZ - 4, map.bounds.maxZ + 4),
      };
      let deltaX = target.x - origin.x;
      let deltaY = target.y - origin.y;
      let deltaZ = target.z - origin.z;
      // Include exact parallel slabs as well as general oblique rays.
      if (index % 17 === 0) deltaX = 0;
      if (index % 23 === 0) deltaY = 0;
      if (index % 29 === 0) deltaZ = 0;
      const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ) || 1;
      const direction = { x: deltaX / magnitude, y: deltaY / magnitude, z: deltaZ / magnitude };
      const maxDistance = randomBetween(random, 0.25, 180);
      const expectedHit = linearObstacleHit(origin, direction, maxDistance, map);
      const actualHit = raycastWorld(origin, direction, maxDistance, map, []);
      if (
        actualHit?.obstacleId !== expectedHit?.obstacleId
        || actualHit?.distance !== expectedHit?.distance
      ) {
        failures.push(`ray ${index}: ${JSON.stringify({ expectedHit, actualHit })}`);
      }

      const expectedVisibility = linearLineOfSight(origin, target, map);
      const actualVisibility = hasLineOfSight(origin, target, map);
      if (actualVisibility !== expectedVisibility) {
        failures.push(`LOS ${index}: expected ${expectedVisibility}, received ${actualVisibility}`);
      }
      if (failures.length >= 10) break;
    }
    expect(failures).toEqual([]);
  });

  it('preserves original-order ties and zero-distance hits from inside boxes', () => {
    const duplicate = (id: string): AabbObstacle => ({
      id,
      min: { x: -1, y: -1, z: 2 },
      max: { x: 1, y: 1, z: 4 },
      kind: 'wall',
      color: 0xffffff,
    });
    const map: MapDefinition = {
      ...CRATER_RIDGE,
      obstacles: [duplicate('first'), duplicate('second')],
    };
    expect(raycastWorld({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 10, map, [])).toMatchObject({
      obstacleId: 'first',
      distance: 2,
    });
    expect(raycastWorld({ x: 0, y: 0, z: 3 }, { x: 1, y: 0, z: 0 }, 10, map, [])).toMatchObject({
      obstacleId: 'first',
      distance: 0,
    });
  });

  it('rebuilds after the obstacle list changes', () => {
    const map: MapDefinition = { ...CRATER_RIDGE, obstacles: [...CRATER_RIDGE.obstacles] };
    const origin = { x: 0, y: 12, z: 0 };
    const direction = { x: 0, y: 1, z: 0 };
    expect(raycastWorld(origin, direction, 5, map, [])).toBeNull();
    map.obstacles.splice(1, 0, {
      id: 'dynamic-obstacle',
      min: { x: -1, y: 13, z: -1 },
      max: { x: 1, y: 14, z: 1 },
      kind: 'wall',
      color: 0xffffff,
    });
    expect(raycastWorld(origin, direction, 5, map, [])).toMatchObject({
      obstacleId: 'dynamic-obstacle',
      distance: 1,
    });
  });
});
