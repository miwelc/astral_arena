import { describe, expect, it } from 'vitest';

import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { MatchConfig, PlayerState, Vec3 } from '../game/types';
import { buildMotionRadarContacts } from './motionRadar';

const createState = (
  overrides: Partial<MatchConfig> = {},
  playerIds: readonly string[] = ['local', 'target'],
) => new GameSimulation(
  createDefaultConfig({ botFill: false, ...overrides }),
  playerIds.map((id) => ({ id, name: id })),
).state;

const player = (state: ReturnType<typeof createState>, id: string): PlayerState => {
  const value = state.players[id];
  if (!value) throw new Error(`Missing test player: ${id}`);
  return value;
};

const place = (value: PlayerState, position: Vec3, velocity: Vec3 = { x: 1, y: 0, z: 0 }): void => {
  value.position = { ...position };
  value.velocity = { ...velocity };
  value.alive = true;
};

describe('movement radar contact projection', () => {
  it('puts the local forward direction at the top of the radar', () => {
    const state = createState({ mode: 'deathmatch' });
    const local = player(state, 'local');
    const target = player(state, 'target');
    place(local, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    local.yaw = 0;
    place(target, { x: 0, y: 0, z: -12.5 });

    const [contact] = buildMotionRadarContacts(state, local.id);

    expect(contact).toBeDefined();
    expect(contact?.x).toBeCloseTo(0, 8);
    expect(contact?.y).toBeCloseTo(-0.5, 8);
    expect(contact?.distance).toBeCloseTo(12.5, 8);
    expect(contact?.normalizedDistance).toBeCloseTo(0.5, 8);
    expect(contact?.relation).toBe('enemy');
  });

  it('rotates contacts into view space as local yaw changes', () => {
    const state = createState({ mode: 'deathmatch' });
    const local = player(state, 'local');
    const target = player(state, 'target');
    place(local, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    local.yaw = -Math.PI / 2;

    place(target, { x: 10, y: 0, z: 0 });
    const [ahead] = buildMotionRadarContacts(state, local.id);
    expect(ahead?.x).toBeCloseTo(0, 8);
    expect(ahead?.y).toBeCloseTo(-0.4, 8);

    place(target, { x: 0, y: 0, z: 10 });
    const [right] = buildMotionRadarContacts(state, local.id);
    expect(right?.x).toBeCloseTo(0.4, 8);
    expect(right?.y).toBeCloseTo(0, 8);
  });

  it('classifies team contacts while keeping free-for-all contacts hostile', () => {
    const teamState = createState(
      { mode: 'team-deathmatch', format: 'squads' },
      ['local', 'enemy', 'ally'],
    );
    const local = player(teamState, 'local');
    place(local, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    place(player(teamState, 'enemy'), { x: 5, y: 0, z: 0 });
    place(player(teamState, 'ally'), { x: 10, y: 0, z: 0 });

    const relations = new Map(
      buildMotionRadarContacts(teamState, local.id).map((contact) => [contact.playerId, contact.relation]),
    );
    expect(relations.get('enemy')).toBe('enemy');
    expect(relations.get('ally')).toBe('ally');

    teamState.config.mode = 'deathmatch';
    expect(buildMotionRadarContacts(teamState, local.id).every((contact) => contact.relation === 'enemy')).toBe(true);
  });

  it('excludes self, dead, stationary and out-of-range players', () => {
    const state = createState(
      { mode: 'team-deathmatch', format: 'squads' },
      ['local', 'dead', 'still', 'far', 'moving'],
    );
    const local = player(state, 'local');
    place(local, { x: 0, y: 0, z: 0 }, { x: 20, y: 0, z: 0 });
    local.yaw = 0;
    place(player(state, 'dead'), { x: 2, y: 0, z: 0 });
    player(state, 'dead').alive = false;
    place(player(state, 'still'), { x: 4, y: 0, z: 0 }, { x: 0.54, y: 0, z: 0 });
    place(player(state, 'far'), { x: 25.01, y: 0, z: 0 });
    place(player(state, 'moving'), { x: 25, y: 0, z: 0 });

    const contacts = buildMotionRadarContacts(state, local.id);

    expect(contacts.map((contact) => contact.playerId)).toEqual(['moving']);
    expect(contacts[0]?.normalizedDistance).toBe(1);
    expect(contacts[0]?.x).toBe(1);
    expect(contacts[0]?.opacity).toBeCloseTo(0.42, 8);
  });

  it('briefly reveals a stationary player who fires', () => {
    const state = createState({ mode: 'deathmatch' });
    const local = player(state, 'local');
    const target = player(state, 'target');
    place(local, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    place(target, { x: 0, y: 0, z: -8 }, { x: 0, y: 0, z: 0 });
    state.elapsed = 5;
    state.events.push({ id: 1, time: 4.4, type: 'shot', actorId: target.id });

    expect(buildMotionRadarContacts(state, local.id)[0]).toMatchObject({
      playerId: target.id,
      revealedBy: 'fire',
    });
    state.elapsed = 5.3;
    expect(buildMotionRadarContacts(state, local.id)).toEqual([]);
  });

  it('marks vertical separation and can detect vertical-only movement', () => {
    const state = createState(
      { mode: 'team-deathmatch', format: 'squads' },
      ['local', 'above', 'below', 'level'],
    );
    const local = player(state, 'local');
    place(local, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 0 });
    place(player(state, 'above'), { x: 2, y: 5.5, z: 0 }, { x: 0, y: 0.8, z: 0 });
    place(player(state, 'below'), { x: 4, y: 0.5, z: 0 }, { x: 0, y: -0.8, z: 0 });
    place(player(state, 'level'), { x: 6, y: 5.3, z: 0 });

    const elevations = new Map(
      buildMotionRadarContacts(state, local.id).map((contact) => [contact.playerId, contact.elevation]),
    );

    expect(elevations.get('above')).toBe('above');
    expect(elevations.get('below')).toBe('below');
    expect(elevations.get('level')).toBe('level');
  });

  it('honours configurable radius and thresholds while sanitizing presentation values', () => {
    const state = createState({ mode: 'deathmatch' });
    const local = player(state, 'local');
    const target = player(state, 'target');
    place(local, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    local.yaw = 0;
    place(target, { x: 8, y: 1.1, z: 0 }, { x: 0.2, y: 0, z: 0 });

    const [contact] = buildMotionRadarContacts(state, local.id, {
      radius: 10,
      motionThreshold: 0.1,
      elevationThreshold: 1,
      minimumOpacity: -3,
    });

    expect(contact?.x).toBeCloseTo(0.8, 8);
    expect(contact?.elevation).toBe('above');
    expect(contact?.opacity).toBeCloseTo(0.2, 8);
    expect(Object.values(contact ?? {}).filter((value) => typeof value === 'number').every(Number.isFinite)).toBe(true);
  });
});
