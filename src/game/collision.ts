import { clamp, EPSILON } from './math';
import type { AabbObstacle, MapDefinition, PlayerState, RayHit, Vec3 } from './types';

const insideHorizontal = (position: Vec3, obstacle: AabbObstacle, margin = 0): boolean =>
  position.x >= obstacle.min.x - margin &&
  position.x <= obstacle.max.x + margin &&
  position.z >= obstacle.min.z - margin &&
  position.z <= obstacle.max.z + margin;

const overlapsVertical = (feetY: number, height: number, obstacle: AabbObstacle): boolean =>
  feetY < obstacle.max.y - 0.02 && feetY + height > obstacle.min.y + 0.02;

const CONTACT_EPSILON = 0.0001;
const MAX_AUTO_STEP_HEIGHT = 0.42;
type HorizontalAxis = 'x' | 'z';

/**
 * Checks whether a capsule can occupy a stance at its current feet position.
 * Used before standing up so a low ceiling can never push or trap the player.
 */
export const canOccupyCapsule = (
  position: Vec3,
  radius: number,
  height: number,
  map: MapDefinition,
): boolean => {
  if (height <= 0 || position.y < map.bounds.floorY - CONTACT_EPSILON) return false;
  if (position.y + height > map.bounds.ceilingY - CONTACT_EPSILON) return false;
  return !map.obstacles.some((obstacle) =>
    overlapsVertical(position.y, height, obstacle)
    && insideHorizontal(position, obstacle, radius),
  );
};

export const COMBAT_HITBOX_TUNING = Object.freeze({
  pelvisRadiusPadding: 0.045,
  torsoRadiusPadding: 0.09,
  /** Horizontal helmet allowance; vertical precision is constrained separately. */
  headRadiusScale: 0.74,
  /** The helmet occupies the upper 17% of the authored player height. */
  headCenterHeightScale: 0.915,
  headHalfHeightScale: 0.085,
});

const overlapsExpandedAxis = (
  value: number,
  obstacle: AabbObstacle,
  axis: HorizontalAxis,
  radius: number,
): boolean =>
  value > obstacle.min[axis] - radius + CONTACT_EPSILON
  && value < obstacle.max[axis] + radius - CONTACT_EPSILON;

const segmentIntersectsExpandedFootprint = (
  start: Vec3,
  end: Vec3,
  obstacle: AabbObstacle,
  radius: number,
): boolean => {
  let near = 0;
  let far = 1;
  for (const axis of ['x', 'z'] as const) {
    const delta = end[axis] - start[axis];
    const minimum = obstacle.min[axis] - radius;
    const maximum = obstacle.max[axis] + radius;
    if (Math.abs(delta) < EPSILON) {
      if (start[axis] < minimum || start[axis] > maximum) return false;
      continue;
    }
    const first = (minimum - start[axis]) / delta;
    const second = (maximum - start[axis]) / delta;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return false;
  }
  return far >= 0 && near <= 1;
};

const hasAutoStepHeadroom = (
  start: Vec3,
  target: Vec3,
  feetY: number,
  player: Pick<PlayerState, 'height' | 'radius'>,
  map: MapDefinition,
  supportId: string,
): boolean => {
  if (feetY + player.height > map.bounds.ceilingY - CONTACT_EPSILON) return false;
  for (const obstacle of map.obstacles) {
    if (obstacle.id === supportId || !overlapsVertical(feetY, player.height, obstacle)) continue;
    if (segmentIntersectsExpandedFootprint(start, target, obstacle, player.radius)) return false;
  }
  return true;
};

interface AutoStepResult {
  height: number;
  supportId: string;
}

/**
 * Finds a shallow walkable platform under the intended horizontal endpoint.
 * Only platform geometry participates, so low kerbs and stair treads feel
 * continuous without turning crates, rails, or combat cover into climb aids.
 */
