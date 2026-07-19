import { describe, expect, it } from 'vitest';

import {
  BOT_DIFFICULTY_PROFILES,
  botPickupUtility,
  createBotMemory,
  isBotGrenadeSafe,
  updateBotInputs,
} from './bots';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { GameMode, PickupState, PlayerState, Vec3 } from './types';
import { WEAPONS } from './weapons';

const startBotSimulation = (
  mode: GameMode = 'deathmatch',
  players: Array<{ id: string; name: string; kind: 'bot' | 'human' }> = [
    { id: 'bot', name: 'Bot', kind: 'bot' },
  ],
): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode, format: 'squads', difficulty: 'veteran', botFill: false }),
    players,
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const botPlayer = (simulation: GameSimulation, id = 'bot'): PlayerState => {
  const player = simulation.state.players[id];
  if (!player?.bot) throw new Error(`Missing bot fixture ${id}`);
  return player;
};

const pickup = (
  kind: PickupState['kind'],
  position: Vec3,
  weaponId?: PickupState['weaponId'],
): PickupState => ({
  id: `test-${kind}-${weaponId ?? 'generic'}`,
  kind,
  weaponId,
  position: { ...position },
  available: true,
  respawnTimer: 0,
  respawnSeconds: 20,
});

describe('bot difficulty profiles', () => {
  it('keeps reaction, tracking and perception progressive without instant aim', () => {
    const { recruit, veteran, legend } = BOT_DIFFICULTY_PROFILES;

    expect(recruit.reaction).toBeGreaterThan(veteran.reaction);
    expect(veteran.reaction).toBeGreaterThan(legend.reaction);
    expect(legend.reaction).toBeGreaterThanOrEqual(0.28);

    expect(recruit.aimError).toBeGreaterThan(veteran.aimError);
    expect(veteran.aimError).toBeGreaterThan(legend.aimError);
    expect(legend.aimError * 180 / Math.PI).toBeGreaterThanOrEqual(2.5);

    expect(recruit.turnRate).toBeLessThan(veteran.turnRate);
    expect(veteran.turnRate).toBeLessThan(legend.turnRate);
    expect(legend.turnRate * 180 / Math.PI).toBeLessThanOrEqual(225);

    expect(recruit.visionRange).toBeLessThan(veteran.visionRange);
    expect(veteran.visionRange).toBeLessThan(legend.visionRange);
  });

  it('reduces combat movement and special-action pressure on every tier', () => {
    const { recruit, veteran, legend } = BOT_DIFFICULTY_PROFILES;

    expect(recruit.combatMovementScale).toBeLessThan(veteran.combatMovementScale);
    expect(veteran.combatMovementScale).toBeLessThan(legend.combatMovementScale);
    expect(legend.combatMovementScale).toBeLessThan(1);

    expect(recruit.grenadeChance).toBeLessThan(veteran.grenadeChance);
    expect(veteran.grenadeChance).toBeLessThan(legend.grenadeChance);
    expect(legend.grenadeChance).toBeLessThanOrEqual(0.05);
    expect(legend.jumpChance).toBeLessThanOrEqual(0.04);
    expect(recruit.decisionInterval).toBeGreaterThan(veteran.decisionInterval);
    expect(veteran.decisionInterval).toBeGreaterThan(legend.decisionInterval);
  });

  it('instantiates each requested difficulty without sharing mutable memory', () => {
    const recruit = createBotMemory('recruit');
    const veteran = createBotMemory('veteran');
    const legend = createBotMemory('legend');

    expect([recruit.difficulty, veteran.difficulty, legend.difficulty]).toEqual(['recruit', 'veteran', 'legend']);
    recruit.aimError.x = 99;
    expect(veteran.aimError.x).toBe(0);
    expect(legend.aimError.x).toBe(0);
  });
});

