import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyInput } from './math';
import { createDefaultConfig, GameSimulation } from './simulation';
import type {
  FlagState,
  MatchConfig,
  PlayerState,
  ProjectileState,
  Team,
  Vec3,
} from './types';

const FIXED_STEP = 0.05;
const TEST_NOW = 1_700_000_000_000;

const createSimulation = (
  overrides: Partial<MatchConfig> = {},
  playerIds: readonly string[] = ['alpha', 'bravo'],
): GameSimulation =>
  new GameSimulation(
    createDefaultConfig({ botFill: false, ...overrides }),
    playerIds.map((id) => ({ id, name: id })),
  );

const startMatch = (simulation: GameSimulation): void => {
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  simulation.state.timeRemaining = Math.max(60, simulation.state.timeRemaining);
};

const player = (simulation: GameSimulation, id: string): PlayerState => {
  const value = simulation.state.players[id];
  if (!value) throw new Error(`Missing test player: ${id}`);
  return value;
};

const flag = (simulation: GameSimulation, team: Exclude<Team, 'neutral'>): FlagState => {
  const value = simulation.state.flags.find((candidate) => candidate.team === team);
  if (!value) throw new Error(`Missing ${team} flag`);
  return value;
};

const place = (value: PlayerState, position: Vec3): void => {
  value.position = { ...position };
  value.velocity = { x: 0, y: 0, z: 0 };
  value.grounded = true;
};

const advance = (simulation: GameSimulation, seconds: number): void => {
  const steps = Math.round(seconds / FIXED_STEP);
  expect(steps * FIXED_STEP).toBeCloseTo(seconds, 8);
  for (let index = 0; index < steps; index += 1) simulation.step(FIXED_STEP);
};

const explosiveAt = (
  owner: PlayerState,
  target: PlayerState,
  damage: number,
  blastRadius = 5.5,
): ProjectileState => ({
  id: 'test-explosion',
  kind: 'rocket',
  ownerId: owner.id,
  team: owner.team,
  position: {
    x: target.position.x,
    y: target.position.y + 0.9,
    z: target.position.z,
  },
  velocity: { x: 0, y: 0, z: 0 },
  radius: 0.2,
  damage,
  blastRadius,
  fuse: 0,
  alive: true,
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bot fill and team assignment', () => {
  it('fills a duel to 1v1 and keeps one player on each team', () => {
    const simulation = createSimulation(
      { mode: 'team-deathmatch', format: 'duel', botFill: true },
      ['local'],
    );
    const roster = Object.values(simulation.state.players);

    expect(simulation.maxPlayers).toBe(2);
    expect(roster).toHaveLength(2);
    expect(roster.filter((member) => member.kind === 'human')).toHaveLength(1);
    expect(roster.filter((member) => member.kind === 'bot')).toHaveLength(1);
    expect(roster.filter((member) => member.team === 'aurora')).toHaveLength(1);
    expect(roster.filter((member) => member.team === 'nova')).toHaveLength(1);
  });

  it('fills squads to 4v4 and preserves balance when a remote replaces a bot', () => {
    const simulation = createSimulation(
      { mode: 'team-deathmatch', format: 'squads', botFill: true },
      ['local'],
    );

    expect(simulation.maxPlayers).toBe(8);
    expect(Object.values(simulation.state.players)).toHaveLength(8);
    expect(Object.values(simulation.state.players).filter((member) => member.kind === 'bot')).toHaveLength(7);
    expect(Object.values(simulation.state.players).filter((member) => member.team === 'aurora')).toHaveLength(4);
    expect(Object.values(simulation.state.players).filter((member) => member.team === 'nova')).toHaveLength(4);

    const remote = simulation.addRemotePlayer('remote-1', 'Remote');

    expect(remote).not.toBeNull();
    expect(Object.values(simulation.state.players)).toHaveLength(8);
    expect(Object.values(simulation.state.players).filter((member) => member.kind === 'bot')).toHaveLength(6);
    expect(Object.values(simulation.state.players).filter((member) => member.team === 'aurora')).toHaveLength(4);
    expect(Object.values(simulation.state.players).filter((member) => member.team === 'nova')).toHaveLength(4);
  });
});

