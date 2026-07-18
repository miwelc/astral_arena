import { add, clamp, dot, EPSILON, lengthSquared, scale, subtract } from './math';
import type { AabbObstacle, MapDefinition, PlayerState, RayHit, Vec3 } from './types';

const insideHorizontal = (position: Vec3, obstacle: AabbObstacle, margin = 0): boolean =>
  position.x >= obstacle.min.x - margin &&
  position.x <= obstacle.max.x + margin &&
  position.z >= obstacle.min.z - margin &&
  position.z <= obstacle.max.z + margin;

const overlapsVertical = (feetY: number, height: number, obstacle: AabbObstacle): boolean =>
  feetY < obstacle.max.y - 0.02 && feetY + height > obstacle.min.y + 0.02;

export interface MovementResult {
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  hitWall: boolean;
}

export const moveCapsule = (
  player: Pick<PlayerState, 'position' | 'velocity' | 'radius' | 'height' | 'grounded'>,
  map: MapDefinition,
  dt: number,
): MovementResult => {
  const previous = { ...player.position };
  const position = { ...player.position };
  const velocity = { ...player.velocity };
  let hitWall = false;

  position.x += velocity.x * dt;
  for (const obstacle of map.obstacles) {
    if (!overlapsVertical(position.y, player.height, obstacle) || !insideHorizontal(position, obstacle, player.radius)) continue;
    if (previous.x <= obstacle.min.x - player.radius) position.x = obstacle.min.x - player.radius;
    else if (previous.x >= obstacle.max.x + player.radius) position.x = obstacle.max.x + player.radius;
    else position.x = previous.x;
    velocity.x = 0;
    hitWall = true;
  }

  position.z += velocity.z * dt;
  for (const obstacle of map.obstacles) {
    if (!overlapsVertical(position.y, player.height, obstacle) || !insideHorizontal(position, obstacle, player.radius)) continue;
    if (previous.z <= obstacle.min.z - player.radius) position.z = obstacle.min.z - player.radius;
    else if (previous.z >= obstacle.max.z + player.radius) position.z = obstacle.max.z + player.radius;
    else position.z = previous.z;
    velocity.z = 0;
    hitWall = true;
  }

  position.x = clamp(position.x, map.bounds.minX + player.radius, map.bounds.maxX - player.radius);
  position.z = clamp(position.z, map.bounds.minZ + player.radius, map.bounds.maxZ - player.radius);

  const nextY = position.y + velocity.y * dt;
  let resolvedY = nextY;
  let grounded = false;

  if (velocity.y <= 0) {
    let floor = map.bounds.floorY;
    for (const obstacle of map.obstacles) {
      if (!insideHorizontal(position, obstacle, Math.max(0, player.radius - 0.08))) continue;
      const top = obstacle.max.y;
      if (previous.y >= top - 0.08 && nextY <= top + 0.08 && top > floor) floor = top;
    }
    if (resolvedY <= floor) {
      resolvedY = floor;
      velocity.y = 0;
      grounded = true;
    }
  } else {
    for (const obstacle of map.obstacles) {
      if (!insideHorizontal(position, obstacle, player.radius * 0.75)) continue;
      const previousHead = previous.y + player.height;
      const nextHead = nextY + player.height;
      if (previousHead <= obstacle.min.y && nextHead >= obstacle.min.y) {
        resolvedY = obstacle.min.y - player.height;
        velocity.y = 0;
        break;
      }
    }
  }

  position.y = clamp(resolvedY, map.bounds.floorY, map.bounds.ceilingY - player.height);
  return { position, velocity, grounded, hitWall };
};

const raySphere = (origin: Vec3, direction: Vec3, center: Vec3, radius: number): number | null => {
  const offset = subtract(origin, center);
  const b = dot(offset, direction);
  const c = lengthSquared(offset) - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (near >= 0) return near;
  return far >= 0 ? far : null;
};

const rayAabb = (origin: Vec3, direction: Vec3, obstacle: AabbObstacle): number | null => {
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

export const raycastWorld = (
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  map: MapDefinition,
  players: Iterable<PlayerState>,
  ignoredPlayerId?: string,
): RayHit | null => {
  let result: RayHit | null = null;
  const consider = (hit: RayHit): void => {
    if (hit.distance > maxDistance) return;
    if (!result || hit.distance < result.distance) result = hit;
  };

  for (const obstacle of map.obstacles) {
    const distance = rayAabb(origin, direction, obstacle);
    if (distance !== null) consider({ distance, point: add(origin, scale(direction, distance)), obstacleId: obstacle.id });
  }

  for (const player of players) {
    if (!player.alive || player.id === ignoredPlayerId) continue;
    const bodyCenter = { x: player.position.x, y: player.position.y + player.height * 0.47, z: player.position.z };
    const headCenter = { x: player.position.x, y: player.position.y + player.height * 0.86, z: player.position.z };
    const bodyDistance = raySphere(origin, direction, bodyCenter, player.radius * 1.02);
    const headDistance = raySphere(origin, direction, headCenter, player.radius * 0.58);
    if (bodyDistance !== null) {
      consider({ distance: bodyDistance, point: add(origin, scale(direction, bodyDistance)), playerId: player.id, headshot: false });
    }
    if (headDistance !== null) {
      consider({ distance: headDistance, point: add(origin, scale(direction, headDistance)), playerId: player.id, headshot: true });
    }
  }
  return result;
};

export const hasLineOfSight = (from: Vec3, to: Vec3, map: MapDefinition): boolean => {
  const delta = subtract(to, from);
  const distanceSquaredValue = lengthSquared(delta);
  if (distanceSquaredValue < EPSILON) return true;
  const distance = Math.sqrt(distanceSquaredValue);
  const direction = scale(delta, 1 / distance);
  for (const obstacle of map.obstacles) {
    const hit = rayAabb(from, direction, obstacle);
    if (hit !== null && hit < distance - 0.08) return false;
  }
  return true;
};

export const pointInsideObstacle = (position: Vec3, map: MapDefinition): boolean =>
  map.obstacles.some(
    (obstacle) =>
      position.x > obstacle.min.x &&
      position.x < obstacle.max.x &&
      position.y > obstacle.min.y &&
      position.y < obstacle.max.y &&
      position.z > obstacle.min.z &&
      position.z < obstacle.max.z,
  );
