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
const MAX_TERRAIN_GROUND_SNAP = 0.28;
const TERRAIN_RAY_STEP = 0.75;
const TERRAIN_MOVE_STEP = 0.05;
const MAX_WALKABLE_TERRAIN_SLOPE = 1.15;
const TERRAIN_SWEEP_REFINEMENT_STEPS = 10;
const TERRAIN_RAY_REFINEMENT_DEPTH = 10;
const TERRAIN_RAY_BISECTION_STEPS = 10;
/** Conservative upper bound for the authored smooth heightfields. */
const TERRAIN_RAY_MAX_SLOPE = 2.5;
const OBSTACLE_BVH_LEAF_SIZE = 3;
type HorizontalAxis = 'x' | 'z';

interface ObstacleBvhNode {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  left: ObstacleBvhNode | null;
  right: ObstacleBvhNode | null;
  obstacleIndexes: readonly number[] | null;
}

interface ObstacleBvhCacheEntry {
  obstacleCount: number;
  firstObstacle: AabbObstacle | undefined;
  lastObstacle: AabbObstacle | undefined;
  root: ObstacleBvhNode | null;
}

const OBSTACLE_BVH_CACHE = new WeakMap<MapDefinition, ObstacleBvhCacheEntry>();

/** Samples the authoritative walkable surface shared by movement and rendering. */
export const mapGroundHeightAt = (map: MapDefinition, x: number, z: number): number =>
  map.groundHeightAt?.(x, z) ?? map.bounds.floorY;

// Map geometry is authored once and treated as immutable during a match. The
// cache still rebuilds for supported dynamic fixtures that add/remove boxes;
// callers that mutate an existing obstacle's min/max object in place must use
// a fresh MapDefinition because silently polling all bounds per ray would
// restore the O(obstacles) cost this index removes.

const buildObstacleBvhNode = (
  obstacles: readonly AabbObstacle[],
  obstacleIndexes: number[],
): ObstacleBvhNode => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let minCenterX = Number.POSITIVE_INFINITY;
  let minCenterY = Number.POSITIVE_INFINITY;
  let minCenterZ = Number.POSITIVE_INFINITY;
  let maxCenterX = Number.NEGATIVE_INFINITY;
  let maxCenterY = Number.NEGATIVE_INFINITY;
  let maxCenterZ = Number.NEGATIVE_INFINITY;

  for (const index of obstacleIndexes) {
    const obstacle = obstacles[index]!;
    if (obstacle.min.x < minX) minX = obstacle.min.x;
    if (obstacle.min.y < minY) minY = obstacle.min.y;
    if (obstacle.min.z < minZ) minZ = obstacle.min.z;
    if (obstacle.max.x > maxX) maxX = obstacle.max.x;
    if (obstacle.max.y > maxY) maxY = obstacle.max.y;
    if (obstacle.max.z > maxZ) maxZ = obstacle.max.z;
    const centerX = obstacle.min.x + obstacle.max.x;
    const centerY = obstacle.min.y + obstacle.max.y;
    const centerZ = obstacle.min.z + obstacle.max.z;
    if (centerX < minCenterX) minCenterX = centerX;
    if (centerY < minCenterY) minCenterY = centerY;
    if (centerZ < minCenterZ) minCenterZ = centerZ;
    if (centerX > maxCenterX) maxCenterX = centerX;
    if (centerY > maxCenterY) maxCenterY = centerY;
    if (centerZ > maxCenterZ) maxCenterZ = centerZ;
  }

  const node: ObstacleBvhNode = {
    minX,
    minY,
    minZ,
    maxX,
    maxY,
    maxZ,
    left: null,
    right: null,
    obstacleIndexes: null,
  };
  if (obstacleIndexes.length <= OBSTACLE_BVH_LEAF_SIZE) {
    // Original-order leaves make tie behaviour deterministic and match the
    // previous linear scan when two authored boxes share an entry surface.
    obstacleIndexes.sort((left, right) => left - right);
    node.obstacleIndexes = obstacleIndexes;
    return node;
  }

  const spanX = maxCenterX - minCenterX;
  const spanY = maxCenterY - minCenterY;
  const spanZ = maxCenterZ - minCenterZ;
  const axis = spanX >= spanY && spanX >= spanZ
    ? 'x'
    : spanY >= spanZ
      ? 'y'
      : 'z';
  obstacleIndexes.sort((left, right) => {
    const leftObstacle = obstacles[left]!;
    const rightObstacle = obstacles[right]!;
    const centerDifference = (
      leftObstacle.min[axis] + leftObstacle.max[axis]
    ) - (
      rightObstacle.min[axis] + rightObstacle.max[axis]
    );
    return centerDifference || left - right;
  });
  const midpoint = obstacleIndexes.length >>> 1;
  node.left = buildObstacleBvhNode(obstacles, obstacleIndexes.slice(0, midpoint));
  node.right = buildObstacleBvhNode(obstacles, obstacleIndexes.slice(midpoint));
  return node;
};