describe('combat rules', () => {
  it('waits four seconds before recharging shields at 25 points per second', () => {
    const simulation = createSimulation({ mode: 'deathmatch' }, ['alpha']);
    const alpha = player(simulation, 'alpha');
    startMatch(simulation);
    place(alpha, { x: 0, y: 0, z: 17 });
    alpha.maxShield = 100;
    alpha.shield = 20;
    alpha.lastDamageAt = 0;

    simulation.state.elapsed = 3.99;
    simulation.step(0);
    expect(alpha.shield).toBe(20);

    simulation.state.elapsed = 4;
    simulation.step(0.04);
    expect(alpha.shield).toBeCloseTo(21, 8);

    advance(simulation, 1);
    expect(alpha.shield).toBeCloseTo(46, 8);

    alpha.shield = 99.5;
    simulation.step(FIXED_STEP);
    expect(alpha.shield).toBe(100);
  });

  it('spills explosive damage through a depleted shield into health', () => {
    const simulation = createSimulation({ mode: 'deathmatch' });
    const attacker = player(simulation, 'alpha');
    const target = player(simulation, 'bravo');
    startMatch(simulation);
    place(attacker, { x: -7, y: 0, z: 17 });
    place(target, { x: 0, y: 0, z: 17 });
    attacker.spawnProtection = 0;
    target.spawnProtection = 0;
    target.shield = 100;
    target.health = 70;
    simulation.state.projectiles.push(explosiveAt(attacker, target, 130));

    simulation.step(0);

    expect(target.shield).toBe(0);
    expect(target.health).toBeCloseTo(40, 8);
    expect(target.alive).toBe(true);
    expect(simulation.state.projectiles).toHaveLength(0);
    expect(simulation.state.events.some((event) => event.type === 'shield-break' && event.targetId === target.id)).toBe(true);
  });

  it('consumes ammunition and damages an exposed target with a hitscan shot', () => {
    const simulation = createSimulation({ mode: 'deathmatch' });
    const shooter = player(simulation, 'alpha');
    const target = player(simulation, 'bravo');
    startMatch(simulation);
    place(shooter, { x: 0, y: 0, z: 20 });
    place(target, { x: 0, y: 0, z: 12 });
    shooter.spawnProtection = 0;
    target.spawnProtection = 0;
    target.shield = 100;
    target.health = 70;
    simulation.state.randomState = 0x12345678;
    const weapon = shooter.inventory[shooter.activeWeapon];
    if (!weapon) throw new Error('Shooter has no active weapon');
    const ammunitionBefore = weapon.magazine;

    simulation.setInput(shooter.id, {
      ...emptyInput(),
      sequence: 1,
      yaw: 0,
      pitch: 0,
      fire: true,
    });
    simulation.step(0);

    expect(weapon.magazine).toBe(ammunitionBefore - 1);
    expect(target.shield).toBeLessThan(100);
    expect(target.health).toBe(70);
    expect(simulation.state.events.some((event) => event.type === 'shot' && event.actorId === shooter.id)).toBe(true);
    expect(simulation.state.events.some((event) => event.type === 'hit' && event.targetId === target.id)).toBe(true);
  });
});

