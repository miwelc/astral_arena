import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyInput } from './math';
import { createDefaultConfig, GameSimulation } from './simulation';
import { createWeaponState } from './weapons';
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
  it('normalizes Team Deathmatch to 4v4 even if a stale caller requests a duel', () => {
    const simulation = createSimulation(
      { mode: 'team-deathmatch', format: 'duel', botFill: true },
      ['local'],
    );
    const roster = Object.values(simulation.state.players);

    expect(simulation.state.config.format).toBe('squads');
    expect(simulation.maxPlayers).toBe(8);
    expect(roster).toHaveLength(8);
    expect(roster.filter((member) => member.kind === 'human')).toHaveLength(1);
    expect(roster.filter((member) => member.kind === 'bot')).toHaveLength(7);
    expect(roster.filter((member) => member.team === 'aurora')).toHaveLength(4);
    expect(roster.filter((member) => member.team === 'nova')).toHaveLength(4);
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

describe('input validation', () => {
  it('rejects unsafe or fractional sequences before they can contaminate a P2P snapshot', () => {
    const simulation = createSimulation({}, ['remote']);
    const initialInput = structuredClone(player(simulation, 'remote').input);

    for (const sequence of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      simulation.setInput('remote', {
        ...emptyInput(),
        sequence,
        fire: true,
        yaw: 1.2,
      });
      expect(player(simulation, 'remote').input).toEqual(initialInput);
    }
  });
});

describe('combat rules', () => {
  it('requires an explicit context action before replacing a weapon', () => {
    const simulation = createSimulation({ mode: 'deathmatch' });
    const alpha = player(simulation, 'alpha');
    const weaponPickup = simulation.state.pickups.find(
      (pickup) => pickup.kind === 'weapon' && !alpha.inventory.some((weapon) => weapon.id === pickup.weaponId),
    );
    if (!weaponPickup?.weaponId) throw new Error('Missing weapon pickup fixture');
    startMatch(simulation);
    place(alpha, weaponPickup.position);
    const activeWeaponBefore = alpha.inventory[alpha.activeWeapon]?.id;

    simulation.step(0);

    expect(weaponPickup.available).toBe(true);
    expect(alpha.inventory[alpha.activeWeapon]?.id).toBe(activeWeaponBefore);

    simulation.setInput(alpha.id, { ...emptyInput(), sequence: 1, use: true });
    simulation.step(0);

    expect(weaponPickup.available).toBe(false);
    expect(alpha.inventory[alpha.activeWeapon]?.id).toBe(weaponPickup.weaponId);
    expect(simulation.state.events.at(-1)).toMatchObject({
      type: 'pickup',
      actorId: alpha.id,
      weaponId: weaponPickup.weaponId,
    });
  });

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
    expect(simulation.state.events.filter((event) => event.type === 'shield-recharge-start' && event.targetId === alpha.id)).toHaveLength(1);

    advance(simulation, 1);
    expect(alpha.shield).toBeCloseTo(46, 8);
    expect(simulation.state.events.filter((event) => event.type === 'shield-recharge-start' && event.targetId === alpha.id)).toHaveLength(1);

    alpha.shield = 99.5;
    simulation.step(FIXED_STEP);
    expect(alpha.shield).toBe(100);
    expect(simulation.state.events.filter((event) => event.type === 'shield-recharge-complete' && event.targetId === alpha.id)).toHaveLength(1);
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
    const shot = simulation.state.events.find((event) => event.type === 'shot' && event.actorId === shooter.id);
    expect(shot).toBeDefined();
    expect(Math.abs((shot?.position?.x ?? 99) - target.position.x)).toBeLessThan(target.radius + 0.01);
    expect(shot?.position?.z).toBeGreaterThan(target.position.z);
    expect(shot?.position?.z).toBeLessThan(target.position.z + 1);
    expect(shot?.impact).toBe(true);
    expect(simulation.state.events.some((event) => event.type === 'hit' && event.targetId === target.id)).toBe(true);
  });

  it('publishes the same twelve-pellet cone used by shotgun hit resolution', () => {
    const simulation = createSimulation({ mode: 'deathmatch' }, ['alpha']);
    const shooter = player(simulation, 'alpha');
    startMatch(simulation);
    place(shooter, { x: 0, y: 0, z: 20 });
    shooter.inventory = [createWeaponState('shotgun')];
    shooter.activeWeapon = 0;
    simulation.state.randomState = 0x87654321;

    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 1, fire: true });
    simulation.step(0);

    const shot = simulation.state.events.find((event) => event.type === 'shot');
    expect(shot?.weaponId).toBe('shotgun');
    expect(shot?.traces).toHaveLength(12);
    expect(shot?.position).toEqual(shot?.traces?.[0]);
    expect(new Set(shot?.traces?.map((trace) => `${trace.x.toFixed(3)}:${trace.y.toFixed(3)}`)).size).toBeGreaterThan(8);
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
    expect(simulation.state.events.find((event) => event.flagAction === 'taken')).toMatchObject({
      actorId: aurora.id,
      actorTeam: 'aurora',
      flagTeam: 'nova',
    });

    auroraFlag.status = 'dropped';
    auroraFlag.carrierId = null;
    auroraFlag.position = { x: -15, y: 0, z: 0 };
    auroraFlag.returnTimer = 8;
    place(aurora, auroraFlag.position);
    simulation.step(0);

    expect(auroraFlag.status).toBe('home');
    expect(auroraFlag.position).toEqual(auroraFlag.basePosition);
    expect(aurora.carryingFlagTeam).toBe('nova');
    expect(simulation.state.events.find((event) => event.flagAction === 'returned')).toMatchObject({
      actorId: aurora.id,
      actorTeam: 'aurora',
      flagTeam: 'aurora',
    });

    place(aurora, auroraFlag.basePosition);
    simulation.step(0);

    expect(simulation.state.teamScores.aurora).toBe(1);
    expect(aurora.score).toBe(1);
    expect(aurora.carryingFlagTeam).toBeNull();
    expect(novaFlag.status).toBe('home');
    expect(novaFlag.carrierId).toBeNull();
    expect(novaFlag.position).toEqual(novaFlag.basePosition);
    expect(simulation.state.events.find((event) => event.flagAction === 'captured')).toMatchObject({
      actorId: aurora.id,
      actorTeam: 'aurora',
      flagTeam: 'nova',
    });
  });

  it('drops a bot-carried flag with durable metadata before replacing the bot with a remote player', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'capture-the-flag', format: 'squads', botFill: true }),
      [{ id: 'host', name: 'Host' }],
    );
    const carrier = Object.values(simulation.state.players).find(
      (candidate) => candidate.kind === 'bot' && candidate.team === 'nova',
    );
    if (!carrier) throw new Error('Missing Nova bot');
    const carriedFlag = flag(simulation, 'aurora');
    carrier.carryingFlagTeam = carriedFlag.team;
    carriedFlag.status = 'carried';
    carriedFlag.carrierId = carrier.id;
    carriedFlag.position = { ...carrier.position };

    const joined = simulation.addRemotePlayer('remote', 'Invitado');

    expect(joined?.team).toBe('nova');
    expect(simulation.state.players[carrier.id]).toBeUndefined();
    expect(carriedFlag.status).toBe('dropped');
    expect(carriedFlag.carrierId).toBeNull();
    expect(simulation.state.events.at(-1)).toMatchObject({
      type: 'flag',
      actorId: carrier.id,
      actorTeam: 'nova',
      flagTeam: 'aurora',
      flagAction: 'dropped',
    });
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

  it('requires a nearby operator to enter, aim, fire, and explicitly leave the Towah turret', () => {
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
    const personalMagazine = controller.inventory[controller.activeWeapon]?.magazine;

    simulation.setInput(controller.id, { ...emptyInput(), sequence: 1, use: true });
    simulation.step(0);

    expect(simulation.state.tower.controllingTeam).toBe(controller.team);
    expect(simulation.state.tower.turretOwnerId).toBe(controller.id);
    expect(simulation.state.tower.turretCooldown).toBe(0);
    expect(target.health).toBe(70);

    const turretOrigin = {
      x: simulation.state.tower.center.x,
      y: simulation.state.tower.center.y + 2.7,
      z: simulation.state.tower.center.z,
    };
    const horizontalRange = Math.hypot(target.position.x - turretOrigin.x, target.position.z - turretOrigin.z);
    simulation.setInput(controller.id, {
      ...emptyInput(),
      sequence: 2,
      yaw: Math.atan2(-(target.position.x - turretOrigin.x), -(target.position.z - turretOrigin.z)),
      pitch: Math.atan2(target.position.y + target.height * 0.58 - turretOrigin.y, horizontalRange),
      fire: true,
    });
    simulation.step(0);

    expect(simulation.state.tower.turretCooldown).toBeCloseTo(0.14, 8);
    expect(simulation.state.tower.turretYaw).toBeCloseTo(controller.yaw, 8);
    expect(simulation.state.tower.turretPitch).toBeCloseTo(controller.pitch, 8);
    expect(target.health).toBe(57);
    expect(controller.inventory[controller.activeWeapon]?.magazine).toBe(personalMagazine);
    expect(
      simulation.state.events.some(
        (event) => event.type === 'shot' && event.actorId === controller.id && event.message === 'Torreta',
      ),
    ).toBe(true);

    simulation.setInput(controller.id, { ...emptyInput(), sequence: 3, use: true });
    simulation.step(0);

    expect(simulation.state.tower.turretOwnerId).toBeNull();
  });

  it('does not acquire or shoot targets automatically and rejects distant operators', () => {
    const simulation = createSimulation({ mode: 'towah-of-powah', format: 'duel' });
    const controller = player(simulation, 'alpha');
    const target = player(simulation, 'bravo');
    startMatch(simulation);
    place(controller, { x: 20, y: 6, z: 0 });
    place(target, { x: 0, y: 6, z: 10 });
    controller.spawnProtection = 0;
    target.spawnProtection = 0;
    target.shield = 0;

    simulation.setInput(controller.id, { ...emptyInput(), sequence: 1, use: true });
    simulation.step(0);

    expect(simulation.state.tower.turretOwnerId).toBeNull();
    expect(target.health).toBe(70);

    simulation.setInput(controller.id, { ...emptyInput(), sequence: 2 });
    simulation.step(0);
    place(controller, { x: 5, y: 6, z: 0 });
    simulation.setInput(controller.id, { ...emptyInput(), sequence: 3, use: true });
    simulation.step(0);

    expect(simulation.state.tower.turretOwnerId).toBe(controller.id);
    expect(target.health).toBe(70);
    expect(simulation.state.events.some((event) => event.type === 'shot' && event.message === 'Torreta')).toBe(false);
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
