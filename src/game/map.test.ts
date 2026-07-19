import { describe, expect, it } from 'vitest';

import { canOccupyCapsule, hasLineOfSight, moveCapsule, pointInsideObstacle, raycastWorld } from './collision';
import { directionFromAngles } from './math';
import { CRATER_RIDGE, isJumpPad, JUMP_PAD_ZONES, jumpPadAt, MAPS, TOWER_TURRET_LAYOUT, UMBRA_STATION } from './map';
import type { AabbObstacle, MapDefinition, Vec3 } from './types';

const reflectedGeometry = (obstacle: AabbObstacle): string => [
  -obstacle.max.x,
  obstacle.min.y,
  obstacle.min.z,
  -obstacle.min.x,
  obstacle.max.y,
  obstacle.max.z,
  obstacle.kind,
].join(':');

const geometry = (obstacle: AabbObstacle): string => [
  obstacle.min.x,
  obstacle.min.y,
  obstacle.min.z,
  obstacle.max.x,
  obstacle.max.y,
  obstacle.max.z,
  obstacle.kind,
].join(':');

const inBounds = (position: Vec3): boolean =>
  position.x >= CRATER_RIDGE.bounds.minX
  && position.x <= CRATER_RIDGE.bounds.maxX
  && position.z >= CRATER_RIDGE.bounds.minZ
  && position.z <= CRATER_RIDGE.bounds.maxZ
  && position.y >= CRATER_RIDGE.bounds.floorY
  && position.y < CRATER_RIDGE.bounds.ceilingY;

