import { describe, expect, it } from 'vitest';

import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { MatchState } from '../game/types';
import { isValidMatchState } from './matchStateValidation';
import { networkSnapshotState } from './networkSnapshot';

const makeState = (): MatchState => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'team-deathmatch', format: 'squads', botFill: true }),
    [{ id: 'local-player', name: 'Lince' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  simulation.step(1 / 60);
  return simulation.snapshot();
};

describe('networkSnapshotState', () => {
  it('omits authority-only bot memory without mutating the authoritative state', () => {
    const state = makeState();
    const before = structuredClone(state);
    const botEntries = Object.entries(state.players)
      .filter(([, player]) => player.bot !== undefined);
    expect(botEntries.length).toBeGreaterThan(0);

    const snapshot = networkSnapshotState(state);

    expect(snapshot).not.toBe(state);
    expect(snapshot.players).not.toBe(state.players);
    for (const [id, authoritativePlayer] of botEntries) {
      const networkPlayer = snapshot.players[id];
      expect(networkPlayer).toBeDefined();
      expect(Object.hasOwn(networkPlayer!, 'bot')).toBe(false);
      expect(Object.hasOwn(authoritativePlayer, 'bot')).toBe(true);
    }
    expect(state).toEqual(before);
    expect(isValidMatchState(snapshot)).toBe(true);
  });
});
