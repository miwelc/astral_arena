import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hasLineOfSight, pointInsideObstacle } from './collision';
import { add, directionFromAngles, emptyInput, normalize, pitchTo, randomRange, vec3, yawTo } from './math';
import { sampleDirectionInCone } from './gunplay';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { PlayerState, ProjectileState, Vec3, WeaponId } from './types';
import { createWeaponState, WEAPONS } from './weapons';

const TEST_NOW = 1_700_001_100_000;

const simulationWith = (ids: readonly string[] = ['shooter', 'target']): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'deathmatch', botFill: false }),
    ids.map((id) => ({ id, name: id })),
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const requirePlayer = (simulation: GameSimulation, id: string): PlayerState => {
  const value = simulation.state.players[id];
  if (!value) throw new Error(`Missing player ${id}`);
  return value;
};

const clearCombatLine = (simulation: GameSimulation, separation = 8): { shooter: Vec3; target: Vec3 } => {
  const { map } = simulation;
  for (let z = map.bounds.minZ + 5; z <= map.bounds.maxZ - 5; z += 2) {
    for (let x = map.bounds.minX + 5; x <= map.bounds.maxX - separation - 5; x += 2) {
      const shooter = { x, y: map.bounds.floorY, z };
      const target = { x: x + separation, y: map.bounds.floorY, z };
      if (pointInsideObstacle(add(shooter, vec3(0, 0.9, 0)), map)) continue;
      if (pointInsideObstacle(add(target, vec3(0, 0.9, 0)), map)) continue;
      if (hasLineOfSight(add(shooter, vec3(0, 1.5, 0)), add(target, vec3(0, 1.55, 0)), map)) {
        return { shooter, target };
      }
    }
  }
  throw new Error('No clear combat line in map fixture');
};

const place = (player: PlayerState, position: Vec3): void => {
  player.position = { ...position };
  player.velocity = vec3();
  player.grounded = true;
  player.spawnProtection = 0;
};

const equip = (player: PlayerState, weaponId: WeaponId): void => {
  player.inventory = [createWeaponState(weaponId)];
  player.activeWeapon = 0;
  player.equipTimer = 0;
};

