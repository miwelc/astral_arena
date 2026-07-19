import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasLineOfSight, pointInsideObstacle, raycastWorld } from './collision';
import { isJumpPad } from './map';
import { emptyInput } from './math';
import { createDefaultConfig, GameSimulation, PLAYER_MOVEMENT_TUNING } from './simulation';
import type { MapDefinition, PlayerState, ProjectileState, Vec3 } from './types';

const TEST_NOW = 1_700_000_200_000;

const createSimulation = (playerIds: readonly string[] = ['local']): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'deathmatch', botFill: false }),
    playerIds.map((id) => ({ id, name: id })),
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const player = (simulation: GameSimulation, id: string): PlayerState => {
  const value = simulation.state.players[id];
  if (!value) throw new Error(`Missing test player: ${id}`);
  return value;
};

const findJumpPad = (map: MapDefinition): Vec3 => {
  const waypoint = map.waypoints.find((candidate) => isJumpPad({ ...candidate, y: map.bounds.floorY }));
  if (waypoint) return { x: waypoint.x, y: map.bounds.floorY, z: waypoint.z };
  for (let z = map.bounds.minZ; z <= map.bounds.maxZ; z += 0.5) {
    for (let x = map.bounds.minX; x <= map.bounds.maxX; x += 0.5) {
      const candidate = { x, y: map.bounds.floorY, z };
      if (isJumpPad(candidate)) return candidate;
    }
  }
  throw new Error('The map has no detectable jump pad');
};

const findClearLine = (map: MapDefinition): { start: Vec3; end: Vec3 } => {
  const y = map.bounds.floorY + 0.9;
  for (let z = map.bounds.minZ + 4; z <= map.bounds.maxZ - 4; z += 2) {
    for (let x = map.bounds.minX + 6; x <= map.bounds.maxX - 4; x += 2) {
      const start = { x: x - 1.5, y, z };
      const end = { x, y, z };
      if (
        !pointInsideObstacle(start, map)
        && !pointInsideObstacle(end, map)
        && hasLineOfSight(start, end, map)
      ) {
        return { start, end };
      }
    }
  }
  throw new Error('The map has no clear test line');
};

const findClearRun = (map: MapDefinition, length = 15): { start: Vec3; end: Vec3 } => {
  for (let z = map.bounds.minZ + 4; z <= map.bounds.maxZ - 4; z += 2) {
    for (let x = map.bounds.minX + 4; x <= map.bounds.maxX - length - 4; x += 2) {
      const start = { x, y: map.bounds.floorY, z };
      const end = { x: x + length, y: map.bounds.floorY, z };
      const corridorIsClear = [-0.62, 0, 0.62].every((zOffset) =>
        [0.12, 0.75, 1.45].every((height) => hasLineOfSight(
          { x: start.x, y: start.y + height, z: start.z + zOffset },
          { x: end.x, y: end.y + height, z: end.z + zOffset },
          map,
        )),
      );
      if (corridorIsClear) return { start, end };
    }
  }
  throw new Error('The map has no clear movement corridor');
};

