import { describe, expect, it } from 'vitest';

import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { GameEvent, GameMode, MatchState } from '../game/types';
import { presentGameEvent, presentGameEvents, selectAnnouncementCandidate } from './eventPresentation';

const makeState = (mode: GameMode = 'capture-the-flag'): MatchState => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode, format: 'squads', botFill: false }),
    [
      { id: 'local', name: 'Lince' },
      { id: 'ally', name: 'Vega' },
      { id: 'enemy', name: 'Orion' },
      { id: 'enemy-two', name: 'Draco' },
    ],
  );
  simulation.state.players.local!.team = 'aurora';
  simulation.state.players.ally!.team = 'aurora';
  simulation.state.players.enemy!.team = 'nova';
  simulation.state.players['enemy-two']!.team = 'nova';
  return simulation.state;
};

const event = (id: number, type: GameEvent['type'], values: Partial<GameEvent> = {}): GameEvent => ({
  id,
  time: 4,
  type,
  ...values,
});

describe('combat event presentation', () => {
  it('makes a local kill prominent without spending an announcer voice line', () => {
    const state = makeState('team-deathmatch');
    const result = presentGameEvent(event(1, 'kill', {
      actorId: 'local',
      targetId: 'enemy',
      message: 'Lince eliminó a Orion',
    }), state, 'local');

    expect(result).toMatchObject({
      headline: 'ENEMIGO ABATIDO',
      detail: 'Orion',
      placement: 'both',
      tone: 'success',
      cue: 'kill-confirmed',
    });
    expect(result?.voice).toBeUndefined();
  });

  it('distinguishes the local death and a teammate death', () => {
    const state = makeState('team-deathmatch');
    const localDeath = presentGameEvent(event(2, 'kill', {
      actorId: 'enemy', targetId: 'local', message: 'Orion eliminó a Lince',
    }), state, 'local');
    const teammateDeath = presentGameEvent(event(3, 'kill', {
      actorId: 'enemy', targetId: 'ally', message: 'Orion eliminó a Vega',
    }), state, 'local');

    expect(localDeath).toMatchObject({ headline: 'HAS CAÍDO', cue: 'player-down', tone: 'danger' });
    expect(teammateDeath).toMatchObject({ headline: 'COMPAÑERO CAÍDO', cue: 'teammate-down', tone: 'danger' });
  });

  it('keeps unrelated free-for-all kills in the feed', () => {
    const state = makeState('deathmatch');
    const result = presentGameEvent(event(4, 'kill', {
      actorId: 'enemy', targetId: 'enemy-two', message: 'Orion eliminó a Draco',
    }), state, 'local');

    expect(result).toMatchObject({ placement: 'feed', tone: 'neutral', headline: 'BAJA EN COMBATE' });
  });
});

