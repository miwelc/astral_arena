import { describe, expect, it } from 'vitest';

import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { GameMode, MatchState, PlayerState, WeaponId } from '../game/types';
import { isValidMatchState } from './matchStateValidation';

const modes: GameMode[] = [
  'deathmatch',
  'team-deathmatch',
  'capture-the-flag',
  'juggernaut',
  'towah-of-powah',
];

const makeState = (mode: GameMode = 'team-deathmatch'): MatchState => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode, format: 'squads', botFill: true }),
    [{ id: 'local-player', name: 'Lince' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  simulation.step(1 / 60);
  return simulation.snapshot();
};

const copy = (state: MatchState): MatchState => structuredClone(state);

const firstPlayer = (state: MatchState): PlayerState => {
  const player = Object.values(state.players)[0];
  if (!player) throw new Error('Missing player fixture');
  return player;
};

describe('P2P MatchState validation', () => {
  it.each(modes)('accepts a JSON-round-tripped GameSimulation snapshot for %s', (mode) => {
    const state = makeState(mode);
    const overTheWire = JSON.parse(JSON.stringify(state)) as unknown;

    expect(isValidMatchState(state)).toBe(true);
    expect(isValidMatchState(overTheWire)).toBe(true);
  });

  it.each(modes)('keeps accepting authoritative %s snapshots during sustained play', (mode) => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode, format: 'squads', botFill: true }),
      [{ id: 'local-player', name: 'Lince' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;

    for (let tick = 0; tick < 20 * 60; tick += 1) {
      simulation.step(1 / 60);
      if (tick % 30 === 0) {
        const snapshot = simulation.snapshot();
        const angles = Object.values(snapshot.players).map((player) => ({
          id: player.id,
          yaw: player.yaw,
          pitch: player.pitch,
          inputYaw: player.input.yaw,
          inputPitch: player.input.pitch,
        }));
        expect(
          isValidMatchState(snapshot),
          `snapshot rejected at simulation tick ${tick}: ${JSON.stringify(angles)}`,
        ).toBe(true);
      }
    }
  });

  it('accepts legitimate projectile and current audiovisual event shapes', () => {
    const state = makeState('capture-the-flag');
    state.projectiles.push({
      id: 'projectile-fixture',
      kind: 'grenade',
      ownerId: 'local-player',
      team: state.players['local-player']?.team ?? 'aurora',
      position: { x: 1, y: 3, z: -2 },
      velocity: { x: 3, y: -4, z: 5 },
      radius: 0.16,
      damage: 120,
      blastRadius: 5.5,
      armed: true,
      fuse: -0.05,
      alive: true,
    });
    state.projectiles.push({
      id: 'bullet-fixture',
      kind: 'bullet',
      ownerId: 'local-player',
      team: state.players['local-player']?.team ?? 'aurora',
      weaponId: 'battle-rifle',
      position: { x: 0, y: 1.5, z: 0 },
      velocity: { x: 180, y: 0, z: 0 },
      radius: 0.025,
      damage: 9,
      blastRadius: 0,
      armed: true,
      fuse: 0.4,
      alive: true,
    });
    const startId = ++state.eventSequence;
    state.events.push({
      id: startId,
      time: state.elapsed,
      type: 'shield-recharge-start',
      targetId: 'local-player',
      position: { x: 1, y: 0, z: 2 },
    });
    state.events.push({
      id: ++state.eventSequence,
      time: state.elapsed,
      type: 'flag',
      actorId: 'local-player',
      actorTeam: state.players['local-player']?.team ?? 'aurora',
      flagTeam: 'nova',
      flagAction: 'taken',
      message: 'Lince tomó la bandera',
    });
    state.events.push({
      id: ++state.eventSequence,
      time: state.elapsed,
      type: 'hit',
      actorId: 'local-player',
      targetId: Object.keys(state.players).find((id) => id !== 'local-player'),
      weaponId: 'battle-rifle',
      position: { x: 2, y: 1.5, z: 3 },
      sourcePosition: { x: -2, y: 1.5, z: 3 },
      amount: 70,
      shieldDamage: 10,
      healthDamage: 60,
      headshot: true,
      fatal: true,
    });

    expect(isValidMatchState(state)).toBe(true);
  });

  it.each([
    ['null', null],
    ['array root', []],
    ['empty object', {}],
    ['primitive', 7],
  ])('rejects an invalid %s root', (_label, value) => {
    expect(isValidMatchState(value)).toBe(false);
  });

  it.each([
    ['version', (state: MatchState) => { (state as { version: number }).version = 2; }],
    ['map', (state: MatchState) => { (state.config as { mapId: string }).mapId = 'unknown-map'; }],
    ['mode', (state: MatchState) => { (state.config as { mode: string }).mode = 'racing'; }],
    ['format', (state: MatchState) => { (state.config as { format: string }).format = 'sixteen'; }],
    ['mode-incompatible format', (state: MatchState) => { state.config.format = 'duel'; }],
    ['phase', (state: MatchState) => { (state as { phase: string }).phase = 'paused'; }],
    ['missing tower', (state: MatchState) => { delete (state as Partial<MatchState>).tower; }],
    ['turret operator outside Towah', (state: MatchState) => { state.tower.turretOwnerId = firstPlayer(state).id; }],
  ])('rejects invalid top-level/config shape: %s', (_label, mutate) => {
    const state = copy(makeState());
    mutate(state);
    expect(isValidMatchState(state)).toBe(false);
  });

  it('rejects a roster larger than the selected mode allows', () => {
    const state = copy(makeState('team-deathmatch'));
    state.config.mode = 'deathmatch';
    state.config.format = 'duel';

    expect(Object.keys(state.players)).toHaveLength(8);
    expect(isValidMatchState(state)).toBe(false);
  });

  it.each([
    ['record/id mismatch', (state: MatchState) => { firstPlayer(state).id = 'different-id'; }],
    ['empty id', (state: MatchState) => { firstPlayer(state).id = ''; }],
    ['non-finite position', (state: MatchState) => { firstPlayer(state).position.x = Number.NaN; }],
    ['huge position', (state: MatchState) => { firstPlayer(state).position.z = Number.MAX_VALUE; }],
    ['missing input', (state: MatchState) => { delete (firstPlayer(state) as Partial<PlayerState>).input; }],
    ['invalid input number', (state: MatchState) => { firstPlayer(state).input.yaw = Number.POSITIVE_INFINITY; }],
    ['invalid use input', (state: MatchState) => { (firstPlayer(state).input as unknown as { use: string }).use = 'yes'; }],
    ['invalid weapon', (state: MatchState) => { firstPlayer(state).inventory[0]!.id = 'laser' as WeaponId; }],
    ['invalid weapon bloom', (state: MatchState) => { firstPlayer(state).inventory[0]!.bloom = 1.5; }],
    ['invalid burst counter', (state: MatchState) => { firstPlayer(state).inventory[0]!.burstRemaining = 99; }],
    ['invalid burst round index', (state: MatchState) => { firstPlayer(state).inventory[0]!.burstRoundIndex = 99; }],
    ['invalid aim suppression', (state: MatchState) => {
      (firstPlayer(state) as unknown as { aimSuppressed: string }).aimSuppressed = 'yes';
    }],
    ['invalid active weapon', (state: MatchState) => { firstPlayer(state).activeWeapon = 99; }],
    ['invalid bot memory', (state: MatchState) => {
      const bot = Object.values(state.players).find((player) => player.kind === 'bot');
      if (!bot?.bot) throw new Error('Missing bot fixture');
      bot.bot.lastSeenAt = Number.NEGATIVE_INFINITY;
    }],
    ['duplicate bot pickup blacklist', (state: MatchState) => {
      const bot = Object.values(state.players).find((player) => player.kind === 'bot');
      if (!bot?.bot) throw new Error('Missing bot fixture');
      bot.bot.pickupBlacklist = [
        { pickupId: 'pickup-grenade-west', retryAt: 12 },
        { pickupId: 'pickup-grenade-west', retryAt: 15 },
      ];
    }],
  ])('rejects invalid player state: %s', (_label, mutate) => {
    const state = copy(makeState());
    mutate(state);
    expect(isValidMatchState(state)).toBe(false);
  });

  it.each([
    ['projectiles shape', (state: MatchState) => { state.projectiles = {} as MatchState['projectiles']; }],
    ['pickups shape', (state: MatchState) => { state.pickups = null as unknown as MatchState['pickups']; }],
    ['pickup field', (state: MatchState) => { (state.pickups[0] as unknown as { available: string }).available = 'yes'; }],
    ['flags length', (state: MatchState) => { state.flags.pop(); }],
    ['duplicate flag team', (state: MatchState) => { state.flags[1]!.team = state.flags[0]!.team; }],
    ['events shape', (state: MatchState) => { state.events = {} as MatchState['events']; }],
    ['event type', (state: MatchState) => {
      const event = state.events[0];
      if (!event) throw new Error('Missing event fixture');
      (event as { type: string }).type = 'teleport';
    }],
    ['event id', (state: MatchState) => {
      const event = state.events[0];
      if (!event) throw new Error('Missing event fixture');
      event.id = Number.NaN;
    }],
    ['oversized shot traces', (state: MatchState) => {
      const event = state.events[0];
      if (!event) throw new Error('Missing event fixture');
      event.traces = Array.from({ length: 13 }, () => ({ x: 0, y: 0, z: 0 }));
    }],
    ['explosion metadata on a hit', (state: MatchState) => {
      const event = state.events[0];
      if (!event) throw new Error('Missing event fixture');
      event.explosionKind = 'grenade';
    }],
  ])('rejects malformed arrays/events: %s', (_label, mutate) => {
    const state = copy(makeState('juggernaut'));
    mutate(state);
    expect(isValidMatchState(state)).toBe(false);
  });

  it.each([
    ['tick', (state: MatchState) => { state.tick = Number.POSITIVE_INFINITY; }],
    ['elapsed', (state: MatchState) => { state.elapsed = Number.NaN; }],
    ['event sequence', (state: MatchState) => { state.eventSequence = Number.POSITIVE_INFINITY; }],
    ['team score', (state: MatchState) => { state.teamScores.aurora = Number.NaN; }],
    ['tower cooldown', (state: MatchState) => { state.tower.turretCooldown = Number.NEGATIVE_INFINITY; }],
    ['turret yaw', (state: MatchState) => { state.tower.turretYaw = Number.NaN; }],
    ['turret pitch', (state: MatchState) => { state.tower.turretPitch = 1.2; }],
  ])('rejects non-finite scalar values: %s', (_label, mutate) => {
    const state = copy(makeState());
    mutate(state);
    expect(isValidMatchState(state)).toBe(false);
  });

  it('rejects a turret operator that is absent from the roster', () => {
    const state = copy(makeState('towah-of-powah'));
    state.tower.turretOwnerId = 'missing-operator';

    expect(isValidMatchState(state)).toBe(false);
  });

  it('returns false rather than throwing for hostile property access', () => {
    const hostile = new Proxy({}, {
      get: () => { throw new Error('hostile getter'); },
    });
    expect(() => isValidMatchState(hostile)).not.toThrow();
    expect(isValidMatchState(hostile)).toBe(false);
  });
});