describe('Crater Ridge competitive layout', () => {
  it('is materially larger and more layered than the original prototype arena', () => {
    expect(CRATER_RIDGE.bounds.maxX - CRATER_RIDGE.bounds.minX).toBeGreaterThanOrEqual(100);
    expect(CRATER_RIDGE.bounds.maxZ - CRATER_RIDGE.bounds.minZ).toBeGreaterThanOrEqual(80);
    expect(CRATER_RIDGE.obstacles.length).toBeGreaterThanOrEqual(70);
    expect(Math.max(...CRATER_RIDGE.obstacles.map((obstacle) => obstacle.max.y))).toBeGreaterThan(7);
  });

  it('keeps compatibility-critical geometry and unique obstacle identifiers', () => {
    const ids = CRATER_RIDGE.obstacles.map((obstacle) => obstacle.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'tower-core',
      'tower-deck',
      'tower-cap',
      'tower-rail-n',
      'tower-rail-s',
      'tower-rail-w',
      'tower-rail-e',
      'west-base-back',
      'east-base-back',
    ]));
  });

  it('provides a genuinely raised, narrow Towah emplacement with a safe operator ring', () => {
    const cap = CRATER_RIDGE.obstacles.find((obstacle) => obstacle.id === 'tower-cap');
    expect(cap).toBeDefined();
    expect(cap?.max.y).toBeCloseTo(CRATER_RIDGE.towerCenter.y + TOWER_TURRET_LAYOUT.platformTopOffset, 8);
    expect((cap?.max.x ?? 0) - (cap?.min.x ?? 0)).toBeLessThan(4);
    expect(TOWER_TURRET_LAYOUT.operatorFeetOffset).toBeGreaterThan(TOWER_TURRET_LAYOUT.platformTopOffset);
    expect(TOWER_TURRET_LAYOUT.firingOriginOffset).toBeGreaterThan(TOWER_TURRET_LAYOUT.operatorFeetOffset + 1);

    // The square cap is furthest away on its diagonal. Even at the full
    // downward stop the authoritative ray must leave the emplacement cleanly.
    const diagonalDown = raycastWorld(
      {
        x: CRATER_RIDGE.towerCenter.x,
        y: CRATER_RIDGE.towerCenter.y + TOWER_TURRET_LAYOUT.firingOriginOffset,
        z: CRATER_RIDGE.towerCenter.z,
      },
      directionFromAngles(Math.PI / 4, TOWER_TURRET_LAYOUT.minPitch),
      70,
      CRATER_RIDGE,
      [],
    );
    expect(diagonalDown?.obstacleId).not.toBe('tower-cap');
  });

  it('uses coherent roofed buildings with playable interiors and open doors', () => {
    const ids = new Set(CRATER_RIDGE.obstacles.map((obstacle) => obstacle.id));
    for (const id of [
      'west-base-roof',
      'east-base-roof',
      'north-relay-floor',
      'north-relay-roof',
      'south-greenhouse-floor',
      'south-greenhouse-roof',
      'west-mid-canopy',
      'east-mid-canopy',
    ]) expect(ids.has(id), id).toBe(true);

    const traversableInteriorPoints = [
      { x: -40, y: 1.2, z: 0 },
      { x: -44, y: 1.2, z: 0 },
      { x: -48, y: 1.2, z: 0 },
      { x: 40, y: 1.2, z: 0 },
      { x: 44, y: 1.2, z: 0 },
      { x: 48, y: 1.2, z: 0 },
      { x: 0, y: 1, z: -32.5 },
      { x: 0, y: 1, z: -35.2 },
      { x: 0, y: 1, z: 30.2 },
      { x: 0, y: 1, z: 34.7 },
    ];
    for (const position of traversableInteriorPoints) {
      expect(pointInsideObstacle(position, CRATER_RIDGE), JSON.stringify(position)).toBe(false);
    }
  });

  it('mirrors collision geometry and team starts across the team axis', () => {
    const geometrySet = new Set(CRATER_RIDGE.obstacles.map(geometry));
    for (const obstacle of CRATER_RIDGE.obstacles) {
      expect(geometrySet.has(reflectedGeometry(obstacle)), obstacle.id).toBe(true);
    }

    const aurora = CRATER_RIDGE.spawns.filter((spawn) => spawn.team === 'aurora');
    const nova = CRATER_RIDGE.spawns.filter((spawn) => spawn.team === 'nova');
    expect(aurora).toHaveLength(nova.length);
    for (const spawn of aurora) {
      expect(nova.some((candidate) =>
        candidate.position.x === -spawn.position.x
        && candidate.position.y === spawn.position.y
        && candidate.position.z === spawn.position.z,
      )).toBe(true);
    }
    expect(CRATER_RIDGE.flagBases.nova).toEqual({
      ...CRATER_RIDGE.flagBases.aurora,
      x: -CRATER_RIDGE.flagBases.aurora.x,
    });
  });

  it('places spawns and pickups in valid playable space', () => {
    for (const spawn of CRATER_RIDGE.spawns) {
      expect(inBounds(spawn.position)).toBe(true);
      expect(pointInsideObstacle(spawn.position, CRATER_RIDGE)).toBe(false);
    }
    for (const pickup of CRATER_RIDGE.pickups) {
      expect(inBounds(pickup.position), pickup.id).toBe(true);
      expect(pointInsideObstacle(pickup.position, CRATER_RIDGE), pickup.id).toBe(false);
    }
  });

  it('keeps every raised route within the standard jump height', () => {
    const obstacleTop = (id: string): number => {
      const obstacle = CRATER_RIDGE.obstacles.find((candidate) => candidate.id === id);
      if (!obstacle) throw new Error(`Missing route obstacle ${id}`);
      return obstacle.max.y;
    };
    const routes = [
      ['west-mid-step-n', 'west-mid-gallery'],
      ['north-ridge-west-step', 'north-ridge-west', 'north-overlook-west-step', 'north-overlook-west'],
      ['south-ridge-west-step', 'south-ridge-west', 'south-planter-west-step', 'south-planter-west'],
      ['west-base', 'west-base-balcony-step-low', 'west-base-balcony-step-high', 'west-base-balcony'],
    ];

    for (const route of routes) {
      let previousTop = CRATER_RIDGE.bounds.floorY;
      for (const id of route) {
        const top = obstacleTop(id);
        expect(top - previousTop, id).toBeLessThan(1.05);
        previousTop = top;
      }
    }
  });

  it('adds shallow physical earth relief away from flat facility corridors', () => {
    const earthworks = CRATER_RIDGE.obstacles.filter((obstacle) => obstacle.id.includes('earth-'));
    expect(earthworks.length).toBeGreaterThanOrEqual(24);
    expect(earthworks.some((obstacle) => obstacle.id.includes('berm'))).toBe(true);
    expect(earthworks.some((obstacle) => obstacle.id.includes('knoll'))).toBe(true);
    expect(earthworks.some((obstacle) => obstacle.id.includes('outcrop'))).toBe(true);

    expect(earthworks.every((obstacle) => obstacle.max.x <= -35.8 || obstacle.min.x >= 35.8)).toBe(true);
    for (const obstacle of earthworks.filter((candidate) => candidate.kind === 'platform')) {
      expect(obstacle.max.y - obstacle.min.y, obstacle.id).toBeLessThanOrEqual(0.4);
    }
  });

  it('recognizes both physical jump-pad volumes without covering nearby lanes', () => {
    expect(JUMP_PAD_ZONES).toHaveLength(2);
    for (const pad of JUMP_PAD_ZONES) {
      expect(isJumpPad(pad.center)).toBe(true);
      expect(jumpPadAt(pad.center)?.id).toBe(pad.id);
      expect(pad.launchVelocity.y).toBeGreaterThan(12);
      expect(Math.sign(pad.launchVelocity.x)).toBe(-Math.sign(pad.center.x));
      expect(isJumpPad({
        x: pad.center.x,
        y: 0,
        z: pad.center.z + pad.halfSize.z + 0.1,
      })).toBe(false);
    }
  });
});

