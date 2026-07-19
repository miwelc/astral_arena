import { describe, expect, it, vi } from 'vitest';

import {
  BOT_DIFFICULTY_PROFILES,
  botPickupUtility,
  botTowerCommitment,
  createBotMemory,
  isBotGrenadeSafe,
  isPlayerRevealedToBotRadar,
  updateBotInputs,
} from './bots';
import { CRATER_RIDGE, UMBRA_STATION } from './map';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { Difficulty, GameMode, PickupState, PlayerState, Vec3 } from './types';
import { WEAPONS } from './weapons';

const startBotSimulation = (
  mode: GameMode = 'deathmatch',
  players: Array<{ id: string; name: string; kind: 'bot' | 'human' }> = [
    { id: 'bot', name: 'Bot', kind: 'bot' },
  ],
  difficulty: Difficulty = 'veteran',
): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode, format: 'squads', difficulty, botFill: false }),
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
  amount: kind === 'grenade' ? 2 : 1,
  temporary: false,
  despawnTimer: 0,
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

    expect(recruit.radarGlanceInterval).toBeNull();
    expect(veteran.radarGlanceInterval).not.toBeNull();
    expect(legend.radarGlanceInterval?.[0]).toBeLessThan(veteran.radarGlanceInterval?.[0] ?? 0);
    expect(legend.radarGlanceInterval?.[1]).toBeLessThan(veteran.radarGlanceInterval?.[1] ?? 0);
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
    simulation.state.randomState = 0x5eed1234;
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

  it('samples a noisy motion-tracker contact through cover without treating it as sight', () => {
    const simulation = startBotSimulation('towah-of-powah', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { ...simulation.state.tower.center };
    enemy.position = { x: 0, y: simulation.state.tower.center.y, z: 12 };
    enemy.velocity = { x: 1.2, y: 0, z: 0 };
    enemy.crouched = false;
    bot.bot!.decisionTimer = 0;
    bot.bot!.radarGlanceTimer = 0;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    expect(isPlayerRevealedToBotRadar(simulation.state, bot, enemy)).toBe(true);
    expect(bot.bot?.targetId).toBeNull();
    expect(bot.bot?.lastSeenPosition).toBeNull();
    expect(bot.bot?.radarContactId).toBe(enemy.id);
    expect(bot.bot?.radarContactPosition).not.toEqual(enemy.position);
    const sampledError = Math.hypot(
      (bot.bot?.radarContactPosition?.x ?? 0) - enemy.position.x,
      (bot.bot?.radarContactPosition?.z ?? 0) - enemy.position.z,
    );
    expect(sampledError).toBeGreaterThanOrEqual(BOT_DIFFICULTY_PROFILES.veteran.radarPositionError * 0.35);
    expect(sampledError).toBeLessThanOrEqual(BOT_DIFFICULTY_PROFILES.veteran.radarPositionError);
    expect(bot.input.fire).toBe(false);
  });

  it('samples only the same above, level or below elevation cue shown to a human', () => {
    const simulation = startBotSimulation('deathmatch', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { x: 0, y: 5, z: 0 };
    enemy.position = { x: 0, y: 18, z: 12 };
    enemy.velocity = { x: 1.2, y: 0, z: 0 };

    const sampledY = (targetY: number): number => {
      enemy.position.y = targetY;
      bot.bot!.decisionTimer = 0;
      bot.bot!.radarGlanceTimer = 0;
      simulation.state.elapsed += 0.1;
      updateBotInputs(simulation.state, simulation.map, 0.05, () => false);
      return bot.bot!.radarContactPosition!.y;
    };

    expect(sampledY(18)).toBeCloseTo(7.4, 8);
    expect(sampledY(5.8)).toBeCloseTo(5, 8);
    expect(sampledY(-8)).toBeCloseTo(2.6, 8);
  });

  it.each<GameMode>([
    'deathmatch',
    'team-deathmatch',
    'capture-the-flag',
    'juggernaut',
    'towah-of-powah',
  ])('lets Veteran consult radar intermittently in %s', (mode) => {
    const simulation = startBotSimulation(mode, [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { x: 0, y: 0, z: 0 };
    enemy.position = { x: 0, y: 0, z: 14 };
    enemy.velocity = { x: 1.4, y: 0, z: 0 };
    bot.bot!.decisionTimer = 0;
    bot.bot!.radarGlanceTimer = 0;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    expect(bot.bot?.radarContactId).toBe(enemy.id);
    expect(bot.bot?.radarGlanceTimer).toBeGreaterThanOrEqual(
      BOT_DIFFICULTY_PROFILES.veteran.radarGlanceInterval?.[0] ?? 0,
    );
    expect(bot.input.fire).toBe(false);
  });

  it('never gives Recruit motion-tracker knowledge', () => {
    const simulation = startBotSimulation('deathmatch', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ], 'recruit');
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { x: 0, y: 0, z: 0 };
    enemy.position = { x: 0, y: 0, z: 12 };
    enemy.velocity = { x: 2, y: 0, z: 0 };
    bot.bot!.decisionTimer = 0;
    bot.bot!.radarGlanceTimer = 0;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    expect(isPlayerRevealedToBotRadar(simulation.state, bot, enemy)).toBe(true);
    expect(bot.bot?.radarContactId).toBeNull();
    expect(bot.bot?.radarContactPosition).toBeNull();
    expect(bot.input.fire).toBe(false);
  });

  it('holds a sampled bearing still between glances, then forgets it quickly', () => {
    const simulation = startBotSimulation('deathmatch', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { x: 0, y: 0, z: 0 };
    enemy.position = { x: 0, y: 0, z: 12 };
    enemy.velocity = { x: 1.3, y: 0, z: 0 };
    bot.bot!.decisionTimer = 0;
    bot.bot!.radarGlanceTimer = 0;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);
    const sampled = { ...bot.bot!.radarContactPosition! };
    const sampledAt = bot.bot!.radarContactAt;

    enemy.position = { x: 8, y: 0, z: 12 };
    simulation.state.elapsed += 0.4;
    bot.bot!.decisionTimer = 0;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    expect(bot.bot?.radarContactPosition).toEqual(sampled);
    expect(bot.bot?.radarContactAt).toBe(sampledAt);
    expect(bot.bot?.radarContactPosition).not.toEqual(enemy.position);

    simulation.state.elapsed += BOT_DIFFICULTY_PROFILES.veteran.radarMemorySeconds + 0.01;
    bot.bot!.decisionTimer = 0;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);
    expect(bot.bot?.radarContactId).toBeNull();
    expect(bot.bot?.radarContactPosition).toBeNull();
  });

  it('does not detect crouch-walking on radar, but a shot briefly reveals it', () => {
    const simulation = startBotSimulation('towah-of-powah', [
      { id: 'bot', name: 'Bot', kind: 'bot' },
      { id: 'enemy', name: 'Enemy', kind: 'human' },
    ]);
    const bot = botPlayer(simulation);
    const enemy = simulation.state.players.enemy!;
    bot.position = { x: 0, y: 0, z: 0 };
    enemy.position = { x: 0, y: 0, z: 14 };
    enemy.velocity = { x: 2, y: 0, z: 0 };
    enemy.crouched = true;

    expect(isPlayerRevealedToBotRadar(simulation.state, bot, enemy)).toBe(false);

    simulation.state.elapsed = 5;
    simulation.state.events.push({ id: 91, time: 4.5, type: 'shot', actorId: enemy.id });
    expect(isPlayerRevealedToBotRadar(simulation.state, bot, enemy)).toBe(true);

    simulation.state.elapsed = 5.31;
    expect(isPlayerRevealedToBotRadar(simulation.state, bot, enemy)).toBe(false);
  });

  it('commits harder to an enemy-controlled hill than a safe friendly hold', () => {
    const simulation = startBotSimulation('towah-of-powah');
    const bot = botPlayer(simulation);
    bot.health = 80;
    simulation.state.tower.controllingTeam = bot.team === 'aurora' ? 'nova' : 'aurora';
    const assault = botTowerCommitment(simulation.state, bot);

    simulation.state.tower.controllingTeam = bot.team;
    bot.health = 30;
    const defensiveRecovery = botTowerCommitment(simulation.state, bot);

    expect(assault).toBeGreaterThanOrEqual(0.9);
    expect(defensiveRecovery).toBeLessThan(0.4);
    expect(assault).toBeGreaterThan(defensiveRecovery);
  });
});