const autoStepHeight = (
  position: Vec3,
  velocity: Vec3,
  player: Pick<PlayerState, 'height' | 'radius' | 'grounded'>,
  map: MapDefinition,
  dt: number,
): AutoStepResult | null => {
  if (!player.grounded && velocity.y > 0) return null;
  const target = {
    x: clamp(position.x + velocity.x * dt, map.bounds.minX + player.radius, map.bounds.maxX - player.radius),
    y: position.y,
    z: clamp(position.z + velocity.z * dt, map.bounds.minZ + player.radius, map.bounds.maxZ - player.radius),
  };
  if (Math.hypot(target.x - position.x, target.z - position.z) < EPSILON) return null;

  let best: AabbObstacle | null = null;
  for (const obstacle of map.obstacles) {
    if (obstacle.kind !== 'platform') continue;
    const step = obstacle.max.y - position.y;
    if (step <= 0.02 || step > MAX_AUTO_STEP_HEIGHT + CONTACT_EPSILON) continue;
    if (!overlapsVertical(position.y, player.height, obstacle)) continue;
    if (!insideHorizontal(target, obstacle, player.radius)) continue;
    if (!segmentIntersectsExpandedFootprint(position, target, obstacle, player.radius)) continue;
    if (!hasAutoStepHeadroom(position, target, obstacle.max.y, player, map, obstacle.id)) continue;
    if (!best || obstacle.max.y > best.max.y) best = obstacle;
  }
  return best ? { height: best.max.y, supportId: best.id } : null;
};

/**
 * Sweeps one horizontal axis while treating exact surface contact as free for
 * the perpendicular axis. This preserves tangential velocity, so walking into
 * a wall naturally becomes a slide instead of a full stop.
 */
