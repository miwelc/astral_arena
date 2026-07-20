import { afterAll, beforeAll, bench, describe, vi } from 'vitest';

import { hasLineOfSight, moveCapsule, raycastWorld } from './collision';
import { CRATER_RIDGE } from './map';
import { createDefaultConfig, GameSimulation } from './simulation';

describe('game hot paths', () => {
  beforeAll(() => vi.spyOn(Date, 'now').mockReturnValue(1_700_000_100_000));
  afterAll(() => vi.restoreAllMocks());

  bench('600 authoritative all-bot ticks', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({
        mode: 'capture-the-flag',
        format: 'squads',
        difficulty: 'veteran',
        botFill: true,
        timeLimitSeconds: 120,
      }),
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    for (let tick = 0; tick < 600; tick += 1) simulation.step(0.05);
  });

  bench('collision and visibility queries', () => {
    const player = {
      position: { x: -31, y: 0, z: -18 },
      velocity: { x: 6.1, y: -0.3, z: 2.7 },
      radius: 0.48,
      height: 1.8,
      grounded: true,
    };
    const direction = { x: 0.91, y: 0.03, z: 0.413400193 };
    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      moveCapsule(player, CRATER_RIDGE, 0.05);
      hasLineOfSight(player.position, CRATER_RIDGE.towerCenter, CRATER_RIDGE);
      raycastWorld(player.position, direction, 80, CRATER_RIDGE, []);
    }
  });
});