const isInMapBounds = (position: Vec3, map: MapDefinition): boolean =>
  position.x >= map.bounds.minX
  && position.x <= map.bounds.maxX
  && position.z >= map.bounds.minZ
  && position.z <= map.bounds.maxZ
  && position.y >= map.bounds.floorY
  && position.y < map.bounds.ceilingY;

const hasNearbySupport = (position: Vec3, map: MapDefinition, hoverAllowance: number): boolean => {
  if (position.y - map.bounds.floorY >= -0.01 && position.y - map.bounds.floorY <= hoverAllowance) return true;
  return map.obstacles.some((obstacle) =>
    obstacle.kind === 'platform'
    && position.x >= obstacle.min.x - 0.02
    && position.x <= obstacle.max.x + 0.02
    && position.z >= obstacle.min.z - 0.02
    && position.z <= obstacle.max.z + 0.02
    && position.y >= obstacle.max.y - 0.02
    && position.y - obstacle.max.y <= hoverAllowance,
  );
};

const reachableWaypointIndexes = (map: MapDefinition, start: number): Set<number> => {
  const visited = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const link of map.waypointLinks ?? []) {
      const targets = link.from === current
        ? [link.to]
        : link.bidirectional && link.to === current
          ? [link.from]
          : [];
      for (const target of targets) {
        if (visited.has(target)) continue;
        visited.add(target);
        pending.push(target);
      }
    }
  }
  return visited;
};

const simulateGroundTraversal = (
  map: MapDefinition,
  from: Vec3,
  to: Vec3,
): { reached: boolean; final: Vec3; hitWallTicks: number } => {
  const dt = 1 / 120;
  let player = {
    position: { ...from },
    velocity: { x: 0, y: -0.1, z: 0 },
    radius: 0.48,
    height: 1.8,
    grounded: true,
  };
  let hitWallTicks = 0;
  const directDistance = Math.hypot(to.x - from.x, to.z - from.z);
  const tickLimit = Math.ceil((directDistance / 2.4 + 5) / dt);
  for (let tick = 0; tick < tickLimit; tick += 1) {
    const dx = to.x - player.position.x;
    const dz = to.z - player.position.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal <= 0.58 && Math.abs(to.y - player.position.y) <= 0.48) {
      return { reached: true, final: player.position, hitWallTicks };
    }
    const speed = horizontal > 0.08 ? 3.2 : 0;
    const moved = moveCapsule({
      ...player,
      velocity: {
        x: horizontal > 0.08 ? dx / horizontal * speed : 0,
        y: player.grounded ? -0.1 : player.velocity.y - 24 * dt,
        z: horizontal > 0.08 ? dz / horizontal * speed : 0,
      },
    }, map, dt);
    if (moved.hitWall) hitWallTicks += 1;
    player = { ...player, ...moved };
  }
  return { reached: false, final: player.position, hitWallTicks };
};