describe('objective modes', () => {
  it('allows an enemy flag to be picked up, the own flag to be returned, and a capture to score', () => {
    const simulation = createSimulation({ mode: 'capture-the-flag', format: 'duel' });
    const aurora = player(simulation, 'alpha');
    const nova = player(simulation, 'bravo');
    const auroraFlag = flag(simulation, 'aurora');
    const novaFlag = flag(simulation, 'nova');
    startMatch(simulation);
    place(nova, { x: 0, y: 0, z: -15 });
    place(aurora, novaFlag.basePosition);

    simulation.step(0);

    expect(novaFlag.status).toBe('carried');
    expect(novaFlag.carrierId).toBe(aurora.id);
    expect(aurora.carryingFlagTeam).toBe('nova');

    auroraFlag.status = 'dropped';
    auroraFlag.carrierId = null;
    auroraFlag.position = { x: -15, y: 0, z: 0 };
    auroraFlag.returnTimer = 8;
    place(aurora, auroraFlag.position);
    simulation.step(0);

    expect(auroraFlag.status).toBe('home');
    expect(auroraFlag.position).toEqual(auroraFlag.basePosition);
    expect(aurora.carryingFlagTeam).toBe('nova');

    place(aurora, auroraFlag.basePosition);
    simulation.step(0);

    expect(simulation.state.teamScores.aurora).toBe(1);
    expect(aurora.score).toBe(1);
    expect(aurora.carryingFlagTeam).toBeNull();
    expect(novaFlag.status).toBe('home');
    expect(novaFlag.carrierId).toBeNull();
    expect(novaFlag.position).toEqual(novaFlag.basePosition);
  });

  it('passes Juggernaut status and a point to the player who kills the current Juggernaut', () => {
    const simulation = createSimulation({ mode: 'juggernaut', format: 'duel' });
    const initialJuggernautId = simulation.state.juggernautId;
    if (!initialJuggernautId) throw new Error('No initial Juggernaut was assigned');
    const initialJuggernaut = player(simulation, initialJuggernautId);
    const successor = Object.values(simulation.state.players).find(
      (candidate) => candidate.id !== initialJuggernaut.id,
    );
    if (!successor) throw new Error('No successor is available');
    startMatch(simulation);
    place(initialJuggernaut, { x: 0, y: 0, z: 17 });
    place(successor, { x: -7, y: 0, z: 17 });
    initialJuggernaut.spawnProtection = 0;
    successor.spawnProtection = 0;
    simulation.state.projectiles.push(explosiveAt(successor, initialJuggernaut, 300));

    simulation.step(0);

    expect(initialJuggernaut.alive).toBe(false);
    expect(initialJuggernaut.isJuggernaut).toBe(false);
    expect(successor.isJuggernaut).toBe(true);
    expect(successor.maxShield).toBe(150);
    expect(successor.shield).toBe(150);
    expect(successor.score).toBe(1);
    expect(simulation.state.juggernautId).toBe(successor.id);
  });

  it('gives Towah control to a sole team occupant, fires the turret, and neutralizes when contested', () => {
    const simulation = createSimulation({ mode: 'towah-of-powah', format: 'duel' });
    const controller = player(simulation, 'alpha');
    const target = player(simulation, 'bravo');
    startMatch(simulation);
    place(controller, { x: 5, y: 6, z: 0 });
    place(target, { x: 0, y: 6, z: 10 });
    controller.spawnProtection = 0;
    target.spawnProtection = 0;
    target.health = 70;
    target.shield = 0;

    simulation.step(0);

    expect(simulation.state.tower.controllingTeam).toBe(controller.team);
    expect(simulation.state.tower.turretOwnerId).toBe(controller.id);
    expect(simulation.state.tower.turretCooldown).toBeCloseTo(0.14, 8);
    expect(target.health).toBe(57);
    expect(
      simulation.state.events.some(
        (event) => event.type === 'shot' && event.actorId === controller.id && event.message === 'Torreta',
      ),
    ).toBe(true);

    target.health = 70;
    simulation.state.tower.turretCooldown = 0;
    place(target, { x: 4, y: 6, z: 0 });
    simulation.step(0);

    expect(simulation.state.tower.controllingTeam).toBe('neutral');
    expect(simulation.state.tower.turretOwnerId).toBeNull();
    expect(target.health).toBe(70);
  });
});

describe('match lifecycle and determinism', () => {
  it('finishes immediately when a player reaches the score limit', () => {
    const simulation = createSimulation({ mode: 'deathmatch', scoreLimit: 3 });
    const alpha = player(simulation, 'alpha');
    startMatch(simulation);
    alpha.score = 3;

    simulation.step(0);

    expect(simulation.state.phase).toBe('finished');
    expect(simulation.state.winner).toBe(alpha.id);
    expect(simulation.state.events.at(-1)).toMatchObject({
      type: 'match-end',
      message: `Victoria: ${alpha.name}`,
    });
  });

  it('produces the same state for the same clock, config, initial roster, inputs, and steps', () => {
    const config = createDefaultConfig({
      mode: 'deathmatch',
      format: 'duel',
      difficulty: 'veteran',
      botFill: true,
    });
    const first = new GameSimulation(config, [{ id: 'local', name: 'Local' }]);
    const second = new GameSimulation(config, [{ id: 'local', name: 'Local' }]);
    startMatch(first);
    startMatch(second);
    const input = {
      ...emptyInput(),
      sequence: 1,
      moveX: 0.35,
      moveZ: 1,
      yaw: 0.3,
      fire: true,
    };
    first.setInput('local', input);
    second.setInput('local', input);

    advance(first, 1);
    advance(second, 1);

    expect(second.snapshot()).toEqual(first.snapshot());
  });
});
