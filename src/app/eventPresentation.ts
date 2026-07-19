import type { GameEvent, MatchState, PlayerState, Team } from '../game/types';
import { isTeamGameMode } from '../game/modeRules';

export type EventPresentationTone = 'success' | 'danger' | 'team' | 'objective' | 'neutral';
export type EventPresentationPlacement = 'center' | 'feed' | 'both';
export type EventPresentationCue =
  | 'kill-confirmed'
  | 'player-down'
  | 'teammate-down'
  | 'objective-positive'
  | 'objective-negative'
  | 'match-positive'
  | 'match-negative'
  | 'neutral';

export interface EventPresentation {
  eventId: number;
  headline: string;
  detail?: string;
  feedText: string;
  placement: EventPresentationPlacement;
  tone: EventPresentationTone;
  cue: EventPresentationCue;
  /** Relative importance, from a routine feed update to a match-ending result. */
  priority: number;
  durationMs: number;
  /** Short phrase intended for a browser or recorded announcer, not routine kill chatter. */
  voice?: string;
}

const isTeamMode = (state: MatchState): boolean =>
  isTeamGameMode(state.config.mode);

const normalized = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');

const playerName = (player: PlayerState | undefined, fallback = 'Astronauta'): string => player?.name ?? fallback;

const playerNamedAtStart = (state: MatchState, message: string): PlayerState | undefined => {
  const normalizedMessage = normalized(message);
  return Object.values(state.players)
    .sort((left, right) => right.name.length - left.name.length)
    .find((player) => normalizedMessage.startsWith(`${normalized(player.name)} `));
};

const eventActor = (event: GameEvent, state: MatchState): PlayerState | undefined =>
  (event.actorId ? state.players[event.actorId] : undefined)
  ?? (event.actorTeam === undefined ? playerNamedAtStart(state, event.message ?? '') : undefined);

const isAlly = (
  candidate: PlayerState | undefined,
  local: PlayerState | undefined,
  state: MatchState,
): boolean => Boolean(
  candidate
  && local
  && candidate.id !== local.id
  && candidate.team !== 'neutral'
  && candidate.team === local.team
  && isTeamMode(state),
);

const isLocalWinner = (state: MatchState, local: PlayerState | undefined): boolean => {
  if (!local || !state.winner) return false;
  if (state.winner === local.id) return true;
  return isTeamMode(state) && local.team !== 'neutral' && state.winner === local.team;
};

const basePresentation = (
  event: GameEvent,
  headline: string,
  options: Omit<EventPresentation, 'eventId' | 'headline' | 'feedText'> & { feedText?: string },
): EventPresentation => ({
  eventId: event.id,
  headline,
  feedText: options.feedText ?? event.message ?? headline,
  placement: options.placement,
  tone: options.tone,
  cue: options.cue,
  priority: options.priority,
  durationMs: options.durationMs,
  ...(options.detail ? { detail: options.detail } : {}),
  ...(options.voice ? { voice: options.voice } : {}),
});

const presentKill = (event: GameEvent, state: MatchState, localPlayerId: string): EventPresentation => {
  const local = state.players[localPlayerId];
  const killer = event.actorId ? state.players[event.actorId] : undefined;
  const victim = event.targetId ? state.players[event.targetId] : undefined;
  const feedText = event.message ?? `${playerName(killer)} eliminó a ${playerName(victim)}`;

  if (victim?.id === localPlayerId) {
    const selfInflicted = !killer || killer.id === victim.id;
    return basePresentation(event, 'HAS CAÍDO', {
      detail: selfInflicted ? 'Caída en combate' : `Eliminado por ${killer.name}`,
      feedText,
      placement: 'both',
      tone: 'danger',
      cue: 'player-down',
      priority: 76,
      durationMs: 2500,
    });
  }

  if (killer?.id === localPlayerId) {
    return basePresentation(event, 'ENEMIGO ABATIDO', {
      detail: playerName(victim),
      feedText,
      placement: 'both',
      tone: 'success',
      cue: 'kill-confirmed',
      priority: 64,
      durationMs: 1800,
    });
  }

  if (victim && isAlly(victim, local, state)) {
    return basePresentation(event, 'COMPAÑERO CAÍDO', {
      detail: killer ? `${victim.name} · ${killer.name}` : victim.name,
      feedText,
      placement: 'both',
      tone: 'danger',
      cue: 'teammate-down',
      priority: 54,
      durationMs: 2100,
    });
  }

  if (killer && isAlly(killer, local, state)) {
    return basePresentation(event, 'ENEMIGO ABATIDO', {
      detail: `${killer.name} · ${playerName(victim)}`,
      feedText,
      placement: 'feed',
      tone: 'team',
      cue: 'neutral',
      priority: 28,
      durationMs: 2800,
    });
  }

  return basePresentation(event, 'BAJA EN COMBATE', {
    detail: feedText,
    feedText,
    placement: 'feed',
    tone: 'neutral',
    cue: 'neutral',
    priority: 12,
    durationMs: 2800,
  });
};