describe('bot pickup decisions', () => {
  it('rejects pickups that cannot improve its current inventory or capacity', () => {
    const simulation = startBotSimulation();
    const bot = botPlayer(simulation);
    const at = { ...bot.position };
    const grenade = pickup('grenade', at);
    const ammo = pickup('ammo', at);
    const overshield = pickup('overshield', at);
    const pulse = pickup('weapon', at, 'pulse-rifle');

    bot.grenades = 2;
    bot.shield = 175;
    for (const weapon of bot.inventory) weapon.reserve = WEAPONS[weapon.id].maxReserve;

    expect(botPickupUtility(bot, grenade)).toBe(0);
    expect(botPickupUtility(bot, ammo)).toBe(0);
    expect(botPickupUtility(bot, overshield)).toBe(0);
    expect(botPickupUtility(bot, pulse)).toBe(0);
  });

  it('only pursues resources for which it has real capacity', () => {
    const simulation = startBotSimulation();
    const bot = botPlayer(simulation);
    const nearby = { x: bot.position.x + 5, y: bot.position.y, z: bot.position.z };
    const grenade = pickup('grenade', nearby);
    simulation.state.pickups = [grenade];
    bot.grenades = 2;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);
    expect(bot.bot?.objective).toBe('attack');
    expect(bot.bot?.pickupTargetId).toBeNull();

    bot.grenades = 1;
    bot.bot!.decisionTimer = 0;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);
    expect(bot.bot?.objective).toBe('pickup');
    expect(bot.bot?.pickupTargetId).toBe(grenade.id);
  });

  it('blacklists a pickup after circling it without making progress', () => {
    const simulation = startBotSimulation();
    const bot = botPlayer(simulation);
    const center = { x: 0, y: bot.position.y, z: 0 };
    const grenade = pickup('grenade', center);
    simulation.state.pickups = [grenade];
    bot.grenades = 0;

    for (let index = 0; index < 20; index += 1) {
      const angle = index * 0.4;
      bot.position = { x: Math.cos(angle) * 10, y: center.y, z: Math.sin(angle) * 10 };
      bot.bot!.decisionTimer = 0;
      simulation.state.elapsed += 0.3;
      updateBotInputs(simulation.state, simulation.map, 0.3, () => true);
    }

    expect(bot.bot?.pickupBlacklist.some((entry) => entry.pickupId === grenade.id)).toBe(true);
    expect(bot.bot?.pickupTargetId).not.toBe(grenade.id);
  });

  it('prepares the correct weapon slot and then presses use for an upgrade', () => {
    const simulation = startBotSimulation();
    const bot = botPlayer(simulation);
    const shotgun = pickup('weapon', { ...bot.position }, 'shotgun');
    simulation.state.pickups = [shotgun];
    bot.activeWeapon = 0;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);
    expect(bot.input.swap).toBe(true);
    expect(bot.input.use).toBe(false);

    bot.activeWeapon = 1;
    bot.bot!.decisionTimer = 0;
    simulation.state.elapsed += 0.25;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);
    expect(bot.input.use).toBe(true);
  });
});

describe('bot situational awareness and safety', () => {
  it('reacts to a recent visible attacker outside its normal field of view', () => {
    const simulation = startBotSimulation('deathmatch', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'attacker', name: 'Attacker', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const attacker = simulation.state.players.attacker!;
    bot.position = { x: 0, y: 0, z: 0 };
    bot.yaw = 0;
    bot.input.yaw = 0;
    attacker.position = { x: 0, y: 0, z: 12 };
    simulation.state.events.push({
      id: ++simulation.state.eventSequence,
      time: simulation.state.elapsed,
      type: 'hit',
      actorId: attacker.id,
      targetId: bot.id,
      amount: 10,
    });

    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);

    expect(bot.bot?.targetId).toBe(attacker.id);
    expect(bot.bot?.lastSeenPosition).toEqual(attacker.position);
  });

  it('does not throw a grenade into teammates contesting the same target', () => {
    const simulation = startBotSimulation('team-deathmatch', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
      { id: 'ally', name: 'Ally', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    const ally = simulation.state.players.ally!;
    bot.position = { x: 0, y: 0, z: 0 };
    enemy.position = { x: 0, y: 0, z: 15 };
    ally.position = { x: 1, y: 0, z: 14 };

    expect(bot.team).toBe(ally.team);
    expect(isBotGrenadeSafe(simulation.state, bot, enemy)).toBe(false);

    ally.position = { x: 15, y: 0, z: 0 };
    expect(isBotGrenadeSafe(simulation.state, bot, enemy)).toBe(true);
  });

  it('volunteers for an unoccupied Towah turret once it reaches the control deck', () => {
    const simulation = startBotSimulation('towah-of-powah');
    const bot = botPlayer(simulation);
    bot.position = { ...simulation.state.tower.center };
    bot.bot!.decisionTimer = 0;
    simulation.state.tower.turretOwnerId = null;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => true);

    expect(bot.input.use).toBe(true);
  });

  it('scans behind itself and fires when operating the Towah turret', () => {
    const simulation = startBotSimulation('towah-of-powah', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { ...simulation.state.tower.center };
    bot.yaw = 0;
    bot.input.yaw = 0;
    enemy.position = {
      x: simulation.state.tower.center.x,
      y: simulation.state.tower.center.y,
      z: simulation.state.tower.center.z + 25,
    };
    simulation.state.tower.turretOwnerId = bot.id;

    let fired = false;
    for (let index = 0; index < 12 && !fired; index += 1) {
      bot.bot!.decisionTimer = 0;
      simulation.state.elapsed += 0.2;
      updateBotInputs(simulation.state, simulation.map, 0.2, () => true);
      fired ||= bot.input.fire;
      bot.yaw = bot.input.yaw;
      bot.pitch = bot.input.pitch;
    }

    expect(bot.bot?.targetId).toBe(enemy.id);
    expect(fired).toBe(true);
  });
});