const obstacleBvhRoot = (map: MapDefinition): ObstacleBvhNode | null => {
  const obstacles = map.obstacles;
  const cached = OBSTACLE_BVH_CACHE.get(map);
  if (
    cached
    && cached.obstacleCount === obstacles.length
    && cached.firstObstacle === obstacles[0]
    && cached.lastObstacle === obstacles[obstacles.length - 1]
  ) {
    return cached.root;
  }

  const obstacleIndexes = Array.from({ length: obstacles.length }, (_, index) => index);
  const root = obstacleIndexes.length > 0
    ? buildObstacleBvhNode(obstacles, obstacleIndexes)
    : null;
  OBSTACLE_BVH_CACHE.set(map, {
    obstacleCount: obstacles.length,
    firstObstacle: obstacles[0],
    lastObstacle: obstacles[obstacles.length - 1],
    root,
  });
  return root;
};

const obstaclesOverlappingBounds = (
  map: MapDefinition,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): readonly AabbObstacle[] => {
  if (map.obstacles.length <= OBSTACLE_BVH_LEAF_SIZE * 2) return map.obstacles;
  const root = obstacleBvhRoot(map);
  if (!root) return [];
  const stack = [root];
  const obstacleIndexes: number[] = [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.maxX < minX || node.minX > maxX
      || node.maxY < minY || node.minY > maxY
      || node.maxZ < minZ || node.minZ > maxZ
    ) {
      continue;
    }
    if (node.obstacleIndexes) {
      for (const obstacleIndex of node.obstacleIndexes) {
        const obstacle = map.obstacles[obstacleIndex];
        if (
          obstacle
          && obstacle.max.x >= minX && obstacle.min.x <= maxX
          && obstacle.max.y >= minY && obstacle.min.y <= maxY
          && obstacle.max.z >= minZ && obstacle.min.z <= maxZ
        ) {
          obstacleIndexes.push(obstacleIndex);
        }
      }
      continue;
    }
    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }
  obstacleIndexes.sort((left, right) => left - right);
  return obstacleIndexes.map((index) => map.obstacles[index]!);
};

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
  if (height <= 0 || position.y < mapGroundHeightAt(map, position.x, position.z) - CONTACT_EPSILON) return false;
  if (position.y + height > map.bounds.ceilingY - CONTACT_EPSILON) return false;
  const obstacles = obstaclesOverlappingBounds(
    map,
    position.x - radius,
    position.y,
    position.z - radius,
    position.x + radius,
    position.y + height,
    position.z + radius,
  );
  return !obstacles.some((obstacle) =>
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
  obstacles: readonly AabbObstacle[],
): boolean => {
  if (feetY + player.height > map.bounds.ceilingY - CONTACT_EPSILON) return false;
  for (const obstacle of obstacles) {
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
  obstacles: readonly AabbObstacle[],
): AutoStepResult | null => {
  if (!player.grounded && velocity.y > 0) return null;
  const target = {
    x: clamp(position.x + velocity.x * dt, map.bounds.minX + player.radius, map.bounds.maxX - player.radius),
    y: position.y,
    z: clamp(position.z + velocity.z * dt, map.bounds.minZ + player.radius, map.bounds.maxZ - player.radius),
  };
  if (Math.hypot(target.x - position.x, target.z - position.z) < EPSILON) return null;

  let best: AabbObstacle | null = null;
  for (const obstacle of obstacles) {
    if (obstacle.kind !== 'platform') continue;
    const step = obstacle.max.y - position.y;
    if (step <= 0.02 || step > MAX_AUTO_STEP_HEIGHT + CONTACT_EPSILON) continue;
    if (!overlapsVertical(position.y, player.height, obstacle)) continue;
    if (!insideHorizontal(target, obstacle, player.radius)) continue;
    if (!segmentIntersectsExpandedFootprint(position, target, obstacle, player.radius)) continue;
    if (!hasAutoStepHeadroom(position, target, obstacle.max.y, player, map, obstacle.id, obstacles)) continue;
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
  obstacles: readonly AabbObstacle[],
): boolean => {
  const otherAxis: HorizontalAxis = axis === 'x' ? 'z' : 'x';
  const start = position[axis];
  const delta = velocity[axis] * dt;
  if (Math.abs(delta) < EPSILON) return false;

  const target = start + delta;
  let resolved = target;
  let collided = false;

  for (const obstacle of obstacles) {
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

interface TerrainHorizontalSweepResult {
  fraction: number;
  blocked: boolean;
}

/**
 * Sweeps authored relief along the actual horizontal movement vector. Sampling
 * by travelled distance makes the walkability decision independent of the
 * caller's tick size, while a leading-foot probe prevents a capsule from
 * embedding half its radius into a sharp rise.
 */
const sweepHorizontalTerrain = (
  player: Pick<PlayerState, 'position' | 'velocity' | 'radius' | 'grounded'>,
  map: MapDefinition,
  dt: number,
): TerrainHorizontalSweepResult => {
  if (!map.groundHeightAt || dt <= 0) return { fraction: 1, blocked: false };
  const deltaX = player.velocity.x * dt;
  const deltaZ = player.velocity.z * dt;
  const movementLength = Math.hypot(deltaX, deltaZ);
  if (movementLength < EPSILON) return { fraction: 1, blocked: false };

  const directionX = deltaX / movementLength;
  const directionZ = deltaZ / movementLength;
  const startGround = mapGroundHeightAt(map, player.position.x, player.position.z);
  const terrainSupported = player.grounded
    && player.position.y >= startGround - CONTACT_EPSILON
    && player.position.y - startGround <= MAX_TERRAIN_GROUND_SNAP + CONTACT_EPSILON;
  const sample = (fraction: number) => {
    const centerX = player.position.x + deltaX * fraction;
    const centerZ = player.position.z + deltaZ * fraction;
    const probeX = centerX + directionX * player.radius;
    const probeZ = centerZ + directionZ * player.radius;
    return {
      centerHeight: mapGroundHeightAt(map, centerX, centerZ),
      probeHeight: mapGroundHeightAt(map, probeX, probeZ),
    };
  };
  const isBlockedBetween = (
    lowerFraction: number,
    lowerProbeHeight: number,
    upperFraction: number,
    upperSample: ReturnType<typeof sample>,
  ): boolean => {
    if (terrainSupported) {
      const run = movementLength * (upperFraction - lowerFraction);
      const rise = upperSample.probeHeight - lowerProbeHeight;
      return rise > CONTACT_EPSILON
        && rise / Math.max(run, EPSILON) > MAX_WALKABLE_TERRAIN_SLOPE + CONTACT_EPSILON;
    }
    const feetY = player.position.y + player.velocity.y * dt * upperFraction;
    const surfaceHeight = Math.max(upperSample.centerHeight, upperSample.probeHeight);
    return surfaceHeight > feetY + CONTACT_EPSILON
      && surfaceHeight > startGround + CONTACT_EPSILON;
  };

  const segmentCount = Math.max(1, Math.ceil(movementLength / TERRAIN_MOVE_STEP));
  let previousFraction = 0;
  let previousSample = sample(0);
  for (let segment = 1; segment <= segmentCount; segment += 1) {
    const fraction = segment / segmentCount;
    const currentSample = sample(fraction);
    if (!isBlockedBetween(previousFraction, previousSample.probeHeight, fraction, currentSample)) {
      previousFraction = fraction;
      previousSample = currentSample;
      continue;
    }

    let lower = previousFraction;
    let lowerSample = previousSample;
    let upper = fraction;
    for (let iteration = 0; iteration < TERRAIN_SWEEP_REFINEMENT_STEPS; iteration += 1) {
      const midpoint = (lower + upper) * 0.5;
      const midpointSample = sample(midpoint);
      if (isBlockedBetween(lower, lowerSample.probeHeight, midpoint, midpointSample)) {
        upper = midpoint;
      } else {
        lower = midpoint;
        lowerSample = midpointSample;
      }
    }
    return { fraction: lower, blocked: true };
  }
  return { fraction: 1, blocked: false };
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

  const intendedX = clamp(
    position.x + velocity.x * dt,
    map.bounds.minX + player.radius,
    map.bounds.maxX - player.radius,
  );
  const intendedZ = clamp(
    position.z + velocity.z * dt,
    map.bounds.minZ + player.radius,
    map.bounds.maxZ - player.radius,
  );
  const intendedY = position.y + velocity.y * dt;
  const movementObstacles = obstaclesOverlappingBounds(
    map,
    Math.min(position.x, intendedX) - player.radius,
    Math.min(position.y, intendedY) - 0.08,
    Math.min(position.z, intendedZ) - player.radius,
    Math.max(position.x, intendedX) + player.radius,
    Math.max(position.y + player.height + MAX_AUTO_STEP_HEIGHT, intendedY + player.height) + 0.08,
    Math.max(position.z, intendedZ) + player.radius,
  );

  const horizontalStart = { x: position.x, z: position.z };
  const terrainSweep = sweepHorizontalTerrain(player, map, dt);
  let terrainBlocked = terrainSweep.blocked;
  if (terrainBlocked) {
    velocity.x *= terrainSweep.fraction;
    velocity.z *= terrainSweep.fraction;
  }

  const autoStep = autoStepHeight(position, velocity, player, map, dt, movementObstacles);
  if (autoStep) position.y = autoStep.height;

  hitWall = sweepHorizontalAxis(position, velocity, player, map, dt, 'x', movementObstacles) || hitWall;
  hitWall = sweepHorizontalAxis(position, velocity, player, map, dt, 'z', movementObstacles) || hitWall;

  // Obstacle sliding can change the actual movement vector. Validate that
  // resolved vector once more so an X/Z wall response cannot redirect the
  // capsule through a non-walkable terrain face.
  if (!terrainBlocked && dt > 0) {
    const resolvedVelocity = {
      x: (position.x - horizontalStart.x) / dt,
      y: player.velocity.y,
      z: (position.z - horizontalStart.z) / dt,
    };
    const resolvedTerrainSweep = sweepHorizontalTerrain({
      position: player.position,
      velocity: resolvedVelocity,
      radius: player.radius,
      grounded: player.grounded,
    }, map, dt);
    if (resolvedTerrainSweep.blocked) {
      position.x = horizontalStart.x
        + (position.x - horizontalStart.x) * resolvedTerrainSweep.fraction;
      position.z = horizontalStart.z
        + (position.z - horizontalStart.z) * resolvedTerrainSweep.fraction;
      terrainBlocked = true;
    }
  }
  if (terrainBlocked) {
    velocity.x = 0;
    velocity.z = 0;
    hitWall = true;
  }

  const verticalStartY = position.y;
  const nextY = position.y + velocity.y * dt;
  let resolvedY = nextY;
  let grounded = false;

  if (velocity.y <= 0) {
    let floor = mapGroundHeightAt(map, position.x, position.z);
    for (const obstacle of movementObstacles) {
      const supportMargin = obstacle.id === autoStep?.supportId
        ? player.radius
        : Math.max(0, player.radius - 0.08);
      if (!insideHorizontal(position, obstacle, supportMargin)) continue;
      const top = obstacle.max.y;
      if (verticalStartY >= top - 0.08 && nextY <= top + 0.08 && top > floor) floor = top;
    }
    const followsTerrainSlope = Boolean(
      map.groundHeightAt
      && player.grounded
      && resolvedY - floor <= MAX_TERRAIN_GROUND_SNAP,
    );
    if (resolvedY <= floor || followsTerrainSlope) {
      resolvedY = floor;
      velocity.y = 0;
      grounded = true;
    }
  } else {
    for (const obstacle of movementObstacles) {
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

  // Grounding and terrain snap are resolved explicitly above. An unconditional
  // terrain clamp would teleport an airborne capsule onto a lateral rise, but
  // flat legacy maps and genuinely penetrated corrections still need recovery.
  const localGround = mapGroundHeightAt(map, position.x, position.z);
  const startedBelowGround = player.position.y
    < mapGroundHeightAt(map, player.position.x, player.position.z) - CONTACT_EPSILON;
  position.y = !map.groundHeightAt || startedBelowGround
    ? clamp(resolvedY, localGround, map.bounds.ceilingY - player.height)
    : Math.min(resolvedY, map.bounds.ceilingY - player.height);
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

const rayBoundsComponents = (
  originX: number,
  originY: number,
  originZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): number | null => {
  let near = -Infinity;
  let far = Infinity;

  if (Math.abs(directionX) < EPSILON) {
    if (originX < minX || originX > maxX) return null;
  } else {
    const first = (minX - originX) / directionX;
    const second = (maxX - originX) / directionX;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }

  if (Math.abs(directionY) < EPSILON) {
    if (originY < minY || originY > maxY) return null;
  } else {
    const first = (minY - originY) / directionY;
    const second = (maxY - originY) / directionY;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }

  if (Math.abs(directionZ) < EPSILON) {
    if (originZ < minZ || originZ > maxZ) return null;
  } else {
    const first = (minZ - originZ) / directionZ;
    const second = (maxZ - originZ) / directionZ;
    near = Math.max(near, Math.min(first, second));
    far = Math.min(far, Math.max(first, second));
    if (near > far) return null;
  }

  if (far < 0) return null;
  return Math.max(0, near);
};

const rayObstacleAt = (
  originX: number,
  originY: number,
  originZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  obstacle: AabbObstacle,
): number | null => rayBoundsComponents(
  originX,
  originY,
  originZ,
  directionX,
  directionY,
  directionZ,
  obstacle.min.x,
  obstacle.min.y,
  obstacle.min.z,
  obstacle.max.x,
  obstacle.max.y,
  obstacle.max.z,
);

interface ObstacleRayHit {
  distance: number;
  obstacleId: string;
}

const nearestObstacleRayHit = (
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  map: MapDefinition,
): ObstacleRayHit | null => {
  const root = obstacleBvhRoot(map);
  if (!root) return null;
  const stack = [root];
  let nearestDistance = Number.POSITIVE_INFINITY;
  let nearestIndex = Number.POSITIVE_INFINITY;

  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeDistance = rayBoundsComponents(
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      node.minX,
      node.minY,
      node.minZ,
      node.maxX,
      node.maxY,
      node.maxZ,
    );
    if (nodeDistance === null || nodeDistance > maxDistance || nodeDistance > nearestDistance) continue;

    if (node.obstacleIndexes) {
      for (const obstacleIndex of node.obstacleIndexes) {
        const obstacle = map.obstacles[obstacleIndex];
        if (!obstacle) continue;
        const distance = rayObstacleAt(
          origin.x,
          origin.y,
          origin.z,
          direction.x,
          direction.y,
          direction.z,
          obstacle,
        );
        if (
          distance !== null
          && distance <= maxDistance
          && (distance < nearestDistance || (distance === nearestDistance && obstacleIndex < nearestIndex))
        ) {
          nearestDistance = distance;
          nearestIndex = obstacleIndex;
        }
      }
      continue;
    }

    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  const obstacle = map.obstacles[nearestIndex];
  return obstacle
    ? { distance: nearestDistance, obstacleId: obstacle.id }
    : null;
};

const rayIsBlockedByObstacle = (
  originX: number,
  originY: number,
  originZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  distanceLimit: number,
  map: MapDefinition,
): boolean => {
  const root = obstacleBvhRoot(map);
  const stack = root ? [root] : [];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeDistance = rayBoundsComponents(
      originX,
      originY,
      originZ,
      directionX,
      directionY,
      directionZ,
      node.minX,
      node.minY,
      node.minZ,
      node.maxX,
      node.maxY,
      node.maxZ,
    );
    if (nodeDistance === null || nodeDistance >= distanceLimit) continue;

    if (node.obstacleIndexes) {
      for (const obstacleIndex of node.obstacleIndexes) {
        const obstacle = map.obstacles[obstacleIndex];
        if (!obstacle) continue;
        const hit = rayObstacleAt(
          originX,
          originY,
          originZ,
          directionX,
          directionY,
          directionZ,
          obstacle,
        );
        if (hit !== null && hit < distanceLimit) return true;
      }
      continue;
    }

    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }
  return nearestTerrainRayHit(
    originX,
    originY,
    originZ,
    directionX,
    directionY,
    directionZ,
    distanceLimit,
    map,
  ) !== null;
};

const clipTerrainRayToBounds = (
  originX: number,
  originZ: number,
  directionX: number,
  directionZ: number,
  distanceLimit: number,
  map: MapDefinition,
): readonly [number, number] | null => {
  let entry = 0;
  let exit = distanceLimit;
  const clipAxis = (
    origin: number,
    direction: number,
    minimum: number,
    maximum: number,
  ): boolean => {
    if (Math.abs(direction) < EPSILON) return origin >= minimum && origin <= maximum;
    const first = (minimum - origin) / direction;
    const second = (maximum - origin) / direction;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    return entry <= exit;
  };
  if (!clipAxis(originX, directionX, map.bounds.minX, map.bounds.maxX)) return null;
  if (!clipAxis(originZ, directionZ, map.bounds.minZ, map.bounds.maxZ)) return null;
  if (exit < 0 || entry > distanceLimit) return null;
  return [Math.max(0, entry), Math.min(distanceLimit, exit)];
};

const nearestTerrainRayHit = (
  originX: number,
  originY: number,
  originZ: number,
  directionX: number,
  directionY: number,
  directionZ: number,
  distanceLimit: number,
  map: MapDefinition,
): number | null => {
  if (!map.groundHeightAt || distanceLimit <= 0) return null;
  const clipped = clipTerrainRayToBounds(
    originX,
    originZ,
    directionX,
    directionZ,
    distanceLimit,
    map,
  );
  if (!clipped) return null;
  const [entryDistance, exitDistance] = clipped;
  const clearanceAt = (distance: number): number => {
    const x = clamp(originX + directionX * distance, map.bounds.minX, map.bounds.maxX);
    const z = clamp(originZ + directionZ * distance, map.bounds.minZ, map.bounds.maxZ);
    return originY + directionY * distance - mapGroundHeightAt(map, x, z);
  };
  const refineCrossing = (lowerStart: number, upperStart: number): number => {
    let lower = lowerStart;
    let upper = upperStart;
    for (let iteration = 0; iteration < TERRAIN_RAY_BISECTION_STEPS; iteration += 1) {
      const midpoint = (lower + upper) * 0.5;
      if (clearanceAt(midpoint) > CONTACT_EPSILON) lower = midpoint;
      else upper = midpoint;
    }
    return upper;
  };
  const maximumClearanceRate = Math.abs(directionY)
    + TERRAIN_RAY_MAX_SLOPE * Math.hypot(directionX, directionZ);
  const intervalCannotHit = (
    lowerDistance: number,
    lowerClearance: number,
    upperDistance: number,
    upperClearance: number,
  ): boolean => lowerClearance > CONTACT_EPSILON
    && upperClearance > CONTACT_EPSILON
    && lowerClearance + upperClearance - CONTACT_EPSILON * 2
      > maximumClearanceRate * (upperDistance - lowerDistance);
  const searchInterval = (
    lowerDistance: number,
    lowerClearance: number,
    upperDistance: number,
    upperClearance: number,
    depth: number,
  ): number | null => {
    if (lowerClearance <= CONTACT_EPSILON) return lowerDistance;
    if (intervalCannotHit(lowerDistance, lowerClearance, upperDistance, upperClearance)) return null;
    const midpoint = (lowerDistance + upperDistance) * 0.5;
    const midpointClearance = clearanceAt(midpoint);
    if (depth >= TERRAIN_RAY_REFINEMENT_DEPTH) {
      if (midpointClearance <= CONTACT_EPSILON) return refineCrossing(lowerDistance, midpoint);
      if (upperClearance <= CONTACT_EPSILON) return refineCrossing(midpoint, upperDistance);
      return null;
    }
    const firstHalf = searchInterval(
      lowerDistance,
      lowerClearance,
      midpoint,
      midpointClearance,
      depth + 1,
    );
    if (firstHalf !== null) return firstHalf;
    return searchInterval(
      midpoint,
      midpointClearance,
      upperDistance,
      upperClearance,
      depth + 1,
    );
  };

  let previousDistance = entryDistance;
  let previousClearance = clearanceAt(previousDistance);
  if (previousClearance <= CONTACT_EPSILON) return previousDistance;
  while (previousDistance < exitDistance - EPSILON) {
    const distance = Math.min(exitDistance, previousDistance + TERRAIN_RAY_STEP);
    const currentClearance = clearanceAt(distance);
    const hit = searchInterval(
      previousDistance,
      previousClearance,
      distance,
      currentClearance,
      0,
    );
    if (hit !== null) return hit;
    previousDistance = distance;
    previousClearance = currentClearance;
  }
  return null;
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
  const obstacleHit = nearestObstacleRayHit(origin, direction, maxDistance, map);
  const terrainDistance = nearestTerrainRayHit(
    origin.x,
    origin.y,
    origin.z,
    direction.x,
    direction.y,
    direction.z,
    obstacleHit ? Math.min(maxDistance, obstacleHit.distance) : maxDistance,
    map,
  );
  if (terrainDistance !== null) {
    result = {
      distance: terrainDistance,
      point: {
        x: origin.x + direction.x * terrainDistance,
        y: origin.y + direction.y * terrainDistance,
        z: origin.z + direction.z * terrainDistance,
      },
      obstacleId: 'terrain-surface',
    };
  }
  if (obstacleHit && (!result || obstacleHit.distance < result.distance)) {
    result = {
      distance: obstacleHit.distance,
      point: {
        x: origin.x + direction.x * obstacleHit.distance,
        y: origin.y + direction.y * obstacleHit.distance,
        z: origin.z + direction.z * obstacleHit.distance,
      },
      obstacleId: obstacleHit.obstacleId,
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
  return !rayIsBlockedByObstacle(
    from.x,
    from.y,
    from.z,
    directionX,
    directionY,
    directionZ,
    distance - 0.08,
    map,
  );
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
