import { describe, expect, it } from 'vitest';

import { emptyInput } from '../game/math';
import { createDefaultConfig, GameSimulation } from '../game/simulation';
import type { BotMemory, GameMode, MatchState, PlayerState, WeaponId } from '../game/types';
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

const firstBotMemory = (state: MatchState): BotMemory => {
  const bot = Object.values(state.players).find((player) => player.kind === 'bot');
  if (!bot?.bot) throw new Error('Missing bot fixture');
  return bot.bot;
};

describe('P2P MatchState validation', () => {
  it.each(modes)('accepts a JSON-round-tripped GameSimulation snapshot for %s', (mode) => {
    const state = makeState(mode);
    const overTheWire = JSON.parse(JSON.stringify(state)) as unknown;

    expect(isValidMatchState(state)).toBe(true);
    expect(isValidMatchState(overTheWire)).toBe(true);
  });

  it('keeps accepting legacy bot snapshots without motion-tracker memory', () => {
    const state = copy(makeState());
    const memory = firstBotMemory(state) as Partial<BotMemory>;
    delete memory.radarGlanceTimer;
    delete memory.radarContactId;
    delete memory.radarContactPosition;
    delete memory.radarContactAt;

    expect(isValidMatchState(state)).toBe(true);
  });

  it('accepts an Umbra Station snapshot with authored bot navigation memory', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'capture-the-flag', mapId: 'umbra-station', botFill: true }),
      [{ id: 'local-player', name: 'Lince' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    simulation.step(1 / 60);

    expect(isValidMatchState(simulation.snapshot())).toBe(true);
  });

  it('accepts an Extensión Titán snapshot with authored bot navigation memory', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'capture-the-flag', mapId: 'titan-expanse', botFill: true }),
      [{ id: 'local-player', name: 'Lince' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    simulation.step(1 / 60);

    const overTheWire = JSON.parse(JSON.stringify(simulation.snapshot())) as unknown;
    expect(isValidMatchState(overTheWire)).toBe(true);
  });

  it('keeps accepting legacy bot snapshots without authored navigation memory', () => {
    const state = copy(makeState());
    const memory = firstBotMemory(state) as Partial<BotMemory>;
    delete memory.navigationRoute;
    delete memory.navigationCursor;
    delete memory.navigationGoalIndex;

    expect(isValidMatchState(state)).toBe(true);
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
  }, 30_000);

  it('accepts a Towah snapshot with its operator physically mounted on the raised emplacement', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'towah-of-powah', botFill: false }),
      [{ id: 'operator', name: 'Operator' }, { id: 'rival', name: 'Rival' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    const operator = simulation.state.players.operator;
    if (!operator) throw new Error('Missing operator fixture');
    operator.position = { x: 5, y: simulation.state.tower.center.y, z: 0 };
    operator.velocity = { x: 0, y: 0, z: 0 };
    operator.grounded = true;
    simulation.setInput(operator.id, { ...emptyInput(), sequence: 1, use: true });

    simulation.step(0);

    const overTheWire = JSON.parse(JSON.stringify(simulation.snapshot())) as unknown;
    expect(simulation.state.tower.turretOwnerId).toBe(operator.id);
    expect(operator.position.y).toBeGreaterThan(simulation.state.tower.center.y + 3);
    expect(isValidMatchState(overTheWire)).toBe(true);
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
    state.pickups.push({
      id: 'drop-fixture',
      kind: 'weapon',
      weaponId: 'sniper',
      weaponState: {
        id: 'sniper',
        magazine: 2,
        reserve: 5,
        cooldown: 0,
        reloadTimer: 0,
        bloom: 0,
        burstRemaining: 0,
        burstRoundIndex: 0,
        burstTimer: 0,
      },
      amount: 1,
      temporary: true,
      despawnTimer: 12,
      available: true,
      respawnTimer: 0,
      respawnSeconds: 20,
      position: { x: 3, y: 0.3, z: 4 },
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
    ['player count', (state: MatchState) => { state.config.playerCount = 9; }],
    ['noncanonical team player count', (state: MatchState) => { state.config.playerCount = 5; }],
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
    state.config.playerCount = 2;

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
    ['invalid crouch input', (state: MatchState) => { (firstPlayer(state).input as unknown as { crouch: string }).crouch = 'yes'; }],
    ['missing movement memory', (state: MatchState) => {
      delete (firstPlayer(state) as Partial<PlayerState>).movementMemory;
    }],
    ['invalid jump-pad cooldown', (state: MatchState) => {
      firstPlayer(state).movementMemory.jumpPadReadyAt = -1;
    }],
    ['invalid jump-pad momentum', (state: MatchState) => {
      firstPlayer(state).movementMemory.jumpPadMomentum = {
        direction: { x: Number.NaN, y: 0, z: 0 },
        minimumSpeed: 4,
      };
    }],
    ['invalid weapon', (state: MatchState) => { firstPlayer(state).inventory[0]!.id = 'laser' as WeaponId; }],
    ['invalid weapon bloom', (state: MatchState) => { firstPlayer(state).inventory[0]!.bloom = 1.5; }],
    ['invalid burst counter', (state: MatchState) => { firstPlayer(state).inventory[0]!.burstRemaining = 99; }],
    ['invalid burst round index', (state: MatchState) => { firstPlayer(state).inventory[0]!.burstRoundIndex = 99; }],
    ['invalid aim suppression', (state: MatchState) => {
      (firstPlayer(state) as unknown as { aimSuppressed: string }).aimSuppressed = 'yes';
    }],
    ['inconsistent crouch height', (state: MatchState) => {
      firstPlayer(state).crouched = true;
    }],
    ['invalid active weapon', (state: MatchState) => { firstPlayer(state).activeWeapon = 99; }],
    ['invalid bot memory', (state: MatchState) => {
      firstBotMemory(state).lastSeenAt = Number.NEGATIVE_INFINITY;
    }],
    ['invalid bot radar timer', (state: MatchState) => {
      firstBotMemory(state).radarGlanceTimer = Number.NaN;
    }],
    ['invalid bot radar contact id', (state: MatchState) => {
      firstBotMemory(state).radarContactId = ' bad-id ';
    }],
    ['invalid bot radar contact position', (state: MatchState) => {
      firstBotMemory(state).radarContactPosition = { x: Number.POSITIVE_INFINITY, y: 0, z: 0 };
    }],
    ['invalid bot radar contact time', (state: MatchState) => {
      firstBotMemory(state).radarContactAt = Number.NEGATIVE_INFINITY;
    }],
    ['invalid bot navigation node', (state: MatchState) => {
      firstBotMemory(state).navigationRoute = [0, 512];
    }],
    ['bot navigation cursor past route', (state: MatchState) => {
      const memory = firstBotMemory(state);
      memory.navigationRoute = [0, 1];
      memory.navigationCursor = memory.navigationRoute.length;
    }],
    ['incomplete bot navigation memory', (state: MatchState) => {
      delete (firstBotMemory(state) as Partial<BotMemory>).navigationGoalIndex;
    }],
    ['duplicate bot pickup blacklist', (state: MatchState) => {
      firstBotMemory(state).pickupBlacklist = [
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
    ['pickup amount', (state: MatchState) => { state.pickups[0]!.amount = 0; }],
    ['pickup weapon mismatch', (state: MatchState) => {
      const pickup = state.pickups.find((candidate) => candidate.kind === 'weapon');
      if (!pickup) throw new Error('Missing weapon pickup fixture');
      pickup.weaponState = { ...firstPlayer(state).inventory[0]!, id: 'sidearm' };
    }],
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