const sweepHorizontalAxis = (
  position: Vec3,
  velocity: Vec3,
  player: Pick<PlayerState, 'height' | 'radius'>,
  map: MapDefinition,
  dt: number,
  axis: HorizontalAxis,
): boolean => {
  const otherAxis: HorizontalAxis = axis === 'x' ? 'z' : 'x';
  const start = position[axis];
  const delta = velocity[axis] * dt;
  if (Math.abs(delta) < EPSILON) return false;

  const target = start + delta;
  let resolved = target;
  let collided = false;

  for (const obstacle of map.obstacles) {
    if (
      !overlapsVertical(position.y, player.height, obstacle)
      || !overlapsExpandedAxis(position[otherAxis], obstacle, otherAxis, player.radius)
    ) {
      continue;
    }

    const near = obstacle.min[axis] - player.radius;
    const far = obstacle.max[axis] + player.radius;
    if (delta > 0 && start <= near + CONTACT_EPSILON && target > near) {
      resolved = Math.min(resolved, near);
      collided = true;
      continue;
    }
    if (delta < 0 && start >= far - CONTACT_EPSILON && target < far) {
      resolved = Math.max(resolved, far);
      collided = true;
      continue;
    }

    // Recover deterministically if network correction or spawning ever leaves
    // a capsule inside an expanded obstacle. Movement that is already escaping
    // remains untouched; movement deeper into it is pushed to the nearest face.
    if (start > near + CONTACT_EPSILON && start < far - CONTACT_EPSILON) {
      const escaping = delta > 0 ? target >= far : target <= near;
      if (!escaping) {
        resolved = start - near <= far - start ? near : far;
        collided = true;
      }
    }
  }

  const minimum = axis === 'x'
    ? map.bounds.minX + player.radius
    : map.bounds.minZ + player.radius;
  const maximum = axis === 'x'
    ? map.bounds.maxX - player.radius
    : map.bounds.maxZ - player.radius;
  const bounded = clamp(resolved, minimum, maximum);
  if (Math.abs(bounded - resolved) > CONTACT_EPSILON) collided = true;
  position[axis] = bounded;
  if (collided) velocity[axis] = 0;
  return collided;
};

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
  const position = { ...player.position };
  const velocity = { ...player.velocity };
  let hitWall = false;

  const autoStep = autoStepHeight(position, velocity, player, map, dt);
  if (autoStep) position.y = autoStep.height;

  hitWall = sweepHorizontalAxis(position, velocity, player, map, dt, 'x') || hitWall;
  hitWall = sweepHorizontalAxis(position, velocity, player, map, dt, 'z') || hitWall;

  const verticalStartY = position.y;
  const nextY = position.y + velocity.y * dt;
  let resolvedY = nextY;
  let grounded = false;

  if (velocity.y <= 0) {
    let floor = map.bounds.floorY;
    for (const obstacle of map.obstacles) {
      const supportMargin = obstacle.id === autoStep?.supportId
        ? player.radius
        : Math.max(0, player.radius - 0.08);
      if (!insideHorizontal(position, obstacle, supportMargin)) continue;
      const top = obstacle.max.y;
      if (verticalStartY >= top - 0.08 && nextY <= top + 0.08 && top > floor) floor = top;
    }
    if (resolvedY <= floor) {
      resolvedY = floor;
      velocity.y = 0;
      grounded = true;
    }
  } else {
    for (const obstacle of map.obstacles) {
      if (!insideHorizontal(position, obstacle, player.radius * 0.75)) continue;
      const previousHead = verticalStartY + player.height;
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

const raySphereAt = (
  origin: Vec3,
  direction: Vec3,
  centerX: number,
  centerY: number,
  centerZ: number,
  radius: number,
): number | null => {
  const offsetX = origin.x - centerX;
  const offsetY = origin.y - centerY;
  const offsetZ = origin.z - centerZ;
  const b = offsetX * direction.x + offsetY * direction.y + offsetZ * direction.z;
  const c = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -b - root;
  const far = -b + root;
  if (near >= 0) return near;
  return far >= 0 ? far : null;
};

const rayEllipsoidAt = (
  origin: Vec3,
  direction: Vec3,
  centerX: number,
  centerY: number,
  centerZ: number,
  radiusX: number,
  radiusY: number,
  radiusZ: number,
): number | null => {
  const offsetX = (origin.x - centerX) / radiusX;
  const offsetY = (origin.y - centerY) / radiusY;
  const offsetZ = (origin.z - centerZ) / radiusZ;
  const directionX = direction.x / radiusX;
  const directionY = direction.y / radiusY;
  const directionZ = direction.z / radiusZ;
  const a = directionX * directionX + directionY * directionY + directionZ * directionZ;
  const b = offsetX * directionX + offsetY * directionY + offsetZ * directionZ;
  const c = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - 1;
  const discriminant = b * b - a * c;
  if (discriminant < 0 || a < EPSILON) return null;
  const root = Math.sqrt(discriminant);
  const near = (-b - root) / a;
  const far = (-b + root) / a;
  if (near >= 0) return near;
  return far >= 0 ? far : null;
};

const rayAabbComponents = (
  originX: number,
  originY: number,
  originZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  obstacle: AabbObstacle,
): number | null => {
  let near = -Infinity;
  let far = Infinity;

  if (Math.abs(directionX) < EPSILON) {
    if (originX < obstacle.min.x || originX > obstacle.max.x) return null;
  } else {
    const first = (obstacle.min.x - originX) / directionX;
    const second = (obstacle.max.x - originX) / directionX;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }

  if (Math.abs(directionY) < EPSILON) {
    if (originY < obstacle.min.y || originY > obstacle.max.y) return null;
  } else {
    const first = (obstacle.min.y - originY) / directionY;
    const second = (obstacle.max.y - originY) / directionY;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }

  if (Math.abs(directionZ) < EPSILON) {
    if (originZ < obstacle.min.z || originZ > obstacle.max.z) return null;
  } else {
    const first = (obstacle.min.z - originZ) / directionZ;
    const second = (obstacle.max.z - originZ) / directionZ;
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
  let nearestObstacleDistance = Number.POSITIVE_INFINITY;
  let nearestObstacleId: string | undefined;

  for (const obstacle of map.obstacles) {
    const distance = rayAabbComponents(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      obstacle,
    );
    if (distance !== null && distance <= maxDistance && distance < nearestObstacleDistance) {
      nearestObstacleDistance = distance;
      nearestObstacleId = obstacle.id;
    }
  }
  if (nearestObstacleId !== undefined) {
    result = {
      distance: nearestObstacleDistance,
      point: {
        x: origin.x + direction.x * nearestObstacleDistance,
        y: origin.y + direction.y * nearestObstacleDistance,
        z: origin.z + direction.z * nearestObstacleDistance,
      },
      obstacleId: nearestObstacleId,
    };
  }

  for (const player of players) {
    if (!player.alive || player.id === ignoredPlayerId) continue;
    // The rendered astronaut is wider than the physical movement capsule at
    // the armour plates and is made of several readable target zones. Two
    // overlapping body spheres cover legs/pelvis and torso without inflating
    // the player's world collision radius, while the helmet remains a distinct
    // (and deliberately smaller) precision zone.
    const pelvisDistance = raySphereAt(
      origin,
      direction,
      player.position.x,
      player.position.y + player.height * 0.3,
      player.position.z,
      player.radius + COMBAT_HITBOX_TUNING.pelvisRadiusPadding,
    );
    const torsoDistance = raySphereAt(
      origin,
      direction,
      player.position.x,
      player.position.y + player.height * 0.58,
      player.position.z,
      player.radius + COMBAT_HITBOX_TUNING.torsoRadiusPadding,
    );
    const bodyDistance = pelvisDistance === null
      ? torsoDistance
      : torsoDistance === null
        ? pelvisDistance
        : Math.min(pelvisDistance, torsoDistance);
    const headHorizontalRadius = player.radius * COMBAT_HITBOX_TUNING.headRadiusScale;
    const headDistance = rayEllipsoidAt(
      origin,
      direction,
      player.position.x,
      player.position.y + player.height * COMBAT_HITBOX_TUNING.headCenterHeightScale,
      player.position.z,
      headHorizontalRadius,
      player.height * COMBAT_HITBOX_TUNING.headHalfHeightScale,
      headHorizontalRadius,
    );
    // Armour volumes overlap around the neck and shoulder plates. Classify the
    // first surface actually struck: a ray cannot enter the torso and later be
    // upgraded to a precision hit merely because it also crosses the helmet.
    const headWasHitFirst = headDistance !== null
      && (bodyDistance === null || headDistance + CONTACT_EPSILON < bodyDistance);
    const hitDistance = headWasHitFirst ? headDistance : bodyDistance;
    if (hitDistance === null || hitDistance > maxDistance || (result && hitDistance >= result.distance)) continue;
    result = {
      distance: hitDistance,
      point: {
        x: origin.x + direction.x * hitDistance,
        y: origin.y + direction.y * hitDistance,
        z: origin.z + direction.z * hitDistance,
      },
      playerId: player.id,
      headshot: headWasHitFirst,
    };
  }
  return result;
};

export const hasLineOfSight = (from: Vec3, to: Vec3, map: MapDefinition): boolean => {
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const deltaZ = to.z - from.z;
  const distanceSquaredValue = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
  if (distanceSquaredValue < EPSILON) return true;
  const distance = Math.sqrt(distanceSquaredValue);
  const inverseDistance = 1 / distance;
  const directionX = deltaX * inverseDistance;
  const directionY = deltaY * inverseDistance;
  const directionZ = deltaZ * inverseDistance;
  for (const obstacle of map.obstacles) {
    const hit = rayAabbComponents(
      from.x,
      from.y,
      from.z,
      directionX,
      directionY,
      directionZ,
      obstacle,
    );
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