interface NavigationArc {
  from: number;
  to: number;
  traversal: string;
}

const navigationArcs = (map: MapDefinition): NavigationArc[] => (map.waypointLinks ?? [])
  .flatMap((link) => link.bidirectional
    ? [
        { from: link.from, to: link.to, traversal: link.traversal },
        { from: link.to, to: link.from, traversal: link.traversal },
      ]
    : [{ from: link.from, to: link.to, traversal: link.traversal }]);

const navigationGraphFailures = (map: MapDefinition): string[] => {
  const failures: string[] = [];
  const seenArcs = new Set<string>();
  for (const arc of navigationArcs(map)) {
    if (!map.waypoints[arc.from] || !map.waypoints[arc.to]) {
      failures.push(`invalid ${arc.from}->${arc.to}`);
      continue;
    }
    if (arc.from === arc.to) failures.push(`self ${arc.from}->${arc.to}`);
    const key = `${arc.from}->${arc.to}`;
    if (seenArcs.has(key)) failures.push(`duplicate ${key}`);
    seenArcs.add(key);
  }
  for (let start = 0; start < map.waypoints.length; start += 1) {
    const reachable = reachableWaypointIndexes(map, start).size;
    if (reachable !== map.waypoints.length) failures.push(`reachable from ${start}: ${reachable}`);
  }
  return failures;
};

const mirroredNavigationFailures = (
  map: MapDefinition,
  requireMirroredNodes: boolean,
): string[] => {
  const nodeByPosition = new Map(map.waypoints.map((node, index) => [
    `${node.x}:${node.y}:${node.z}`,
    index,
  ]));
  const arcs = navigationArcs(map);
  const arcKeys = new Set(arcs.map((arc) => `${arc.from}->${arc.to}:${arc.traversal}`));
  const failures: string[] = [];
  for (const arc of arcs) {
    const from = map.waypoints[arc.from]!;
    const to = map.waypoints[arc.to]!;
    const mirroredFrom = nodeByPosition.get(`${from.x === 0 ? 0 : -from.x}:${from.y}:${from.z}`);
    const mirroredTo = nodeByPosition.get(`${to.x === 0 ? 0 : -to.x}:${to.y}:${to.z}`);
    if (mirroredFrom === undefined || mirroredTo === undefined) {
      if (requireMirroredNodes) failures.push(`missing mirror node for ${arc.from}->${arc.to}`);
      continue;
    }
    const mirrorKey = `${mirroredFrom}->${mirroredTo}:${arc.traversal}`;
    if (!arcKeys.has(mirrorKey)) failures.push(`missing mirror arc ${mirrorKey}`);
  }
  return failures;
};

const groundTraversalFailures = (map: MapDefinition): string[] => {
  const failures: string[] = [];
  for (const arc of navigationArcs(map)) {
    if (arc.traversal !== 'walk' && arc.traversal !== 'drop') continue;
    const result = simulateGroundTraversal(map, map.waypoints[arc.from]!, map.waypoints[arc.to]!);
    if (!result.reached) {
      failures.push(
        `${arc.from}->${arc.to} (${arc.traversal}) final=${JSON.stringify(result.final)} walls=${result.hitWallTicks}`,
      );
    }
  }
  return failures;
};

