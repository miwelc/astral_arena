import { describe, expect, it } from 'vitest';

import { pointInsideObstacle } from './collision';
import { CRATER_RIDGE, isJumpPad, JUMP_PAD_ZONES, jumpPadAt } from './map';
import type { AabbObstacle, Vec3 } from './types';

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
