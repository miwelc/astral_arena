import { describe, expect, it } from 'vitest';

import { canOccupyCapsule, moveCapsule, pointInsideObstacle } from '../collision';
import { CRATER_RIDGE, MAPS, TITAN_EXPANSE } from '../map';
import type { AabbObstacle, MapDefinition, Vec3 } from '../types';
import {
  sampleTitanExpanseGroundHeight,
  TITAN_EXPANSE_BOUNDS,
  titanCreekCenterZ,
} from './titanExpanse';

const geometry = (obstacle: AabbObstacle): string => [
  obstacle.min.x,
  obstacle.min.y,
  obstacle.min.z,
  obstacle.max.x,
  obstacle.max.y,
  obstacle.max.z,
  obstacle.kind,
  obstacle.render ?? true,
].join(':');

const reflectedGeometry = (obstacle: AabbObstacle): string => [
  -obstacle.max.x,
  obstacle.min.y,
  obstacle.min.z,
  -obstacle.min.x,
  obstacle.max.y,
  obstacle.max.z,
  obstacle.kind,
  obstacle.render ?? true,
].join(':');

const inBounds = (position: Vec3, map: MapDefinition): boolean =>
  position.x >= map.bounds.minX
  && position.x <= map.bounds.maxX
  && position.z >= map.bounds.minZ
  && position.z <= map.bounds.maxZ
  && position.y >= map.groundHeightAt!(position.x, position.z) - 0.01
  && position.y < map.bounds.ceilingY;

const supported = (position: Vec3, hover: number): boolean => {
  const terrain = sampleTitanExpanseGroundHeight(position.x, position.z);
  if (position.y >= terrain - 0.01 && position.y - terrain <= hover) return true;
  return TITAN_EXPANSE.obstacles.some((obstacle) =>
    obstacle.kind === 'platform'
    && position.x >= obstacle.min.x - 0.02
    && position.x <= obstacle.max.x + 0.02
    && position.z >= obstacle.min.z - 0.02
    && position.z <= obstacle.max.z + 0.02
    && position.y >= obstacle.max.y - 0.02
    && position.y - obstacle.max.y <= hover,
  );
};

interface Arc {
  from: number;
  to: number;
  traversal: string;
}

const arcs = (): Arc[] => (TITAN_EXPANSE.waypointLinks ?? []).flatMap((link) =>
  link.bidirectional
    ? [
        { from: link.from, to: link.to, traversal: link.traversal },
        { from: link.to, to: link.from, traversal: link.traversal },
      ]
    : [{ from: link.from, to: link.to, traversal: link.traversal }]);

const reachableFrom = (start: number): Set<number> => {
  const visited = new Set([start]);
  const pending = [start];
  const graphArcs = arcs();
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const arc of graphArcs) {
      if (arc.from !== current || visited.has(arc.to)) continue;
      visited.add(arc.to);
      pending.push(arc.to);
    }
  }
  return visited;
};

const simulateWalk = (from: Vec3, to: Vec3): boolean => {
  const dt = 1 / 90;
  let player = {
    position: { ...from },
    velocity: pointVelocity(0, -0.1, 0),
    radius: 0.48,
    height: 1.8,
    grounded: true,
  };
  const distance = Math.hypot(to.x - from.x, to.z - from.z);
  const tickLimit = Math.ceil((distance / 3.4 + 4) / dt);
  for (let tick = 0; tick < tickLimit; tick += 1) {
    const dx = to.x - player.position.x;
    const dz = to.z - player.position.z;
    const remaining = Math.hypot(dx, dz);
    if (remaining <= 0.58 && Math.abs(to.y - player.position.y) <= 0.5) return true;
    const speed = remaining > 0.08 ? 4 : 0;
    const moved = moveCapsule({
      ...player,
      velocity: pointVelocity(
        remaining > 0.08 ? dx / remaining * speed : 0,
        player.grounded ? -0.1 : player.velocity.y - 24 * dt,
        remaining > 0.08 ? dz / remaining * speed : 0,
      ),
    }, TITAN_EXPANSE, dt);
    player = { ...player, ...moved };
  }
  return false;
};

