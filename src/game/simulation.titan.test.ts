import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TITAN_EXPANSE } from './map';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { GameMode, PlayerState, Vec3 } from './types';
import { isValidMatchState } from '../network/matchStateValidation';

const TEST_NOW = 1_700_000_700_000;
const MODES: GameMode[] = [
  'deathmatch',
  'team-deathmatch',
  'capture-the-flag',
  'juggernaut',
  'towah-of-powah',
];

const startTitan = (
  mode: GameMode,
  botFill = true,
  roster: Array<{ id: string; name: string; kind?: 'human' | 'bot' | 'remote' }> = [],
): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({
      mode,
      mapId: 'titan-expanse',
      botFill,
      playerCount: mode === 'deathmatch' ? 8 : undefined,
      scoreLimit: 10_000,
      timeLimitSeconds: 10 * 60,
    }),
    roster,
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const botPlayer = (simulation: GameSimulation, id = 'runner'): PlayerState => {
  const player = simulation.state.players[id];
  if (!player?.bot) throw new Error(`Missing Titan bot fixture ${id}`);
  return player;
};

const positionKey = ({ x, y, z }: Vec3): string =>
  `${x.toFixed(6)}:${y.toFixed(6)}:${z.toFixed(6)}`;

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('Titan Expanse simulation integration', () => {
  it.each(MODES)('runs authoritative %s play with bot fill on the heightfield', (mode) => {
    const simulation = startTitan(mode);
    for (let tick = 0; tick < 120; tick += 1) simulation.step(1 / 60);

    expect(simulation.map).toBe(TITAN_EXPANSE);
    expect(simulation.state.config.mapId).toBe('titan-expanse');
    expect(Object.keys(simulation.state.players)).toHaveLength(8);
    for (const player of Object.values(simulation.state.players)) {
      expect(Number.isFinite(player.position.x), player.id).toBe(true);
      expect(Number.isFinite(player.position.y), player.id).toBe(true);
      expect(Number.isFinite(player.position.z), player.id).toBe(true);
      expect(player.position.x).toBeGreaterThanOrEqual(TITAN_EXPANSE.bounds.minX);
      expect(player.position.x).toBeLessThanOrEqual(TITAN_EXPANSE.bounds.maxX);
      expect(player.position.z).toBeGreaterThanOrEqual(TITAN_EXPANSE.bounds.minZ);
      expect(player.position.z).toBeLessThanOrEqual(TITAN_EXPANSE.bounds.maxZ);
      expect(player.position.y).toBeGreaterThanOrEqual(
        TITAN_EXPANSE.groundHeightAt!(player.position.x, player.position.z) - 0.001,
      );
    }
    expect(isValidMatchState(simulation.state)).toBe(true);
  });

  it('uses only central neutral starts for initial FFA placement and respawn', () => {
    const simulation = startTitan('deathmatch');
    const neutralStarts = new Set(
      TITAN_EXPANSE.spawns
        .filter((spawn) => spawn.team === 'neutral')
        .map((spawn) => positionKey(spawn.position)),
    );
    expect(neutralStarts.size).toBeGreaterThanOrEqual(10);
    expect(Object.values(simulation.state.players).every((player) =>
      player.team === 'neutral' && neutralStarts.has(positionKey(player.position)),
    )).toBe(true);

    const respawning = Object.values(simulation.state.players)[0]!;
    respawning.alive = false;
    respawning.health = 0;
    respawning.respawnTimer = 0;
    respawning.position = { ...TITAN_EXPANSE.flagBases.aurora };
    simulation.step(0.05);

    expect(respawning.alive).toBe(true);
    expect(neutralStarts.has(positionKey(respawning.position))).toBe(true);
  });

  it('physically completes every authored Titan launch and drop traversal', () => {
    const specialLinks = (TITAN_EXPANSE.waypointLinks ?? []).filter((link) =>
      link.traversal === 'launch' || link.traversal === 'drop',
    );
    const failures: string[] = [];
    for (const link of specialLinks) {
      const simulation = startTitan(
        'capture-the-flag',
        false,
        [{ id: 'runner', name: 'Runner', kind: 'bot' }],
      );
      simulation.state.pickups.forEach((pickup) => {
        pickup.available = false;
        pickup.respawnTimer = 999;
      });
      const runner = botPlayer(simulation);
      const from = TITAN_EXPANSE.waypoints[link.from]!;
      const to = TITAN_EXPANSE.waypoints[link.to]!;
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
      for (let tick = 0; tick < 900; tick += 1) {
        simulation.step(1 / 120);
        if (
          Math.hypot(runner.position.x - to.x, runner.position.z - to.z) <= 1.7
          && Math.abs(runner.position.y - to.y) <= 1.25
        ) {
          reached = true;
          break;
        }
      }
      if (!reached) failures.push(`${link.from}->${link.to} (${link.traversal})`);
    }

    expect(specialLinks).toHaveLength(4);
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('keeps both bot teams advancing through a sustained CTF match', () => {
    const simulation = startTitan('capture-the-flag');
    let auroraBestX = Number.NEGATIVE_INFINITY;
    let novaBestX = Number.POSITIVE_INFINITY;
    const routedBots = { aurora: new Set<string>(), nova: new Set<string>() };
    for (let tick = 0; tick < 1_800; tick += 1) {
      simulation.step(0.05);
      for (const player of Object.values(simulation.state.players)) {
        if (!player.alive) continue;
        if (player.team === 'aurora') {
          auroraBestX = Math.max(auroraBestX, player.position.x);
          if (player.bot && player.bot.navigationGoalIndex !== null && player.bot.navigationRoute.length >= 4) {
            routedBots.aurora.add(player.id);
          }
        }
        if (player.team === 'nova') {
          novaBestX = Math.min(novaBestX, player.position.x);
          if (player.bot && player.bot.navigationGoalIndex !== null && player.bot.navigationRoute.length >= 4) {
            routedBots.nova.add(player.id);
          }
        }
      }
    }

    expect(auroraBestX).toBeGreaterThan(15);
    expect(novaBestX).toBeLessThan(-15);
    expect(routedBots.aurora.size).toBeGreaterThanOrEqual(2);
    expect(routedBots.nova.size).toBeGreaterThanOrEqual(2);
    expect(isValidMatchState(simulation.state)).toBe(true);
  }, 10_000);

  it('brings both teams onto the Towah deck during a sustained hill match', () => {
    const simulation = startTitan('towah-of-powah');
    const visitors = { aurora: new Set<string>(), nova: new Set<string>() };
    for (let tick = 0; tick < 900; tick += 1) {
      simulation.step(0.05);
      for (const player of Object.values(simulation.state.players)) {
        if (
          player.alive
          && player.team !== 'neutral'
          && player.position.y >= TITAN_EXPANSE.towerZone.controlMinY
          && Math.hypot(
            player.position.x - TITAN_EXPANSE.towerCenter.x,
            player.position.z - TITAN_EXPANSE.towerCenter.z,
          ) <= TITAN_EXPANSE.towerZone.radius
        ) {
          visitors[player.team].add(player.id);
        }
      }
    }

    expect(visitors.aurora.size).toBeGreaterThan(0);
    expect(visitors.nova.size).toBeGreaterThan(0);
    expect(simulation.state.teamScores.aurora + simulation.state.teamScores.nova).toBeGreaterThan(0);
    expect(isValidMatchState(simulation.state)).toBe(true);
  }, 10_000);
});
