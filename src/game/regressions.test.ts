import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultConfig, GameSimulation } from './simulation';
import type { ProjectileState } from './types';
import { WEAPONS } from './weapons';

const start = (simulation: GameSimulation): void => {
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_100_000));
afterEach(() => vi.restoreAllMocks());

describe('gameplay regressions', () => {
  it('holds an overshield for ten seconds before decaying gradually', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'deathmatch', botFill: false }),
      [{ id: 'local', name: 'Local' }],
    );
    const local = simulation.state.players.local;
    const pickup = simulation.state.pickups.find((candidate) => candidate.kind === 'overshield');
    if (!local || !pickup) throw new Error('Missing overshield fixture');
    start(simulation);
    local.position = { ...pickup.position };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.step(0);

    expect(local.shield).toBe(175);
    expect(local.overshieldDecayDelay).toBe(10);
    for (let index = 0; index < 199; index += 1) simulation.step(0.05);
    expect(local.shield).toBe(175);
    simulation.step(0.05);
    simulation.step(0.05);
    expect(local.shield).toBeCloseTo(174.5, 6);
  });

  it('reassigns Juggernaut when the remote carrying the role disconnects', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'juggernaut', format: 'squads', botFill: true }),
      [{ id: 'local', name: 'Local' }],
    );
    const remote = simulation.addRemotePlayer('remote', 'Remote');
    if (!remote) throw new Error('Missing remote fixture');
    for (const candidate of Object.values(simulation.state.players)) candidate.isJuggernaut = false;
    remote.isJuggernaut = true;
    simulation.state.juggernautId = remote.id;

    simulation.removeRemotePlayer(remote.id);

    const successor = simulation.state.juggernautId ? simulation.state.players[simulation.state.juggernautId] : null;
    expect(successor?.isJuggernaut).toBe(true);
    expect(successor?.alive).toBe(true);
  });

  it('does not award Nova an arbitrary win when both teams reach the limit together', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'team-deathmatch', format: 'squads', botFill: false, scoreLimit: 10 }),
      [{ id: 'aurora', name: 'Aurora' }, { id: 'nova', name: 'Nova' }],
    );
    start(simulation);
    simulation.state.teamScores = { aurora: 10, nova: 10 };

    simulation.step(0);

    expect(simulation.state.phase).toBe('playing');
    expect(simulation.state.winner).toBeNull();
  });

  it('explodes a rocket just outside a wall so nearby targets still receive splash damage', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'deathmatch', botFill: false }),
      [{ id: 'attacker', name: 'Attacker' }, { id: 'target', name: 'Target' }],
    );
    const attacker = simulation.state.players.attacker;
    const target = simulation.state.players.target;
    if (!attacker || !target) throw new Error('Missing combat fixture');
    const wall = simulation.map.obstacles.find((obstacle) => obstacle.id === 'north-wall');
    if (!wall) throw new Error('Missing north wall fixture');
    start(simulation);
    attacker.position = { x: 0, y: 0, z: 0 };
    target.position = { x: 0, y: 0, z: wall.max.z + 3 };
    target.shield = 100;
    target.spawnProtection = 0;
    const rocket: ProjectileState = {
      id: 'wall-rocket',
      kind: 'rocket',
      ownerId: attacker.id,
      team: attacker.team,
      position: { x: 0, y: 1, z: wall.max.z + 0.8 },
      velocity: { x: 0, y: 0, z: -28 },
      radius: 0.22,
      damage: WEAPONS['rocket-launcher'].damage,
      blastRadius: 5.5,
      armed: true,
      fuse: 5,
      alive: true,
    };
    simulation.state.projectiles.push(rocket);

    simulation.step(0.05);

    expect(simulation.state.projectiles).toHaveLength(0);
    expect(target.shield).toBeLessThan(100);
  });

  it('leaves a full ammo pickup available when it cannot grant ammunition', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'deathmatch', botFill: false }),
      [{ id: 'local', name: 'Local' }],
    );
    const local = simulation.state.players.local;
    const pickup = simulation.state.pickups.find((candidate) => candidate.kind === 'ammo');
    if (!local || !pickup) throw new Error('Missing ammo fixture');
    start(simulation);
    local.position = { ...pickup.position };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    for (const weapon of local.inventory) weapon.reserve = WEAPONS[weapon.id].maxReserve;

    simulation.step(0);

    expect(pickup.available).toBe(true);
  });
});

describe('bot objective smoke tests', () => {
  it('keeps both bot teams assaulting and clearing the Towah deck instead of camping opposite sides', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'towah-of-powah', format: 'squads', difficulty: 'veteran', botFill: true }),
    );
    start(simulation);
    const deckVisitors = {
      aurora: new Set<string>(),
      nova: new Set<string>(),
    };
    for (let index = 0; index < 1_200; index += 1) {
      simulation.step(0.05);
      for (const player of Object.values(simulation.state.players)) {
        if (player.position.y >= 5.15 && player.team !== 'neutral') deckVisitors[player.team].add(player.id);
      }
    }

    expect(deckVisitors.aurora.size).toBeGreaterThanOrEqual(3);
    expect(deckVisitors.nova.size).toBeGreaterThanOrEqual(3);
    expect(simulation.state.teamScores.aurora + simulation.state.teamScores.nova).toBeGreaterThan(10);
  }, 15_000);

  it('produces flag play during a two-minute all-bot CTF simulation', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'capture-the-flag', format: 'squads', difficulty: 'veteran', botFill: true, timeLimitSeconds: 120 }),
    );
    start(simulation);
    let lastEvent = 0;
    let flagEvents = 0;
    for (let index = 0; index < 2_400; index += 1) {
      simulation.step(0.05);
      for (const event of simulation.state.events) {
        if (event.id <= lastEvent) continue;
        if (event.type === 'flag') flagEvents += 1;
        lastEvent = Math.max(lastEvent, event.id);
      }
    }
    expect(flagEvents).toBeGreaterThan(0);
    expect(simulation.state.teamScores.aurora + simulation.state.teamScores.nova).toBeGreaterThan(0);
  }, 30_000);
});