const teamMentionedInMessage = (message: string): Exclude<Team, 'neutral'> | undefined => {
  const value = normalized(message);
  if (/(^|\s)aurora(\s|$)/.test(value)) return 'aurora';
  if (/(^|\s)nova(\s|$)/.test(value)) return 'nova';
  return undefined;
};

const presentFlag = (event: GameEvent, state: MatchState, localPlayerId: string): EventPresentation => {
  const local = state.players[localPlayerId];
  const actor = eventActor(event, state);
  const actorTeam = actor?.team ?? event.actorTeam;
  const message = event.message ?? 'Estado de la bandera actualizado';
  const value = normalized(message);
  const actorIsLocal = actor?.id === localPlayerId;
  const actorIsAlly = isAlly(actor, local, state) || Boolean(
    !actor
    && local
    && actorTeam !== undefined
    && actorTeam !== 'neutral'
    && actorTeam === local.team
    && isTeamMode(state),
  );
  const friendlyActor = actorIsLocal || actorIsAlly;

  if (event.flagAction === 'captured' || value.includes('captur')) {
    return basePresentation(event, friendlyActor ? 'BANDERA CAPTURADA' : 'CAPTURA ENEMIGA', {
      detail: message,
      placement: 'both',
      tone: friendlyActor ? 'success' : 'danger',
      cue: friendlyActor ? 'objective-positive' : 'objective-negative',
      priority: 96,
      durationMs: 3800,
      voice: friendlyActor ? 'Bandera capturada' : 'El enemigo ha capturado la bandera',
    });
  }

  if (event.flagAction === 'taken' || value.includes('tomo') || value.includes('recogio') || value.includes('robo')) {
    if (actorIsLocal) {
      return basePresentation(event, 'TIENES LA BANDERA', {
        detail: 'Regresa a tu base',
        placement: 'both',
        tone: 'objective',
        cue: 'objective-positive',
        priority: 88,
        durationMs: 3000,
        voice: 'Bandera enemiga tomada',
      });
    }
    return basePresentation(event, actorIsAlly ? 'TU EQUIPO TIENE LA BANDERA' : 'HAN ROBADO TU BANDERA', {
      detail: message,
      placement: 'both',
      tone: actorIsAlly ? 'team' : 'danger',
      cue: actorIsAlly ? 'objective-positive' : 'objective-negative',
      priority: actorIsAlly ? 82 : 90,
      durationMs: 3000,
      voice: actorIsAlly ? 'Tu equipo tiene la bandera' : 'El enemigo tiene tu bandera',
    });
  }

  if (event.flagAction === 'dropped' || value.includes('solto') || value.includes('perdio') || value.includes('cayo')) {
    return basePresentation(event, friendlyActor ? 'BANDERA ENEMIGA PERDIDA' : 'TU BANDERA ESTÁ EN EL SUELO', {
      detail: message,
      placement: 'both',
      tone: friendlyActor ? 'objective' : 'danger',
      cue: friendlyActor ? 'objective-negative' : 'objective-positive',
      priority: 86,
      durationMs: 3000,
      voice: friendlyActor ? 'Bandera perdida' : 'Tu bandera ha caído',
    });
  }

  if (event.flagAction === 'returned') {
    const ownFlag = Boolean(local && event.flagTeam && local.team === event.flagTeam);
    return basePresentation(event, ownFlag ? 'BANDERA DEVUELTA' : 'BANDERA ENEMIGA DEVUELTA', {
      detail: message,
      placement: 'both',
      tone: ownFlag ? 'success' : 'objective',
      cue: ownFlag ? 'objective-positive' : 'objective-negative',
      priority: 84,
      durationMs: 2800,
      voice: ownFlag ? 'Bandera devuelta' : 'Bandera enemiga devuelta',
    });
  }

  if (value.includes('devolvio')) {
    return basePresentation(event, friendlyActor ? 'BANDERA DEVUELTA' : 'BANDERA ENEMIGA DEVUELTA', {
      detail: message,
      placement: 'both',
      tone: friendlyActor ? 'success' : 'objective',
      cue: friendlyActor ? 'objective-positive' : 'objective-negative',
      priority: 84,
      durationMs: 2800,
      voice: friendlyActor ? 'Bandera devuelta' : 'Bandera enemiga devuelta',
    });
  }

  if (value.includes('volvio') || value.includes('regreso')) {
    const returnedTeam = teamMentionedInMessage(message);
    const ownFlag = Boolean(local && returnedTeam && local.team === returnedTeam);
    return basePresentation(event, ownFlag ? 'TU BANDERA VOLVIÓ A BASE' : 'BANDERA ENEMIGA DEVUELTA', {
      detail: message,
      placement: 'both',
      tone: ownFlag ? 'success' : 'objective',
      cue: ownFlag ? 'objective-positive' : 'objective-negative',
      priority: 82,
      durationMs: 2700,
      voice: ownFlag ? 'Tu bandera ha vuelto a la base' : 'Bandera enemiga devuelta',
    });
  }

  return basePresentation(event, 'OBJETIVO ACTUALIZADO', {
    detail: message,
    placement: 'both',
    tone: 'objective',
    cue: 'neutral',
    priority: 58,
    durationMs: 2400,
  });
};