describe('objective event presentation', () => {
  it('announces local, allied and enemy flag pickups from their actor teams', () => {
    const state = makeState();
    const localPickup = presentGameEvent(event(10, 'flag', { actorId: 'local', message: 'Lince tomó la bandera' }), state, 'local');
    const allyPickup = presentGameEvent(event(11, 'flag', { actorId: 'ally', message: 'Vega tomó la bandera' }), state, 'local');
    const enemyPickup = presentGameEvent(event(12, 'flag', { actorId: 'enemy', message: 'Orion tomó la bandera' }), state, 'local');

    expect(localPickup).toMatchObject({ headline: 'TIENES LA BANDERA', voice: 'Bandera enemiga tomada' });
    expect(allyPickup).toMatchObject({ headline: 'TU EQUIPO TIENE LA BANDERA', tone: 'team' });
    expect(enemyPickup).toMatchObject({ headline: 'HAN ROBADO TU BANDERA', tone: 'danger' });
  });

  it('turns drops into different warnings depending on who was carrying', () => {
    const state = makeState();
    const friendlyDrop = presentGameEvent(event(13, 'flag', { actorId: 'ally', message: 'Vega soltó la bandera' }), state, 'local');
    const enemyDrop = presentGameEvent(event(14, 'flag', { actorId: 'enemy', message: 'Orion soltó la bandera' }), state, 'local');

    expect(friendlyDrop).toMatchObject({ headline: 'BANDERA ENEMIGA PERDIDA', voice: 'Bandera perdida' });
    expect(enemyDrop).toMatchObject({ headline: 'TU BANDERA ESTÁ EN EL SUELO', tone: 'danger' });
  });

  it('infers the actor from legacy capture and return messages without actorId', () => {
    const state = makeState();
    const capture = presentGameEvent(event(15, 'flag', { message: 'Lince capturó la bandera' }), state, 'local');
    const enemyReturn = presentGameEvent(event(16, 'flag', { message: 'Orion devolvió la bandera' }), state, 'local');

    expect(capture).toMatchObject({ headline: 'BANDERA CAPTURADA', priority: 96, voice: 'Bandera capturada' });
    expect(enemyReturn).toMatchObject({ headline: 'BANDERA ENEMIGA DEVUELTA', cue: 'objective-negative' });
  });

  it('uses the flag team in automatic return messages', () => {
    const state = makeState();
    const ownReturn = presentGameEvent(event(17, 'flag', { message: 'La bandera aurora volvió a base' }), state, 'local');
    const enemyReturn = presentGameEvent(event(18, 'flag', { message: 'La bandera nova volvió a base' }), state, 'local');

    expect(ownReturn).toMatchObject({ headline: 'TU BANDERA VOLVIÓ A BASE', tone: 'success' });
    expect(enemyReturn).toMatchObject({ headline: 'BANDERA ENEMIGA DEVUELTA', tone: 'objective' });
  });

  it('keeps CTF allegiance correct after an actor disconnects or shares a display name', () => {
    const state = makeState();
    state.players.ally!.name = state.players.enemy!.name;
    delete state.players.ally;
    const dropped = presentGameEvent(event(22, 'flag', {
      actorId: 'ally',
      actorTeam: 'aurora',
      flagTeam: 'nova',
      flagAction: 'dropped',
      message: 'Orion soltó la bandera',
    }), state, 'local');
    const ownReturn = presentGameEvent(event(23, 'flag', {
      flagTeam: 'aurora',
      flagAction: 'returned',
      message: 'La bandera volvió a base',
    }), state, 'local');

    expect(dropped).toMatchObject({ headline: 'BANDERA ENEMIGA PERDIDA', tone: 'objective' });
    expect(ownReturn).toMatchObject({ headline: 'BANDERA DEVUELTA', tone: 'success' });
  });

  it('announces Juggernaut ownership as an objective event', () => {
    const state = makeState('juggernaut');
    const result = presentGameEvent(event(19, 'score', {
      actorId: 'local', message: 'Lince es el Coloso',
    }), state, 'local');

    expect(result).toMatchObject({ headline: 'ERES EL COLOSO', voice: 'Eres el Coloso', priority: 89 });
  });
});

describe('match result and event collection', () => {
  it('presents team victory and defeat from the local perspective', () => {
    const state = makeState('team-deathmatch');
    state.winner = 'aurora';
    const won = presentGameEvent(event(20, 'match-end', { message: 'Victoria: Aurora' }), state, 'local');
    state.winner = 'nova';
    const lost = presentGameEvent(event(21, 'match-end', { message: 'Victoria: Nova' }), state, 'local');

    expect(won).toMatchObject({ headline: 'VICTORIA', voice: 'Victoria', priority: 100 });
    expect(lost).toMatchObject({ headline: 'DERROTA', voice: 'Derrota', priority: 100 });
  });

  it('filters old and non-presentational events while preserving simulation order', () => {
    const state = makeState('team-deathmatch');
    const presentations = presentGameEvents([
      event(1, 'kill', { actorId: 'local', targetId: 'enemy' }),
      event(2, 'shot', { actorId: 'local' }),
      event(3, 'kill', { actorId: 'enemy', targetId: 'ally' }),
      event(4, 'reload', { actorId: 'local' }),
    ], state, 'local', 1);

    expect(presentations.map((item) => item.eventId)).toEqual([3]);
  });

  it('announces the newest CTF transition instead of a stale, higher-priority pickup', () => {
    const state = makeState();
    const presentations = presentGameEvents([
      event(30, 'flag', {
        actorId: 'enemy', actorTeam: 'nova', flagTeam: 'aurora', flagAction: 'taken',
      }),
      event(31, 'flag', {
        actorId: 'enemy', actorTeam: 'nova', flagTeam: 'aurora', flagAction: 'dropped',
      }),
    ], state, 'local');

    expect(selectAnnouncementCandidate(presentations)).toMatchObject({
      eventId: 31,
      voice: 'Tu bandera ha caído',
    });
  });

  it('lets match-ending and capture announcements pre-empt routine objective chatter', () => {
    const state = makeState();
    state.winner = 'aurora';
    const presentations = presentGameEvents([
      event(40, 'match-end', { message: 'Victoria: Aurora' }),
      event(41, 'flag', {
        actorId: 'enemy', actorTeam: 'nova', flagTeam: 'aurora', flagAction: 'taken',
      }),
    ], state, 'local');

    expect(selectAnnouncementCandidate(presentations)).toMatchObject({
      eventId: 40,
      voice: 'Victoria',
    });
  });
});