const grenade = (
  owner: PlayerState,
  position: Vec3,
  overrides: Partial<ProjectileState> = {},
): ProjectileState => ({
  id: 'test-grenade',
  kind: 'grenade',
  ownerId: owner.id,
  team: owner.team,
  position: { ...position },
  velocity: { x: 0, y: 0, z: 0 },
  radius: 0.16,
  damage: 120,
  blastRadius: 5.5,
  armed: true,
  fuse: 1.7,
  alive: true,
  ...overrides,
});

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('classic arena movement', () => {
  it('accelerates progressively to a deliberately restrained running speed', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'local');
    const { start } = findClearRun(simulation.map);
    local.position = { ...start };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.setInput(local.id, {
      ...emptyInput(),
      sequence: 1,
      yaw: -Math.PI / 2,
      moveZ: 1,
    });

    simulation.step(0.05);
    expect(Math.hypot(local.velocity.x, local.velocity.z)).toBeCloseTo(1.4, 5);

    for (let index = 0; index < 10; index += 1) simulation.step(0.05);
    expect(Math.hypot(local.velocity.x, local.velocity.z)).toBeCloseTo(PLAYER_MOVEMENT_TUNING.moveSpeed, 5);
    expect(PLAYER_MOVEMENT_TUNING.moveSpeed).toBeGreaterThan(6);
    expect(PLAYER_MOVEMENT_TUNING.moveSpeed).toBeLessThan(6.5);
  });

  it('keeps forward momentum through a longer, controlled jump arc', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'local');
    const { start } = findClearRun(simulation.map);
    local.position = { ...start };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.setInput(local.id, {
      ...emptyInput(),
      sequence: 1,
      yaw: -Math.PI / 2,
      moveZ: 1,
    });
    for (let index = 0; index < 10; index += 1) simulation.step(0.05);

    simulation.setInput(local.id, {
      ...emptyInput(),
      sequence: 2,
      yaw: -Math.PI / 2,
      moveZ: 1,
      jump: true,
    });
    simulation.step(0);
    const takeoff = { ...local.position };
    const takeoffSpeed = Math.hypot(local.velocity.x, local.velocity.z);
    simulation.setInput(local.id, {
      ...emptyInput(),
      sequence: 3,
      yaw: -Math.PI / 2,
    });

    let airtime = 0;
    let apex = local.position.y;
    for (let index = 0; index < 60 && !local.grounded; index += 1) {
      simulation.step(0.025);
      airtime += 0.025;
      apex = Math.max(apex, local.position.y);
    }

    const jumpDistance = Math.hypot(local.position.x - takeoff.x, local.position.z - takeoff.z);
    expect(local.grounded).toBe(true);
    expect(airtime).toBeGreaterThanOrEqual(0.85);
    expect(airtime).toBeLessThan(0.95);
    expect(apex - takeoff.y).toBeGreaterThan(1.4);
    expect(apex - takeoff.y).toBeLessThan(1.6);
    expect(jumpDistance).toBeGreaterThan(5.3);
    expect(jumpDistance).toBeLessThan(5.9);
    expect(takeoffSpeed).toBeCloseTo(PLAYER_MOVEMENT_TUNING.moveSpeed, 5);
  });
});

describe('jump pad movement', () => {
  it('launches toward the tower in a continuous arc and lands on its upper deck', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'local');
    const pad = findJumpPad(simulation.map);
    local.position = { ...pad };
    local.velocity = { x: 1.5, y: 0, z: -0.4 };
    local.grounded = true;
    const before = { ...local.position };

    simulation.step(0);

    expect(local.position).toEqual(before);
    expect(local.velocity.y).toBeGreaterThan(12);
    const towardTower = {
      x: simulation.state.tower.center.x - before.x,
      z: simulation.state.tower.center.z - before.z,
    };
    expect(local.velocity.x * towardTower.x + local.velocity.z * towardTower.z).toBeGreaterThan(0);

    simulation.step(0.05);
    expect(local.position.y).toBeGreaterThan(before.y);
    expect(Math.hypot(local.position.x - before.x, local.position.z - before.z)).toBeLessThan(1);

    let landedOnTower = false;
    for (let index = 0; index < 50 && !landedOnTower; index += 1) {
      simulation.step(0.05);
      landedOnTower = local.grounded && local.position.y >= simulation.state.tower.center.y - 0.1;
    }

    expect(landedOnTower).toBe(true);
    expect(Math.hypot(
      local.position.x - simulation.state.tower.center.x,
      local.position.z - simulation.state.tower.center.z,
    )).toBeLessThan(simulation.state.tower.radius + 1);
  });

  it('suppresses an immediate relaunch while still inside the pad volume', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'local');
    const pad = findJumpPad(simulation.map);
    local.position = { ...pad };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;

    simulation.step(0);

    local.position = { ...pad };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.step(0);

    expect(local.velocity.y).toBe(0);
    expect(local.position).toEqual(pad);
  });
});

