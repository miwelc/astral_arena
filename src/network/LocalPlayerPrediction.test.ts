import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasLineOfSight } from '../game/collision';
import { isJumpPad } from '../game/map';
import { distance, emptyInput } from '../game/math';
import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { MapDefinition, MatchState, PlayerInput, PlayerState, Vec3 } from '../game/types';
import { clonePlayerStateForPrediction, LocalPlayerPrediction } from './LocalPlayerPrediction';

const STEP = 1 / 60;
const TEST_NOW = 1_700_000_400_000;
const PLAYER_ID = 'guest';

const findClearRun = (map: MapDefinition, length = 14): Vec3 => {
  for (let z = map.bounds.minZ + 4; z <= map.bounds.maxZ - 4; z += 2) {
    for (let x = map.bounds.minX + 4; x <= map.bounds.maxX - length - 4; x += 2) {
      const start = { x, y: map.bounds.floorY, z };
      const end = { x: x + length, y: map.bounds.floorY, z };
      const clearCapsuleLane = [-0.62, 0, 0.62].every((zOffset) =>
        [0.12, 0.75, 1.45].every((height) => hasLineOfSight(
          { x: start.x, y: start.y + height, z: start.z + zOffset },
          { x: end.x, y: end.y + height, z: start.z + zOffset },
          map,
        )),
      );
      const samplesAvoidPads = Array.from({ length: 8 }, (_, index) => ({
        x: start.x + (length * index) / 7,
        y: start.y,
        z: start.z,
      })).every((sample) => !isJumpPad(sample, map));
      if (clearCapsuleLane && samplesAvoidPads) return start;
    }
  }
  throw new Error('The map has no clear non-jump-pad prediction lane');
};

