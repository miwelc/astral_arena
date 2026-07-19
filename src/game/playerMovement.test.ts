import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasLineOfSight } from './collision';
import { isJumpPad } from './map';
import { emptyInput } from './math';
import {
  advancePlayerMovement,
  createPlayerMovementMemory,
} from './playerMovement';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { MapDefinition, PlayerInput, PlayerState, Vec3 } from './types';

const STEP = 1 / 60;
const TEST_NOW = 1_700_000_300_000;

interface MovementPair {
  simulation: GameSimulation;
  authoritative: PlayerState;
  predicted: PlayerState;
  memory: ReturnType<typeof createPlayerMovementMemory>;
  previousJump: boolean;
}

const findClearRun = (map: MapDefinition, length = 18): Vec3 => {
  for (let z = map.bounds.minZ + 4; z <= map.bounds.maxZ - 4; z += 2) {
    for (let x = map.bounds.minX + 4; x <= map.bounds.maxX - length - 4; x += 2) {
      const start = { x, y: map.bounds.floorY, z };
      const end = { x: x + length, y: map.bounds.floorY, z };
      const samples = Array.from({ length: 10 }, (_, index) => ({
        x: start.x + (length * index) / 9,
        y: start.y,
        z: start.z,
      }));
      const clearCapsuleLane = [-0.62, 0, 0.62].every((zOffset) =>
        [0.12, 0.75, 1.45].every((height) => hasLineOfSight(
          { x: start.x, y: start.y + height, z: start.z + zOffset },
          { x: end.x, y: end.y + height, z: end.z + zOffset },
          map,
        )),
      );
      if (clearCapsuleLane && samples.every((sample) => !isJumpPad(sample, map))) return start;
    }
  }
  throw new Error('The map has no clear non-jump-pad movement lane');
};

const createPair = (): MovementPair => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'deathmatch', botFill: false }),
    [{ id: 'local', name: 'Local' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  const authoritative = simulation.state.players.local;
  if (!authoritative) throw new Error('Missing local player fixture');
  const start = findClearRun(simulation.map);
  authoritative.position = { ...start };
  authoritative.velocity = { x: 0, y: 0, z: 0 };
  authoritative.grounded = true;
  authoritative.yaw = -Math.PI / 2;
  authoritative.pitch = 0;
  authoritative.input = { ...emptyInput(), yaw: authoritative.yaw };

  return {
    simulation,
    authoritative,
    predicted: structuredClone(authoritative),
    memory: createPlayerMovementMemory(),
    previousJump: false,
  };
};

const expectMovementParity = (pair: MovementPair): void => {
  expect(pair.predicted.position).toEqual(pair.authoritative.position);
  expect(pair.predicted.velocity).toEqual(pair.authoritative.velocity);
  expect(pair.predicted.grounded).toBe(pair.authoritative.grounded);
  expect(pair.predicted.crouched).toBe(pair.authoritative.crouched);
  expect(pair.predicted.height).toBe(pair.authoritative.height);
  expect(pair.memory).toEqual(pair.authoritative.movementMemory);
};

const advancePair = (pair: MovementPair, input: PlayerInput): void => {
  pair.simulation.setInput(pair.authoritative.id, input);
  pair.simulation.step(STEP);

  pair.predicted.yaw = input.yaw;
  pair.predicted.pitch = input.pitch;
  pair.predicted.input = { ...input };
  advancePlayerMovement(
    pair.predicted,
    input,
    {
      map: pair.simulation.map,
      tower: pair.simulation.state.tower,
      elapsed: pair.simulation.state.elapsed,
    },
    pair.memory,
    STEP,
    !pair.previousJump && input.jump,
  );
  pair.previousJump = input.jump;
  expectMovementParity(pair);
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('shared player movement', () => {
  it('matches the authoritative simulation while accelerating and braking', () => {
    const pair = createPair();
    const start = { ...pair.authoritative.position };

    for (let tick = 1; tick <= 45; tick += 1) {
      advancePair(pair, {
        ...emptyInput(),
        sequence: tick,
        yaw: -Math.PI / 2,
        moveZ: tick <= 25 ? 1 : 0,
      });
    }

    expect(pair.authoritative.position.x).toBeGreaterThan(start.x + 1);
    expect(Math.hypot(pair.authoritative.velocity.x, pair.authoritative.velocity.z)).toBe(0);
  });

  it('matches a single jump edge, held input and landing tick for tick', () => {
    const pair = createPair();
    let leftTheGround = false;
    let landed = false;

    for (let tick = 1; tick <= 120; tick += 1) {
      const jump = tick >= 16 && tick <= 28;
      advancePair(pair, {
        ...emptyInput(),
        sequence: tick,
        yaw: -Math.PI / 2,
        moveZ: tick <= 70 ? 1 : 0,
        jump,
      });
      if (!pair.authoritative.grounded) leftTheGround = true;
      if (leftTheGround && pair.authoritative.grounded) {
        landed = true;
        break;
      }
    }

    expect(leftTheGround).toBe(true);
    expect(landed).toBe(true);
  });

  it('keeps authoritative and predicted crouch stance and speed identical', () => {
    const pair = createPair();
    let crouchedSpeed = 0;

    for (let tick = 1; tick <= 36; tick += 1) {
      const crouch = tick <= 20;
      advancePair(pair, {
        ...emptyInput(),
        sequence: tick,
        yaw: -Math.PI / 2,
        moveZ: 1,
        crouch,
      });
      if (tick === 20) {
        expect(pair.authoritative.crouched).toBe(true);
        crouchedSpeed = Math.hypot(pair.authoritative.velocity.x, pair.authoritative.velocity.z);
      }
    }

    expect(crouchedSpeed).toBeGreaterThan(0);
    expect(pair.authoritative.crouched).toBe(false);
    expect(pair.authoritative.height).toBe(1.8);
  });
});