const presentScore = (event: GameEvent, state: MatchState, localPlayerId: string): EventPresentation => {
  const local = state.players[localPlayerId];
  const actor = eventActor(event, state);
  const message = event.message ?? 'Marcador actualizado';
  const value = normalized(message);

  if (value.includes('coloso')) {
    const actorIsLocal = actor?.id === localPlayerId;
    const actorIsAlly = isAlly(actor, local, state);
    const friendlyActor = actorIsLocal || actorIsAlly;
    return basePresentation(
      event,
      actorIsLocal ? 'ERES EL COLOSO' : actorIsAlly ? `${actor?.name ?? 'ALIADO'} ES EL COLOSO` : 'EL ENEMIGO ES EL COLOSO',
      {
        detail: message,
        placement: 'both',
        tone: friendlyActor ? 'objective' : 'danger',
        cue: friendlyActor ? 'objective-positive' : 'objective-negative',
        priority: 89,
        durationMs: 3100,
        voice: actorIsLocal ? 'Eres el Coloso' : actorIsAlly ? 'Tu equipo controla al Coloso' : 'El enemigo es el Coloso',
      },
    );
  }

  const friendlyActor = actor?.id === localPlayerId || isAlly(actor, local, state);
  return basePresentation(event, friendlyActor ? 'PUNTO CONSEGUIDO' : 'MARCADOR ACTUALIZADO', {
    detail: message,
    placement: 'both',
    tone: friendlyActor ? 'success' : 'neutral',
    cue: friendlyActor ? 'objective-positive' : 'neutral',
    priority: 50,
    durationMs: 2200,
  });
};

const presentMatchEnd = (event: GameEvent, state: MatchState, localPlayerId: string): EventPresentation => {
  const local = state.players[localPlayerId];
  const localWon = isLocalWinner(state, local);
  const resultKnown = Boolean(local && state.winner);
  const headline = !resultKnown ? 'FIN DE PARTIDA' : localWon ? 'VICTORIA' : 'DERROTA';
  return basePresentation(event, headline, {
    detail: event.message ?? 'La simulación ha terminado',
    placement: 'center',
    tone: localWon ? 'success' : resultKnown ? 'danger' : 'neutral',
    cue: localWon ? 'match-positive' : resultKnown ? 'match-negative' : 'neutral',
    priority: 100,
    durationMs: 5200,
    voice: localWon ? 'Victoria' : resultKnown ? 'Derrota' : 'Fin de la partida',
  });
};

/** Converts a simulation event into a UI/announcer instruction from one player's perspective. */
export const presentGameEvent = (
  event: GameEvent,
  state: MatchState,
  localPlayerId: string,
): EventPresentation | null => {
  switch (event.type) {
    case 'kill':
      return presentKill(event, state, localPlayerId);
    case 'flag':
      return presentFlag(event, state, localPlayerId);
    case 'score':
      return presentScore(event, state, localPlayerId);
    case 'match-end':
      return presentMatchEnd(event, state, localPlayerId);
    default:
      return null;
  }
};

/** Presents unseen events in simulation order; useful for both host and interpolated guest state. */
export const presentGameEvents = (
  events: readonly GameEvent[],
  state: MatchState,
  localPlayerId: string,
  afterEventId = 0,
): EventPresentation[] => events
  .filter((event) => event.id > afterEventId)
  .map((event) => presentGameEvent(event, state, localPlayerId))
  .filter((presentation): presentation is EventPresentation => presentation !== null);

/**
 * Objective transitions should describe the newest known state. Match-ending
 * and capture announcements remain urgent enough to pre-empt routine chatter.
 */
export const selectAnnouncementCandidate = (
  presentations: readonly EventPresentation[],
): EventPresentation | null => {
  const voiced = presentations.filter((presentation) => presentation.voice);
  const urgent = voiced
    .filter((presentation) => presentation.priority >= 95)
    .sort((left, right) => right.priority - left.priority || right.eventId - left.eventId)[0];
  return urgent ?? voiced.sort((left, right) => right.eventId - left.eventId)[0] ?? null;
};