describe('grenade detonation', () => {
  it('starts a frag fuse on first ground contact instead of while airborne', () => {
    const simulation = createSimulation();
    const owner = player(simulation, 'local');
    const { start } = findClearLine(simulation.map);
    owner.position = { x: simulation.map.bounds.maxX - 1, y: simulation.map.bounds.floorY, z: simulation.map.bounds.maxZ - 1 };
    const projectile = grenade(owner, { ...start, y: simulation.map.bounds.floorY + 8 }, {
      velocity: { x: 0.5, y: 0, z: 0 },
      armed: false,
      fuse: 1.7,
    });
    simulation.state.projectiles.push(projectile);

    simulation.step(0.5);

    expect(simulation.state.projectiles).toHaveLength(1);
    expect(projectile.armed).toBe(false);
    expect(projectile.fuse).toBeCloseTo(1.7, 6);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(false);

    projectile.position.y = simulation.map.bounds.floorY + projectile.radius + 0.01;
    projectile.velocity = { x: 0, y: -1, z: 0 };
    simulation.step(0.05);

    expect(projectile.armed).toBe(true);
    expect(projectile.fuse).toBeCloseTo(1.7, 6);
    expect(simulation.state.projectiles).toHaveLength(1);
    for (let index = 0; index < 36 && projectile.alive; index += 1) simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(0);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(true);
  });

  it('bounces an expired grenade off a wall and only detonates when it later reaches the ground', () => {
    const simulation = createSimulation();
    const owner = player(simulation, 'local');
    const wall = simulation.map.obstacles.find(
      (obstacle) => obstacle.kind === 'wall' && Math.abs(obstacle.max.x - simulation.map.bounds.minX) < 0.1,
    );
    if (!wall) throw new Error('Missing west boundary wall fixture');
    owner.position = { x: simulation.map.bounds.maxX - 1, y: simulation.map.bounds.floorY, z: simulation.map.bounds.maxZ - 1 };
    const projectile = grenade(owner, {
      x: wall.max.x + 0.75,
      y: Math.min(wall.max.y - 1, simulation.map.bounds.floorY + 3),
      z: (wall.min.z + wall.max.z) * 0.5,
    }, {
      velocity: { x: -20, y: 0, z: 0 },
      fuse: -0.1,
    });
    simulation.state.projectiles.push(projectile);

    simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(1);
    expect(projectile.velocity.x).toBeGreaterThan(0);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(false);

    projectile.position.y = simulation.map.bounds.floorY + projectile.radius + 0.01;
    projectile.velocity = { x: 0, y: -1, z: 0 };
    simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(0);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(true);
  });

  it('treats the walkable upper face of an obstacle as ground for an expired fuse', () => {
    const simulation = createSimulation();
    const owner = player(simulation, 'local');
    const platform = simulation.map.obstacles.find((obstacle) => {
      if (obstacle.kind !== 'platform' || obstacle.max.y <= simulation.map.bounds.floorY + 0.5) return false;
      const origin = {
        x: (obstacle.min.x + obstacle.max.x) * 0.5,
        y: obstacle.max.y + 0.8,
        z: (obstacle.min.z + obstacle.max.z) * 0.5,
      };
      return raycastWorld(origin, { x: 0, y: -1, z: 0 }, 1.25, simulation.map, [])?.obstacleId === obstacle.id;
    });
    if (!platform) throw new Error('Missing elevated platform fixture');
    owner.position = { x: simulation.map.bounds.maxX - 1, y: simulation.map.bounds.floorY, z: simulation.map.bounds.maxZ - 1 };
    const projectile = grenade(owner, {
      x: (platform.min.x + platform.max.x) * 0.5,
      y: platform.max.y + 0.8,
      z: (platform.min.z + platform.max.z) * 0.5,
    }, {
      velocity: { x: 0, y: -20, z: 0 },
      fuse: -0.1,
    });
    simulation.state.projectiles.push(projectile);
    const projectedVelocityY = projectile.velocity.y - 18 * 0.05;
    const projectedTravel = Math.abs(projectedVelocityY * 0.05);
    expect(raycastWorld(
      projectile.position,
      { x: 0, y: -1, z: 0 },
      projectedTravel + projectile.radius,
      simulation.map,
      [],
    )?.obstacleId).toBe(platform.id);

    simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(0);
    expect(projectile.position.y).toBeCloseTo(platform.max.y + projectile.radius, 6);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(true);
  });

  it('detonates immediately when it directly touches a character before the timeout', () => {
    const simulation = createSimulation(['owner', 'target']);
    const owner = player(simulation, 'owner');
    const target = player(simulation, 'target');
    const { start, end } = findClearLine(simulation.map);
    owner.position = { x: simulation.map.bounds.maxX - 1, y: simulation.map.bounds.floorY, z: simulation.map.bounds.maxZ - 1 };
    target.position = { x: end.x, y: simulation.map.bounds.floorY, z: end.z };
    target.velocity = { x: 0, y: 0, z: 0 };
    target.grounded = true;
    target.spawnProtection = 0;
    const projectile = grenade(owner, start, {
      velocity: { x: 24, y: 0, z: 0 },
      armed: false,
      fuse: 1.2,
    });
    simulation.state.projectiles.push(projectile);

    simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(0);
    expect(projectile.fuse).toBeGreaterThan(0);
    expect(simulation.state.events.some((event) => event.type === 'explosion')).toBe(true);
    expect(target.shield).toBeLessThan(target.maxShield);
  });
});