function pointVelocity(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

describe('Titan Expanse highland layout', () => {
  it('registers an exact four-times-area arena', () => {
    expect(MAPS['titan-expanse']).toBe(TITAN_EXPANSE);
    expect(TITAN_EXPANSE.name).toBe('Extensión Titán');
    expect(TITAN_EXPANSE.bounds).toEqual(TITAN_EXPANSE_BOUNDS);
    const titanWidth = TITAN_EXPANSE.bounds.maxX - TITAN_EXPANSE.bounds.minX;
    const titanDepth = TITAN_EXPANSE.bounds.maxZ - TITAN_EXPANSE.bounds.minZ;
    const craterArea = (CRATER_RIDGE.bounds.maxX - CRATER_RIDGE.bounds.minX)
      * (CRATER_RIDGE.bounds.maxZ - CRATER_RIDGE.bounds.minZ);
    expect(titanWidth).toBe(208);
    expect(titanDepth).toBe(168);
    expect(titanWidth * titanDepth).toBe(craterArea * 4);
  });

  it('samples deterministic, mirrored, smooth terrain with authored flat routes', () => {
    let maximumHeight = 0;
    let maximumOneMetreChange = 0;
    for (let x = -104; x <= 104; x += 4) {
      for (let z = -84; z <= 84; z += 4) {
        const height = sampleTitanExpanseGroundHeight(x, z);
        expect(Number.isFinite(height)).toBe(true);
        expect(sampleTitanExpanseGroundHeight(x, z)).toBe(height);
        expect(sampleTitanExpanseGroundHeight(-x, z)).toBeCloseTo(height, 12);
        maximumHeight = Math.max(maximumHeight, height);
        maximumOneMetreChange = Math.max(
          maximumOneMetreChange,
          Math.abs(sampleTitanExpanseGroundHeight(x + 1, z) - height),
          Math.abs(sampleTitanExpanseGroundHeight(x, z + 1) - height),
        );
      }
    }
    expect(maximumHeight).toBeGreaterThan(2.5);
    expect(maximumHeight).toBeLessThan(5);
    expect(maximumOneMetreChange).toBeLessThan(0.75);
    for (const x of [-96, -52, 0, 52, 96]) {
      expect(sampleTitanExpanseGroundHeight(x, 0)).toBe(0);
      expect(sampleTitanExpanseGroundHeight(x, titanCreekCenterZ(x))).toBe(0);
    }
  });

  it('uses unique semantic IDs and collision-only natural boundaries', () => {
    const obstacleIds = TITAN_EXPANSE.obstacles.map((obstacle) => obstacle.id);
    const pickupIds = TITAN_EXPANSE.pickups.map((pickup) => pickup.id);
    const padIds = TITAN_EXPANSE.jumpPads.map((pad) => pad.id);
    expect(new Set(obstacleIds).size).toBe(obstacleIds.length);
    expect(new Set(pickupIds).size).toBe(pickupIds.length);
    expect(new Set(padIds).size).toBe(padIds.length);
    expect(obstacleIds).toEqual(expect.arrayContaining([
      'titan-west-base-floor',
      'titan-east-base-floor',
      'tower-core',
      'tower-deck',
      'tower-cap',
    ]));
    const boundaries = TITAN_EXPANSE.obstacles.filter((obstacle) => obstacle.id.startsWith('titan-boundary-'));
    expect(boundaries).toHaveLength(4);
    expect(boundaries.every((obstacle) => obstacle.render === false)).toBe(true);
  });

  it('mirrors collision, starts, objectives, and terrain across the team axis', () => {
    const geometrySet = new Set(TITAN_EXPANSE.obstacles.map(geometry));
    for (const obstacle of TITAN_EXPANSE.obstacles) {
      expect(geometrySet.has(reflectedGeometry(obstacle)), obstacle.id).toBe(true);
    }

    const aurora = TITAN_EXPANSE.spawns.filter((spawn) => spawn.team === 'aurora');
    const nova = TITAN_EXPANSE.spawns.filter((spawn) => spawn.team === 'nova');
    expect(aurora).toHaveLength(8);
    expect(nova).toHaveLength(aurora.length);
    for (const spawn of aurora) {
      expect(nova.some((candidate) =>
        candidate.position.x === -spawn.position.x
        && candidate.position.y === spawn.position.y
        && candidate.position.z === spawn.position.z,
      )).toBe(true);
    }
    expect(TITAN_EXPANSE.flagBases.nova).toEqual({
      ...TITAN_EXPANSE.flagBases.aurora,
      x: -TITAN_EXPANSE.flagBases.aurora.x,
    });
  });

  it('keeps every spawn, pickup, objective, and waypoint supported and capsule-safe', () => {
    const points = [
      ...TITAN_EXPANSE.spawns.map((spawn) => ({ label: `spawn-${spawn.team}`, position: spawn.position, hover: 0.12 })),
      ...TITAN_EXPANSE.pickups.map((pickup) => ({ label: pickup.id, position: pickup.position, hover: 0.5 })),
      ...Object.entries(TITAN_EXPANSE.flagBases).map(([team, position]) => ({ label: `flag-${team}`, position, hover: 0.5 })),
      ...TITAN_EXPANSE.waypoints.map((position, index) => ({ label: `waypoint-${index}`, position, hover: 0.12 })),
    ];
    for (const { label, position, hover } of points) {
      expect(inBounds(position, TITAN_EXPANSE), `${label} bounds ${JSON.stringify(position)}`).toBe(true);
      expect(pointInsideObstacle(position, TITAN_EXPANSE), `${label} solid ${JSON.stringify(position)}`).toBe(false);
      expect(supported(position, hover), `${label} support ${JSON.stringify(position)}`).toBe(true);
      expect(canOccupyCapsule(position, 0.48, 1.8, TITAN_EXPANSE), `${label} capsule ${JSON.stringify(position)}`).toBe(true);
    }
  });

  it('provides safe central free-for-all starts and field-wide pickups', () => {
    const neutral = TITAN_EXPANSE.spawns.filter((spawn) => spawn.team === 'neutral');
    expect(TITAN_EXPANSE.preferNeutralSpawns).toBe(true);
    expect(neutral.length).toBeGreaterThanOrEqual(10);
    for (let left = 0; left < neutral.length; left += 1) {
      for (let right = left + 1; right < neutral.length; right += 1) {
        const first = neutral[left]!.position;
        const second = neutral[right]!.position;
        expect(Math.hypot(first.x - second.x, first.z - second.z)).toBeGreaterThanOrEqual(15);
      }
    }
    const xs = TITAN_EXPANSE.pickups.map((pickup) => pickup.position.x);
    const zs = TITAN_EXPANSE.pickups.map((pickup) => pickup.position.z);
    expect(TITAN_EXPANSE.pickups.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(135);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(100);
  });

  it('keeps a compact, strongly connected, mirrored authored navigation graph', () => {
    expect(TITAN_EXPANSE.waypoints.length).toBeGreaterThan(45);
    expect(TITAN_EXPANSE.waypoints.length).toBeLessThan(128);
    const graphArcs = arcs();
    const keys = new Set<string>();
    for (const arc of graphArcs) {
      expect(TITAN_EXPANSE.waypoints[arc.from]).toBeDefined();
      expect(TITAN_EXPANSE.waypoints[arc.to]).toBeDefined();
      expect(arc.from).not.toBe(arc.to);
      const key = `${arc.from}->${arc.to}:${arc.traversal}`;
      expect(keys.has(key), `duplicate ${key}`).toBe(false);
      keys.add(key);
    }
    for (let start = 0; start < TITAN_EXPANSE.waypoints.length; start += 1) {
      expect(reachableFrom(start).size, `reachable from ${start}`).toBe(TITAN_EXPANSE.waypoints.length);
    }

    const nodeAt = new Map(TITAN_EXPANSE.waypoints.map((node, index) => [
      `${node.x}:${node.y}:${node.z}`,
      index,
    ]));
    for (const arc of graphArcs) {
      const from = TITAN_EXPANSE.waypoints[arc.from]!;
      const to = TITAN_EXPANSE.waypoints[arc.to]!;
      const mirroredFrom = nodeAt.get(`${from.x === 0 ? 0 : -from.x}:${from.y}:${from.z}`);
      const mirroredTo = nodeAt.get(`${to.x === 0 ? 0 : -to.x}:${to.y}:${to.z}`);
      expect(mirroredFrom, `mirror node ${arc.from}`).toBeDefined();
      expect(mirroredTo, `mirror node ${arc.to}`).toBeDefined();
      expect(keys.has(`${mirroredFrom}->${mirroredTo}:${arc.traversal}`), `mirror arc ${arc.from}->${arc.to}`).toBe(true);
    }
  });

  it('makes every authored walk arc physically traversable over the relief', () => {
    for (const arc of arcs().filter((candidate) => candidate.traversal === 'walk')) {
      const from = TITAN_EXPANSE.waypoints[arc.from]!;
      const to = TITAN_EXPANSE.waypoints[arc.to]!;
      expect(simulateWalk(from, to), `${arc.from}->${arc.to}`).toBe(true);
    }
  });
});