const createHost = (): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'deathmatch', botFill: false }),
    [{ id: PLAYER_ID, name: 'Guest', kind: 'remote' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  const player = simulation.state.players[PLAYER_ID];
  if (!player) throw new Error('Missing guest fixture');
  player.position = { ...findClearRun(simulation.map) };
  player.velocity = { x: 0, y: 0, z: 0 };
  player.grounded = true;
  player.yaw = -Math.PI / 2;
  player.pitch = 0;
  player.input = { ...emptyInput(), yaw: player.yaw };
  return simulation;
};

const input = (sequence: number, overrides: Partial<PlayerInput> = {}): PlayerInput => ({
  ...emptyInput(),
  sequence,
  yaw: -Math.PI / 2,
  ...overrides,
});

const playerIn = (state: MatchState): PlayerState => {
  const player = state.players[PLAYER_ID];
  if (!player) throw new Error('Missing predicted player');
  return player;
};

const presentedState = (
  prediction: LocalPlayerPrediction,
  authoritative: MatchState,
  frameDt = 0,
): MatchState => {
  const state = structuredClone(authoritative);
  prediction.applyTo(state, PLAYER_ID, frameDt);
  return state;
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('LocalPlayerPrediction', () => {
  it('deep-clones every nested player field used by current state', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'deathmatch', botFill: true, playerCount: 2 }),
      [{ id: 'human', name: 'Human', kind: 'human' }],
    );
    const source = Object.values(simulation.state.players).find((player) => player.bot);
    if (!source?.bot) throw new Error('Missing bot fixture');
    source.movementMemory.jumpPadMomentum = {
      direction: { x: 0.4, y: 0, z: -0.8 },
      minimumSpeed: 3.2,
    };
    source.bot.lastSeenPosition = { x: 1, y: 2, z: 3 };
    source.bot.radarContactPosition = { x: 4, y: 5, z: 6 };
    source.bot.navigationRoute = [1, 3, 5];
    source.bot.lastPosition = { x: 7, y: 8, z: 9 };
    source.bot.pickupBlacklist = [{ pickupId: 'pickup-a', retryAt: 12 }];
    const expected = structuredClone(source);

    const clone = clonePlayerStateForPrediction(source);

    expect(clone).toEqual(expected);
    expect(clone.position).not.toBe(source.position);
    expect(clone.velocity).not.toBe(source.velocity);
    expect(clone.inventory).not.toBe(source.inventory);
    for (let index = 0; index < source.inventory.length; index += 1) {
      expect(clone.inventory[index]).not.toBe(source.inventory[index]);
    }
    expect(clone.input).not.toBe(source.input);
    expect(clone.movementMemory).not.toBe(source.movementMemory);
    expect(clone.movementMemory.jumpPadMomentum).not.toBe(source.movementMemory.jumpPadMomentum);
    expect(clone.movementMemory.jumpPadMomentum?.direction)
      .not.toBe(source.movementMemory.jumpPadMomentum?.direction);
    expect(clone.bot).not.toBe(source.bot);
    expect(clone.bot?.lastSeenPosition).not.toBe(source.bot.lastSeenPosition);
    expect(clone.bot?.radarContactPosition).not.toBe(source.bot.radarContactPosition);
    expect(clone.bot?.navigationRoute).not.toBe(source.bot.navigationRoute);
    expect(clone.bot?.aimError).not.toBe(source.bot.aimError);
    expect(clone.bot?.lastPosition).not.toBe(source.bot.lastPosition);
    expect(clone.bot?.pickupBlacklist).not.toBe(source.bot.pickupBlacklist);
    expect(clone.bot?.pickupBlacklist[0]).not.toBe(source.bot.pickupBlacklist[0]);

    clone.position.x += 10;
    clone.velocity.y += 10;
    clone.inventory[0]!.magazine += 10;
    clone.input.fire = !clone.input.fire;
    clone.movementMemory.jumpPadMomentum!.direction.z += 10;
    clone.bot!.lastSeenPosition!.x += 10;
    clone.bot!.radarContactPosition!.y += 10;
    clone.bot!.navigationRoute[0] = 99;
    clone.bot!.aimError.z += 10;
    clone.bot!.lastPosition!.x += 10;
    clone.bot!.pickupBlacklist[0]!.retryAt += 10;
    expect(source).toEqual(expected);

    // Validation accepts snapshots from the transitional bot-memory shape with
    // these fields absent. The explicit clone must retain that exact shape too.
    const legacyShape = structuredClone(source);
    const legacyBot = legacyShape.bot as unknown as Record<string, unknown>;
    delete legacyBot.radarContactPosition;
    delete legacyBot.navigationRoute;
    delete legacyBot.navigationCursor;
    delete legacyBot.navigationGoalIndex;
    expect(clonePlayerStateForPrediction(legacyShape)).toEqual(structuredClone(legacyShape));
  });

  it('moves the local presentation immediately without waiting for a host snapshot', () => {
    const host = createHost();
    const authoritative = host.snapshot();
    const before = { ...playerIn(authoritative).position };
    const prediction = new LocalPlayerPrediction();

    prediction.advance(authoritative, PLAYER_ID, input(1, { moveZ: 1 }), STEP);
    const presented = presentedState(prediction, authoritative);

    expect(playerIn(authoritative).position).toEqual(before);
    expect(playerIn(presented).position.x).toBeGreaterThan(before.x);
    expect(playerIn(presented).velocity.x).toBeGreaterThan(0);
    expect(prediction.pendingInputCount()).toBe(1);
    expect(presented.tick).toBe(authoritative.tick);
  });

  it('preserves a jump tap shorter than one prediction tick', () => {
    const host = createHost();
    const authoritative = host.snapshot();
    const prediction = new LocalPlayerPrediction();

    prediction.observeEdge(authoritative, PLAYER_ID, input(1, { jump: true }));
    prediction.observeEdge(authoritative, PLAYER_ID, input(2, { jump: false }));
    prediction.advance(authoritative, PLAYER_ID, input(3, { jump: false }), STEP);

    const launched = playerIn(presentedState(prediction, authoritative));
    expect(launched.grounded).toBe(false);
    expect(launched.velocity.y).toBeGreaterThan(0);

    prediction.advance(authoritative, PLAYER_ID, input(4, { jump: false }), STEP);
    expect(playerIn(presentedState(prediction, authoritative)).input.jump).toBe(false);
  });

  it('does not treat a continuous ACK as confirmation of every queued edge', () => {
    const host = createHost();
    const initial = host.snapshot();
    const prediction = new LocalPlayerPrediction();

    prediction.observeEdge(initial, PLAYER_ID, input(1, { jump: true }));
    prediction.observeEdge(initial, PLAYER_ID, input(2, { jump: false }));
    prediction.observeEdge(initial, PLAYER_ID, input(3, { jump: true }));
    prediction.advance(initial, PLAYER_ID, input(4, { jump: true }), STEP);

    host.setInput(PLAYER_ID, input(4, { jump: true }));
    host.step(STEP);
    const afterFirstEdge = host.snapshot();
    prediction.reconcile(afterFirstEdge, PLAYER_ID, 4);

    prediction.advance(afterFirstEdge, PLAYER_ID, input(5, { jump: true }), STEP);
    expect(playerIn(presentedState(prediction, afterFirstEdge)).input.jump).toBe(false);
    prediction.advance(afterFirstEdge, PLAYER_ID, input(6, { jump: true }), STEP);
    expect(playerIn(presentedState(prediction, afterFirstEdge)).input.jump).toBe(true);
  });

  it('discards acknowledged commands and replays only the remaining inputs', () => {
    const host = createHost();
    const initial = host.snapshot();
    const prediction = new LocalPlayerPrediction();
    const commands = [
      input(1, { moveZ: 1 }),
      input(2, { moveZ: 1, moveX: 0.35 }),
      input(3, { moveZ: 1, moveX: -0.2 }),
    ];

    for (const command of commands) prediction.advance(initial, PLAYER_ID, command, STEP);

    host.setInput(PLAYER_ID, commands[0]!);
    host.step(STEP);
    const acknowledgedOne = host.snapshot();
    prediction.reconcile(acknowledgedOne, PLAYER_ID, 1);

    expect(prediction.pendingInputCount()).toBe(2);

    for (const command of commands.slice(1)) {
      host.setInput(PLAYER_ID, command);
      host.step(STEP);
    }
    const expected = host.snapshot();
    const presented = presentedState(prediction, acknowledgedOne);

    expect(playerIn(presented).position).toEqual(playerIn(expected).position);
    expect(playerIn(presented).velocity).toEqual(playerIn(expected).velocity);
    expect(playerIn(presented).input.sequence).toBe(3);

    prediction.reconcile(expected, PLAYER_ID, 3);
    expect(prediction.pendingInputCount()).toBe(0);
  });

  it('stays in lockstep while snapshots reconcile a jump-pad flight', () => {
    const host = createHost();
    const pad = host.map.jumpPads[0];
    if (!pad) throw new Error('The map has no jump pad fixture');
    const hostPlayer = playerIn(host.state);
    hostPlayer.position = { ...pad.center };
    hostPlayer.velocity = { x: 0, y: 0, z: 0 };
    hostPlayer.grounded = true;
    hostPlayer.yaw = Math.PI / 2;
    hostPlayer.input = { ...emptyInput(), yaw: hostPlayer.yaw };

    let authoritative = host.snapshot();
    const prediction = new LocalPlayerPrediction();
    prediction.reconcile(authoritative, PLAYER_ID, 0);
    let launched = false;

    for (let sequence = 1; sequence <= 120; sequence += 1) {
      // Steer away from the tower to exercise the pad's authoritative inward
      // momentum, including replay from a serialized movement-memory snapshot.
      const command = input(sequence, { moveZ: 1, yaw: Math.PI / 2 });
      prediction.advance(authoritative, PLAYER_ID, command, STEP);
      host.setInput(PLAYER_ID, command);
      host.step(STEP);

      const expected = host.snapshot();
      const expectedPlayer = playerIn(expected);
      const presentedPlayer = playerIn(presentedState(prediction, authoritative));
      launched ||= !expectedPlayer.grounded;

      expect(presentedPlayer.position).toEqual(expectedPlayer.position);
      expect(presentedPlayer.velocity).toEqual(expectedPlayer.velocity);
      expect(presentedPlayer.grounded).toBe(expectedPlayer.grounded);

      if (sequence % 3 === 0) {
        authoritative = expected;
        prediction.reconcile(
          authoritative,
          PLAYER_ID,
          expectedPlayer.lastProcessedInput,
        );
        const reconciledPlayer = playerIn(presentedState(prediction, authoritative));
        expect(reconciledPlayer.position).toEqual(expectedPlayer.position);
        expect(reconciledPlayer.velocity).toEqual(expectedPlayer.velocity);
      }
    }

    expect(launched).toBe(true);
  });

  it('takes reset movement memory from an authoritative respawn', () => {
    const host = createHost();
    const pad = host.map.jumpPads[0];
    if (!pad) throw new Error('The map has no jump pad fixture');
    const hostPlayer = playerIn(host.state);
    hostPlayer.position = { ...pad.center };
    hostPlayer.velocity = { x: 0, y: 0, z: 0 };
    hostPlayer.grounded = true;
    hostPlayer.yaw = Math.PI / 2;
    hostPlayer.input = { ...emptyInput(), yaw: hostPlayer.yaw };

    const initial = host.snapshot();
    const prediction = new LocalPlayerPrediction();
    const launch = input(1, { moveZ: 1, yaw: Math.PI / 2 });
    prediction.advance(initial, PLAYER_ID, launch, STEP);
    host.setInput(PLAYER_ID, launch);
    host.step(STEP);
    const airborne = host.snapshot();
    expect(playerIn(airborne).movementMemory.jumpPadMomentum).not.toBeNull();
    prediction.reconcile(airborne, PLAYER_ID, 1);

    // Reconcile the death too, so the respawn is an explicit discontinuity and
    // cannot be hidden by the normal small-correction presentation smoothing.
    hostPlayer.alive = false;
    hostPlayer.respawnTimer = 0;
    const dead = host.snapshot();
    prediction.reconcile(dead, PLAYER_ID, 1);
    host.step(STEP);

    const respawned = host.snapshot();
    const respawnedPlayer = playerIn(respawned);
    expect(respawnedPlayer.alive).toBe(true);
    expect(respawnedPlayer.movementMemory).toEqual({
      jumpPadReadyAt: 0,
      jumpPadMomentum: null,
    });
    prediction.reconcile(respawned, PLAYER_ID, 1);

    const command = input(2, { moveZ: 1 });
    prediction.advance(respawned, PLAYER_ID, command, STEP);
    host.setInput(PLAYER_ID, command);
    host.step(STEP);
    const expected = playerIn(host.snapshot());
    const presented = playerIn(presentedState(prediction, respawned));

    expect(presented.position).toEqual(expected.position);
    expect(presented.velocity).toEqual(expected.velocity);
    expect(presented.grounded).toBe(expected.grounded);
  });

  it('smooths a small authoritative correction while preserving presentation continuity', () => {
    const host = createHost();
    const initial = host.snapshot();
    const prediction = new LocalPlayerPrediction();
    prediction.advance(initial, PLAYER_ID, input(1, { moveZ: 1 }), STEP);
    const before = playerIn(presentedState(prediction, initial)).position;
    const corrected = structuredClone(initial);
    playerIn(corrected).position.x = before.x + 0.5;
    playerIn(corrected).input = input(1, { moveZ: 1 });
    playerIn(corrected).lastProcessedInput = 1;

    prediction.reconcile(corrected, PLAYER_ID, 1);
    const continuous = playerIn(presentedState(prediction, corrected, 0)).position;
    const decayed = playerIn(presentedState(prediction, corrected, 0.1)).position;
    const authoritativePosition = playerIn(corrected).position;

    expect(continuous).toEqual(before);
    expect(distance(decayed, authoritativePosition)).toBeLessThan(distance(continuous, authoritativePosition));
    expect(decayed.x).toBeGreaterThan(continuous.x);
    expect(decayed.x).toBeLessThan(authoritativePosition.x);
  });

  it('snaps immediately when the authoritative correction exceeds the safe smoothing distance', () => {
    const host = createHost();
    const initial = host.snapshot();
    const prediction = new LocalPlayerPrediction();
    prediction.advance(initial, PLAYER_ID, input(1, { moveZ: 1 }), STEP);
    const before = playerIn(presentedState(prediction, initial)).position;
    const corrected = structuredClone(initial);
    playerIn(corrected).position.x = before.x + 4;
    playerIn(corrected).input = input(1, { moveZ: 1 });
    playerIn(corrected).lastProcessedInput = 1;

    prediction.reconcile(corrected, PLAYER_ID, 1);
    const presented = playerIn(presentedState(prediction, corrected, 0)).position;

    expect(presented).toEqual(playerIn(corrected).position);
    expect(distance(presented, before)).toBeGreaterThan(3);
  });

  it('clears dead-time commands and snaps to the authoritative respawn', () => {
    const host = createHost();
    const dead = host.snapshot();
    playerIn(dead).alive = false;
    playerIn(dead).grounded = false;
    const prediction = new LocalPlayerPrediction();
    prediction.advance(dead, PLAYER_ID, input(1, { moveZ: 1, jump: true }), STEP);
    expect(prediction.pendingInputCount()).toBe(1);

    const respawned = structuredClone(dead);
    const respawnedPlayer = playerIn(respawned);
    respawnedPlayer.alive = true;
    respawnedPlayer.grounded = true;
    respawnedPlayer.position = { x: 12, y: host.map.bounds.floorY, z: -8 };
    respawnedPlayer.velocity = { x: 0, y: 0, z: 0 };
    respawnedPlayer.input = input(0);
    respawnedPlayer.movementMemory = {
      jumpPadReadyAt: 0,
      jumpPadMomentum: null,
    };

    prediction.reconcile(respawned, PLAYER_ID, 0);
    expect(prediction.pendingInputCount()).toBe(0);
    expect(playerIn(presentedState(prediction, respawned)).position).toEqual(respawnedPlayer.position);
  });

  it('bounds unacknowledged history and can discard the retained tail by ACK', () => {
    const host = createHost();
    const state = host.snapshot();
    const prediction = new LocalPlayerPrediction();

    for (let sequence = 1; sequence <= 350; sequence += 1) {
      prediction.advance(state, PLAYER_ID, input(sequence), 0);
    }

    expect(prediction.pendingInputCount()).toBe(300);
    prediction.reconcile(state, PLAYER_ID, 350);
    expect(prediction.pendingInputCount()).toBe(0);
  });
});