describe('bot navigation on stacked authored maps', () => {
  const startUmbraCtfBot = (): GameSimulation => {
    const simulation = new GameSimulation(
      createDefaultConfig({
        mode: 'capture-the-flag',
        mapId: 'umbra-station',
        difficulty: 'veteran',
        botFill: false,
      }),
      [{ id: 'umbra-bot', name: 'Umbra Bot', kind: 'bot' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    return simulation;
  };

  it('plans and retains a directed multi-node route instead of steering at a visible floor above', () => {
    const simulation = startUmbraCtfBot();
    const bot = botPlayer(simulation, 'umbra-bot');
    bot.position = { x: 0, y: 0.05, z: -18.5 };
    bot.bot!.decisionTimer = 0;

    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    const firstRoute = [...bot.bot!.navigationRoute];
    expect(simulation.map).toBe(UMBRA_STATION);
    expect(firstRoute.length).toBeGreaterThan(3);
    expect(bot.bot!.navigationGoalIndex).not.toBeNull();
    expect(firstRoute.every((index) => UMBRA_STATION.waypoints[index] !== undefined)).toBe(true);
    const currentTarget = UMBRA_STATION.waypoints[firstRoute[bot.bot!.navigationCursor]!]!;
    expect(currentTarget.y).toBeLessThan(1.5);

    bot.bot!.decisionTimer = 0;
    simulation.state.elapsed += 0.25;
    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);
    expect(bot.bot!.navigationRoute).toEqual(firstRoute);
  });

  it('uses the authored one-way drop from the Towah deck without injecting a random jump', () => {
    const simulation = startUmbraCtfBot();
    const bot = botPlayer(simulation, 'umbra-bot');
    const towerWestIndex = UMBRA_STATION.waypoints.findIndex((waypoint) =>
      waypoint.y > 5.8 && waypoint.x < -5 && Math.abs(waypoint.z) < 1,
    );
    const towerWest = UMBRA_STATION.waypoints[towerWestIndex]!;
    bot.position = { ...towerWest };
    bot.grounded = true;
    bot.bot!.decisionTimer = 0;
    const enemyFlag = simulation.state.flags.find((candidate) => candidate.team !== bot.team)!;
    enemyFlag.status = 'dropped';
    enemyFlag.position = { ...UMBRA_STATION.jumpPads[0]!.center, y: 0.05 };

    updateBotInputs(simulation.state, simulation.map, 0.05, () => false);

    const route = bot.bot!.navigationRoute;
    const from = route[Math.max(0, bot.bot!.navigationCursor - 1)]!;
    const to = route[bot.bot!.navigationCursor]!;
    const link = UMBRA_STATION.waypointLinks?.find((candidate) =>
      candidate.from === from && candidate.to === to,
    );
    expect(link?.traversal).toBe('drop');
    expect(bot.input.jump).toBe(false);
  });

  it('physically completes every authored Crater jump and launch transition', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const failures: string[] = [];
    const transitions = (CRATER_RIDGE.waypointLinks ?? []).filter((link) =>
      link.traversal === 'jump' || link.traversal === 'launch',
    );
    try {
      for (const link of transitions) {
        const simulation = new GameSimulation(
          createDefaultConfig({
            mapId: 'crater-ridge',
            mode: 'capture-the-flag',
            format: 'squads',
            difficulty: 'veteran',
            botFill: false,
          }),
          [{ id: 'runner', name: 'Runner', kind: 'bot' }],
        );
        simulation.state.phase = 'playing';
        simulation.state.countdown = 0;
        simulation.state.pickups.forEach((candidate) => {
          candidate.available = false;
          candidate.respawnTimer = 999;
        });
        const runner = botPlayer(simulation, 'runner');
        const from = CRATER_RIDGE.waypoints[link.from]!;
        const to = CRATER_RIDGE.waypoints[link.to]!;
        runner.position = { ...from };
        runner.velocity = { x: 0, y: 0, z: 0 };
        runner.grounded = true;
        runner.bot!.decisionTimer = 0;
        const targetFlag = simulation.state.flags.find((flag) => flag.team !== runner.team)!;
        targetFlag.status = 'dropped';
        targetFlag.carrierId = null;
        targetFlag.position = { ...to };
        targetFlag.returnTimer = 999;

        let reached = false;
        for (let tick = 0; tick < 600; tick += 1) {
          simulation.step(1 / 120);
          if (
            Math.hypot(runner.position.x - to.x, runner.position.z - to.z) <= 1.65
            && Math.abs(runner.position.y - to.y) <= 1.25
          ) {
            reached = true;
            break;
          }
        }
        if (!reached) failures.push(`${link.from}->${link.to} (${link.traversal})`);
      }
    } finally {
      clock.mockRestore();
    }

    expect(transitions).toHaveLength(14);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