const aimAndFire = (
  simulation: GameSimulation,
  shooter: PlayerState,
  point: Vec3,
  sequence = 1,
): void => {
  const origin = add(shooter.position, vec3(0, 1.5, 0));
  simulation.setInput(shooter.id, {
    ...emptyInput(),
    sequence,
    yaw: yawTo(origin, point),
    pitch: pitchTo(origin, point),
    fire: true,
  });
  simulation.step(0);
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('Halo-style precision damage', () => {
  it('keeps headshot bonus off shields, then executes when damage reaches health', () => {
    const shieldedSimulation = simulationWith();
    const shieldedShooter = requirePlayer(shieldedSimulation, 'shooter');
    const shieldedTarget = requirePlayer(shieldedSimulation, 'target');
    const firstLine = clearCombatLine(shieldedSimulation);
    place(shieldedShooter, firstLine.shooter);
    place(shieldedTarget, firstLine.target);
    equip(shieldedShooter, 'sidearm');
    shieldedTarget.shield = 25;
    aimAndFire(
      shieldedSimulation,
      shieldedShooter,
      add(shieldedTarget.position, vec3(0, shieldedTarget.height * 0.86, 0)),
    );

    expect(shieldedTarget.shield).toBeCloseTo(1, 8);
    expect(shieldedTarget.health).toBe(70);
    expect(shieldedTarget.alive).toBe(true);
    expect(shieldedSimulation.state.events.find((event) => event.type === 'hit')).toMatchObject({
      headshot: true,
      shieldDamage: 24,
      healthDamage: 0,
      fatal: false,
    });

    const exposedSimulation = simulationWith();
    const exposedShooter = requirePlayer(exposedSimulation, 'shooter');
    const exposedTarget = requirePlayer(exposedSimulation, 'target');
    const secondLine = clearCombatLine(exposedSimulation);
    place(exposedShooter, secondLine.shooter);
    place(exposedTarget, secondLine.target);
    equip(exposedShooter, 'sidearm');
    exposedTarget.shield = 10;
    exposedTarget.input.aim = true;
    aimAndFire(
      exposedSimulation,
      exposedShooter,
      add(exposedTarget.position, vec3(0, exposedTarget.height * 0.86, 0)),
    );

    expect(exposedTarget.alive).toBe(false);
    expect(exposedTarget.aimSuppressed).toBe(true);
    expect(exposedSimulation.state.events.find((event) => event.type === 'hit')).toMatchObject({
      headshot: true,
      shieldDamage: 10,
      healthDamage: 70,
      fatal: true,
    });
    expect(exposedSimulation.state.events.find((event) => event.type === 'kill')).toMatchObject({
      weaponId: 'sidearm',
      headshot: true,
      fatal: true,
    });
  });

  it('does ordinary body damage and rearms smart-link only after aim is released', () => {
    const simulation = simulationWith();
    const shooter = requirePlayer(simulation, 'shooter');
    const target = requirePlayer(simulation, 'target');
    const line = clearCombatLine(simulation);
    place(shooter, line.shooter);
    place(target, line.target);
    equip(shooter, 'sidearm');
    target.shield = 0;
    target.input.aim = true;
    aimAndFire(simulation, shooter, add(target.position, vec3(0, 0.78, 0)));

    expect(target.health).toBe(70 - WEAPONS.sidearm.damage);
    expect(target.alive).toBe(true);
    expect(target.aimSuppressed).toBe(true);

    simulation.setInput(target.id, { ...emptyInput(), sequence: 1, aim: false });
    simulation.step(0);
    expect(target.aimSuppressed).toBe(false);
  });

  it('keeps fatal headshot feedback consistent for bonus-damage weapons', () => {
    const simulation = simulationWith();
    const shooter = requirePlayer(simulation, 'shooter');
    const target = requirePlayer(simulation, 'target');
    const line = clearCombatLine(simulation);
    place(shooter, line.shooter);
    place(target, line.target);
    equip(shooter, 'pulse-rifle');
    target.shield = 0;
    target.health = 10;

    aimAndFire(simulation, shooter, add(target.position, vec3(0, 1.7, 0)));

    expect(simulation.state.events.find((event) => event.type === 'kill')).toMatchObject({
      headshot: true,
      fatal: true,
      weaponId: 'pulse-rifle',
    });
  });
});

describe('weapon action cadence', () => {
  it('builds real automatic bloom under sustained fire and recovers when released', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    equip(shooter, 'pulse-rifle');
    const weapon = shooter.inventory[0]!;
    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 1, fire: true });
    simulation.step(0);
    const firstShotBloom = weapon.bloom;
    simulation.step(0.05);
    simulation.step(0.05);
    simulation.step(0.01);
    expect(weapon.bloom).toBeGreaterThan(firstShotBloom);

    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 2, fire: false });
    for (let index = 0; index < 10; index += 1) simulation.step(0.05);
    expect(weapon.bloom).toBe(0);
  });

  it('preserves automatic cadence remainder across 60 Hz tick boundaries', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    equip(shooter, 'pulse-rifle');
    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 1, fire: true });

    for (let tick = 0; tick < 60; tick += 1) simulation.step(1 / 60);

    const shots = simulation.state.events.filter(
      (event) => event.type === 'shot' && event.actorId === shooter.id && event.weaponId === 'pulse-rifle',
    );
    expect(shots).toHaveLength(10);
    expect(shooter.inventory[0]?.cooldown).toBeGreaterThanOrEqual(0);
  });

  it('emits the battle-rifle rounds over time and supports a partial final burst', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    equip(shooter, 'battle-rifle');
    const weapon = shooter.inventory[0]!;
    aimAndFire(simulation, shooter, add(shooter.position, vec3(8, 1.5, 0)));

    expect(weapon.magazine).toBe(35);
    expect(weapon.burstRemaining).toBe(2);
    expect(weapon.burstRoundIndex).toBe(1);
    expect(simulation.state.events.filter((event) => event.type === 'shot')).toHaveLength(1);
    simulation.step(0.05);
    expect(simulation.state.events.filter((event) => event.type === 'shot')).toHaveLength(1);
    simulation.step(0.02);
    expect(simulation.state.events.filter((event) => event.type === 'shot')).toHaveLength(2);
    simulation.step(0.05);
    simulation.step(0.02);
    expect(simulation.state.events.filter((event) => event.type === 'shot')).toHaveLength(3);
    expect(weapon.magazine).toBe(33);
    expect(weapon.burstRemaining).toBe(0);
    expect(weapon.burstRoundIndex).toBe(0);

    const partialSimulation = simulationWith(['shooter']);
    const partialShooter = requirePlayer(partialSimulation, 'shooter');
    equip(partialShooter, 'battle-rifle');
    const partialWeapon = partialShooter.inventory[0]!;
    partialWeapon.magazine = 2;
    const partialLine = clearCombatLine(partialSimulation);
    place(partialShooter, partialLine.shooter);
    aimAndFire(partialSimulation, partialShooter, add(partialLine.target, vec3(0, 1.5, 0)));
    expect(partialWeapon.burstRoundIndex).toBe(1);
    const expectedRandomState = { randomState: partialSimulation.state.randomState };
    const expectedSecondDirection = sampleDirectionInCone(
      directionFromAngles(partialShooter.yaw, partialShooter.pitch),
      WEAPONS['battle-rifle'].burstSpread?.[1] ?? 0,
      randomRange(expectedRandomState, 0, 1),
      randomRange(expectedRandomState, 0, 1),
    );
    partialSimulation.step(0.05);
    partialSimulation.step(0.02);
    expect(partialSimulation.state.events.filter((event) => event.type === 'shot')).toHaveLength(2);
    expect(partialWeapon.magazine).toBe(0);
    expect(partialWeapon.burstRoundIndex).toBe(0);
    expect(partialWeapon.reloadTimer).toBeGreaterThan(0);
    const secondRound = partialSimulation.state.projectiles.find((projectile) => projectile.id === 'projectile-1');
    expect(secondRound).toBeDefined();
    const actualSecondDirection = normalize(secondRound?.velocity ?? vec3());
    expect(actualSecondDirection.x).toBeCloseTo(expectedSecondDirection.x, 10);
    expect(actualSecondDirection.y).toBeCloseTo(expectedSecondDirection.y, 10);
    expect(actualSecondDirection.z).toBeCloseTo(expectedSecondDirection.z, 10);
  });

  it('gives battle-rifle rounds travel time instead of instant hitscan damage', () => {
    const simulation = simulationWith();
    const shooter = requirePlayer(simulation, 'shooter');
    const target = requirePlayer(simulation, 'target');
    const line = clearCombatLine(simulation);
    place(shooter, line.shooter);
    place(target, line.target);
    equip(shooter, 'battle-rifle');
    aimAndFire(simulation, shooter, add(target.position, vec3(0, 1.05, 0)));

    expect(target.shield).toBe(100);
    expect(simulation.state.projectiles.some((projectile) => projectile.kind === 'bullet')).toBe(true);
    simulation.step(0.02);
    expect(target.shield).toBe(100);
    simulation.step(0.03);
    expect(target.shield).toBeLessThan(100);
  });

  it('starts battle-rifle collision at the authoritative firing origin', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    equip(shooter, 'battle-rifle');
    const origin = add(shooter.position, vec3(0, 1.5, 0));

    aimAndFire(simulation, shooter, add(origin, vec3(8, 0, 0)));

    const bullet = simulation.state.projectiles.find((projectile) => projectile.kind === 'bullet');
    expect(bullet?.position).toEqual(origin);
  });

  it('loads the shotgun one shell at a time and allows firing to interrupt the loop', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    equip(shooter, 'shotgun');
    const weapon = shooter.inventory[0]!;
    weapon.magazine = 1;
    weapon.reserve = 3;
    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 1, reload: true });
    simulation.step(0);

    for (let index = 0; index < 14; index += 1) simulation.step(0.05);
    simulation.step(0.02);
    expect(weapon.magazine).toBe(2);
    expect(weapon.reserve).toBe(2);
    expect(weapon.reloadTimer).toBeCloseTo(WEAPONS.shotgun.reloadSeconds, 8);

    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 2, fire: true });
    simulation.step(0);
    expect(weapon.magazine).toBe(1);
    expect(weapon.reloadTimer).toBe(0);
    expect(simulation.state.events.some((event) => event.type === 'shot' && event.weaponId === 'shotgun')).toBe(true);
  });

  it('cancels holstered reloads and blocks a same-tick swap shot', () => {
    const simulation = simulationWith(['shooter']);
    const shooter = requirePlayer(simulation, 'shooter');
    const oldWeapon = shooter.inventory[0]!;
    const newWeapon = shooter.inventory[1]!;
    oldWeapon.magazine = 4;
    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 1, reload: true });
    simulation.step(0);
    expect(oldWeapon.reloadTimer).toBeGreaterThan(0);

    simulation.setInput(shooter.id, { ...emptyInput(), sequence: 2, swap: true, fire: true });
    simulation.step(0);
    expect(shooter.activeWeapon).toBe(1);
    expect(shooter.equipTimer).toBeGreaterThan(0);
    expect(oldWeapon.reloadTimer).toBe(0);
    expect(newWeapon.magazine).toBe(WEAPONS[newWeapon.id].magazineSize);
  });
});

