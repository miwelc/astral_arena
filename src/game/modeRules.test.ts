import { describe, expect, it } from 'vitest';

import type { GameMode } from './types';
import { canonicalFormatForMode, isTeamGameMode, MODE_RULES } from './modeRules';

const modes = Object.keys(MODE_RULES) as GameMode[];

describe('mode-specific roster rules', () => {
  it('uses 1v1 only for plain Deathmatch', () => {
    expect(MODE_RULES.deathmatch).toMatchObject({
      format: 'duel',
      maxPlayers: 2,
      teamBased: false,
    });
  });

  it('uses 4v4 only for team modes', () => {
    for (const mode of ['team-deathmatch', 'capture-the-flag', 'towah-of-powah'] as const) {
      expect(MODE_RULES[mode]).toMatchObject({
        format: 'squads',
        maxPlayers: 8,
        teamBased: true,
        formatLabel: '4 V 4',
      });
    }
  });

  it('defines Juggernaut as an eight-player free-for-all, not 1v1 or 4v4', () => {
    expect(MODE_RULES.juggernaut).toMatchObject({
      format: 'squads',
      maxPlayers: 8,
      teamBased: false,
      formatLabel: '8 JUGADORES',
    });
  });

  it('provides one canonical format and a non-empty menu label for every mode', () => {
    for (const mode of modes) {
      expect(canonicalFormatForMode(mode)).toBe(MODE_RULES[mode].format);
      expect(MODE_RULES[mode].formatDetail.length).toBeGreaterThan(4);
      expect(isTeamGameMode(mode)).toBe(MODE_RULES[mode].teamBased);
    }
  });
});