describe('Authored map navigation', () => {
  it.each([
    ['Crater Ridge', CRATER_RIDGE],
    ['Umbra Station', UMBRA_STATION],
  ] as const)('keeps every %s waypoint supported and capsule-safe', (_name, map) => {
    for (const [index, position] of map.waypoints.entries()) {
      expect(isInMapBounds(position, map), `waypoint-${index} bounds`).toBe(true);
      expect(pointInsideObstacle(position, map), `waypoint-${index} solid`).toBe(false);
      expect(hasNearbySupport(position, map, 0.12), `waypoint-${index} support ${JSON.stringify(position)}`).toBe(true);
      expect(canOccupyCapsule(position, 0.48, 1.8, map), `waypoint-${index} capsule ${JSON.stringify(position)}`).toBe(true);
    }
  });

  it.each([
    ['Crater Ridge', CRATER_RIDGE],
    ['Umbra Station', UMBRA_STATION],
  ] as const)('gives %s a strongly connected, duplicate-free directed graph', (_name, map) => {
    const failures = navigationGraphFailures(map);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it.each([
    ['Crater Ridge', CRATER_RIDGE, true],
    ['Umbra Station', UMBRA_STATION, false],
  ] as const)('keeps all mirrorable %s navigation arcs mirrored across the team axis', (_name, map, requireMirroredNodes) => {
    const failures = mirroredNavigationFailures(map, requireMirroredNodes);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it.each([
    ['Crater Ridge', CRATER_RIDGE],
    ['Umbra Station', UMBRA_STATION],
  ] as const)('makes every %s walk and drop arc physically traversable', (_name, map) => {
    const failures = groundTraversalFailures(map);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('Umbra Station vertical competitive layout', () => {
  it('is a registered compact three-level arena with coherent named structures', () => {
    expect(MAPS['umbra-station']).toBe(UMBRA_STATION);
    expect(UMBRA_STATION.name).toBe('Estación Umbra');
    expect(UMBRA_STATION.bounds.maxX - UMBRA_STATION.bounds.minX).toBeLessThan(80);
    expect(UMBRA_STATION.bounds.maxZ - UMBRA_STATION.bounds.minZ).toBeLessThan(70);
    const ids = UMBRA_STATION.obstacles.map((obstacle) => obstacle.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'tower-deck',
      'umbra-west-base-floor',
      'umbra-east-base-floor',
      'umbra-north-relay-mid-deck',
      'umbra-north-relay-roof',
      'umbra-south-annex-floor',
      'umbra-south-annex-mid-deck',
      'umbra-north-skybridge',
      'umbra-south-skybridge',
    ]));
    const playableLevels = new Set(
      UMBRA_STATION.obstacles
        .filter((obstacle) => obstacle.kind === 'platform' && obstacle.max.y > 0.5)
        .map((obstacle) => Math.round(obstacle.max.y)),
    );
    expect(playableLevels.size).toBeGreaterThanOrEqual(5);
  });

  it('keeps all spawns, objectives, pickups and navigation nodes supported and outside solids', () => {
    const points = [
      ...UMBRA_STATION.spawns.map((spawn) => ({ label: `spawn-${spawn.team}`, position: spawn.position, hover: 0.12 })),
      ...UMBRA_STATION.pickups.map((pickup) => ({ label: pickup.id, position: pickup.position, hover: 0.48 })),
      ...Object.entries(UMBRA_STATION.flagBases).map(([team, position]) => ({ label: `flag-${team}`, position, hover: 0.48 })),
    ];
    for (const { label, position, hover } of points) {
      expect(isInMapBounds(position, UMBRA_STATION), `${label} bounds`).toBe(true);
      expect(pointInsideObstacle(position, UMBRA_STATION), `${label} solid`).toBe(false);
      expect(hasNearbySupport(position, UMBRA_STATION, hover), `${label} support ${JSON.stringify(position)}`).toBe(true);
      expect(canOccupyCapsule(position, 0.48, 1.8, UMBRA_STATION), `${label} capsule ${JSON.stringify(position)}`).toBe(true);
    }
  });

  it('preserves launch/drop semantics for both grav lifts', () => {
    expect(UMBRA_STATION.waypointLinks?.length).toBeGreaterThan(UMBRA_STATION.waypoints.length);
    const launches = UMBRA_STATION.waypointLinks?.filter((link) => link.traversal === 'launch') ?? [];
    const drops = UMBRA_STATION.waypointLinks?.filter((link) => link.traversal === 'drop') ?? [];
    expect(launches).toHaveLength(UMBRA_STATION.jumpPads.length);
    expect(drops).toHaveLength(UMBRA_STATION.jumpPads.length);
    expect(launches.every((link) => !link.bidirectional)).toBe(true);
    expect(drops.every((link) => !link.bidirectional)).toBe(true);
  });

  it('lets a standard movement capsule climb the exterior base stair onto the upper ring', () => {
    let player = {
      position: { x: -25.7, y: 0, z: -15 },
      velocity: { x: 3, y: 0, z: 0 },
      radius: 0.48,
      height: 1.8,
      grounded: true,
    };
    for (let tick = 0; tick < 175; tick += 1) {
      const moved = moveCapsule(player, UMBRA_STATION, 1 / 60);
      player = { ...player, ...moved, velocity: { ...moved.velocity, x: 3 } };
    }

    expect(player.position.x).toBeGreaterThan(-17.25);
    expect(player.position.y).toBeCloseTo(2.95, 2);
    expect(player.grounded).toBe(true);
  });

  it('offers two map-local grav lifts and never confuses them with Crater Ridge pads', () => {
    expect(UMBRA_STATION.jumpPads).toHaveLength(2);
    for (const pad of UMBRA_STATION.jumpPads) {
      expect(isJumpPad(pad.center, UMBRA_STATION)).toBe(true);
      expect(jumpPadAt(pad.center, UMBRA_STATION)?.id).toBe(pad.id);
      expect(pad.launchVelocity.y).toBeGreaterThan(12);
      expect(jumpPadAt(pad.center, CRATER_RIDGE)?.id).not.toBe(pad.id);
    }
  });

  it('blocks the base-to-base sniper lane while retaining exposed diagonal bridge sightlines', () => {
    const auroraEye = { ...UMBRA_STATION.flagBases.aurora, y: 1.55 };
    const novaEye = { ...UMBRA_STATION.flagBases.nova, y: 1.55 };
    expect(hasLineOfSight(auroraEye, novaEye, UMBRA_STATION)).toBe(false);
    expect(hasLineOfSight(
      { x: -22, y: 4.15, z: -11.6 },
      { x: 22, y: 4.15, z: -11.6 },
      UMBRA_STATION,
    )).toBe(true);
  });

  it('screens the exposed north team starts from immediate cross-map spawn fire', () => {
    const northStarts = (team: 'aurora' | 'nova') => UMBRA_STATION.spawns
      .filter((spawn) => spawn.team === team && spawn.position.z <= -23)
      .map((spawn) => ({ ...spawn.position, y: spawn.position.y + 1.55 }));
    const aurora = northStarts('aurora');
    const nova = northStarts('nova');
    expect(aurora).toHaveLength(2);
    expect(nova).toHaveLength(2);
    for (const from of aurora) {
      for (const to of nova) {
        expect(hasLineOfSight(from, to, UMBRA_STATION), `${JSON.stringify(from)} -> ${JSON.stringify(to)}`).toBe(false);
      }
    }
  });

  it('aligns Towah capture, patrol and turret geometry with the raised central deck', () => {
    const deck = UMBRA_STATION.obstacles.find((obstacle) => obstacle.id === 'tower-deck');
    const cap = UMBRA_STATION.obstacles.find((obstacle) => obstacle.id === 'tower-cap');
    expect(deck?.max.y).toBeGreaterThanOrEqual(UMBRA_STATION.towerZone.controlMinY);
    expect(UMBRA_STATION.towerZone.controlMinY).toBeGreaterThan(deck?.min.y ?? 0);
    expect(UMBRA_STATION.towerZone.patrolRadius).toBeLessThan(UMBRA_STATION.towerZone.radius);
    expect(cap?.max.y).toBeCloseTo(
      UMBRA_STATION.towerCenter.y + TOWER_TURRET_LAYOUT.platformTopOffset,
      8,
    );
  });
});