describe('melee and survivability', () => {
  it('credits a recent damage contributor with an assist', () => {
    const simulation = simulationWith(['assistant', 'killer', 'target']);
    const assistant = requirePlayer(simulation, 'assistant');
    const killer = requirePlayer(simulation, 'killer');
    const target = requirePlayer(simulation, 'target');
    const line = clearCombatLine(simulation);
    place(assistant, line.shooter);
    place(killer, add(line.shooter, vec3(0, 0, 1)));
    place(target, line.target);
    equip(assistant, 'sniper');
    equip(killer, 'sniper');

    const bodyPoint = add(target.position, vec3(0, 0.82, 0));
    aimAndFire(simulation, assistant, bodyPoint, 1);
    expect(target.alive).toBe(true);
    expect(target.health).toBeLessThan(70);
    aimAndFire(simulation, killer, bodyPoint, 1);

    expect(target.alive).toBe(false);
    expect(killer.kills).toBe(1);
    expect(assistant.assists).toBe(1);
  });

  it('breaks a shield from the front and reserves instant kills for the back', () => {
    const frontSimulation = simulationWith(['attacker', 'target']);
    const frontAttacker = requirePlayer(frontSimulation, 'attacker');
    const frontTarget = requirePlayer(frontSimulation, 'target');
    place(frontTarget, { x: 0, y: 0, z: 17 });
    place(frontAttacker, { x: 0, y: 0, z: 15.3 });
    frontTarget.yaw = 0;
    frontSimulation.setInput(frontAttacker.id, { ...emptyInput(), sequence: 1, yaw: Math.PI, melee: true });
    frontSimulation.step(0);
    expect(frontTarget.alive).toBe(true);
    expect(frontTarget.shield).toBe(0);
    expect(frontTarget.health).toBe(70);
    expect(frontSimulation.state.events.find((event) => event.type === 'melee')?.backStrike).toBe(false);

    const rearSimulation = simulationWith(['attacker', 'target']);
    const rearAttacker = requirePlayer(rearSimulation, 'attacker');
    const rearTarget = requirePlayer(rearSimulation, 'target');
    place(rearTarget, { x: 0, y: 0, z: 17 });
    place(rearAttacker, { x: 0, y: 0, z: 18.7 });
    rearTarget.yaw = 0;
    rearSimulation.setInput(rearAttacker.id, { ...emptyInput(), sequence: 1, yaw: 0, melee: true });
    rearSimulation.step(0);
    expect(rearTarget.alive).toBe(false);
    expect(rearSimulation.state.events.find((event) => event.type === 'kill')).toMatchObject({
      backStrike: true,
      fatal: true,
    });
  });

  it('allows same-tick lethal melees to trade instead of favoring player order', () => {
    const simulation = simulationWith(['alpha', 'bravo']);
    const alpha = requirePlayer(simulation, 'alpha');
    const bravo = requirePlayer(simulation, 'bravo');
    place(alpha, { x: 0, y: 0, z: 15.3 });
    place(bravo, { x: 0, y: 0, z: 17 });
    alpha.shield = 0;
    bravo.shield = 0;
    simulation.setInput(alpha.id, { ...emptyInput(), sequence: 1, yaw: Math.PI, melee: true });
    simulation.setInput(bravo.id, { ...emptyInput(), sequence: 1, yaw: 0, melee: true });

    simulation.step(0);

    expect(alpha.alive).toBe(false);
    expect(bravo.alive).toBe(false);
    expect(alpha.kills).toBe(1);
    expect(bravo.kills).toBe(1);
  });

  it('does not let Juggernaut role-transfer protection cancel a committed melee trade', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'juggernaut', botFill: false }),
      [{ id: 'alpha', name: 'alpha' }, { id: 'bravo', name: 'bravo' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    const alpha = requirePlayer(simulation, 'alpha');
    const bravo = requirePlayer(simulation, 'bravo');
    for (const player of [alpha, bravo]) {
      player.isJuggernaut = false;
      player.maxShield = 100;
      player.shield = 0;
      player.spawnProtection = 0;
    }
    bravo.isJuggernaut = true;
    bravo.maxShield = 150;
    simulation.state.juggernautId = bravo.id;
    place(alpha, { x: 0, y: 0, z: 15.3 });
    place(bravo, { x: 0, y: 0, z: 17 });
    alpha.shield = 0;
    bravo.shield = 0;
    simulation.setInput(alpha.id, { ...emptyInput(), sequence: 1, yaw: Math.PI, melee: true });
    simulation.setInput(bravo.id, { ...emptyInput(), sequence: 1, yaw: 0, melee: true });

    simulation.step(0);

    expect(alpha.alive).toBe(false);
    expect(bravo.alive).toBe(false);
    expect(simulation.state.juggernautId).toBeNull();
  });

  it('regenerates hidden health after ten seconds without damage', () => {
    const simulation = simulationWith(['local']);
    const local = requirePlayer(simulation, 'local');
    local.health = 20;
    local.lastDamageAt = 0;
    simulation.state.elapsed = 9.94;
    simulation.step(0.05);
    expect(local.health).toBe(20);
    simulation.step(0.01);
    expect(local.health).toBeCloseTo(20.14, 8);
  });

  it('makes the core of a frag explosion lethal and publishes its profile', () => {
    const simulation = simulationWith(['owner', 'target']);
    const owner = requirePlayer(simulation, 'owner');
    const target = requirePlayer(simulation, 'target');
    place(owner, { x: -8, y: 0, z: 17 });
    place(target, { x: 0, y: 0, z: 17 });
    const projectile: ProjectileState = {
      id: 'lethal-frag',
      kind: 'grenade',
      ownerId: owner.id,
      team: owner.team,
      position: { x: target.position.x, y: simulation.map.bounds.floorY + 0.16, z: target.position.z },
      velocity: vec3(),
      radius: 0.16,
      damage: 210,
      blastRadius: 5.5,
      armed: true,
      fuse: 0,
      alive: true,
    };
    simulation.state.projectiles.push(projectile);
    simulation.step(0);

    expect(target.alive).toBe(false);
    expect(simulation.state.events.find((event) => event.type === 'explosion')).toMatchObject({
      explosionKind: 'grenade',
      radius: 5.5,
    });
  });
});
