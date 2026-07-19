import type { GameMode, MatchFormat } from './types';

export interface ModeRules {
  /** Internal roster shape retained by the network/simulation protocol. */
  format: MatchFormat;
  /** Human-readable format; unlike MatchFormat this never implies teams in FFA. */
  formatLabel: string;
  formatDetail: string;
  maxPlayers: 2 | 8;
  teamBased: boolean;
}

export const MODE_RULES: Readonly<Record<GameMode, Readonly<ModeRules>>> = Object.freeze({
  deathmatch: Object.freeze({
    format: 'duel',
    formatLabel: '1 V 1',
    formatDetail: 'DUELO · TODOS CONTRA TODOS',
    maxPlayers: 2,
    teamBased: false,
  }),
  'team-deathmatch': Object.freeze({
    format: 'squads',
    formatLabel: '4 V 4',
    formatDetail: 'AURORA CONTRA NOVA',
    maxPlayers: 8,
    teamBased: true,
  }),
  'capture-the-flag': Object.freeze({
    format: 'squads',
    formatLabel: '4 V 4',
    formatDetail: 'DOS EQUIPOS · DOS BANDERAS',
    maxPlayers: 8,
    teamBased: true,
  }),
  juggernaut: Object.freeze({
    format: 'squads',
    formatLabel: '8 JUGADORES',
    formatDetail: 'TODOS CONTRA EL COLOSO',
    maxPlayers: 8,
    teamBased: false,
  }),
  'towah-of-powah': Object.freeze({
    format: 'squads',
    formatLabel: '4 V 4',
    formatDetail: 'CONTROL DE TORRE · EQUIPOS',
    maxPlayers: 8,
    teamBased: true,
  }),
});

export const rulesForMode = (mode: GameMode): Readonly<ModeRules> => MODE_RULES[mode];

export const canonicalFormatForMode = (mode: GameMode): MatchFormat => MODE_RULES[mode].format;

export const isTeamGameMode = (mode: GameMode): boolean => MODE_RULES[mode].teamBased;
