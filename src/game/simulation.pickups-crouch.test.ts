import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyInput } from './math';
import {
  createDefaultConfig,
  DROPPED_PICKUP_LIFETIME_SECONDS,
  GameSimulation,
  MAX_PLAYER_GRENADES,
  PLAYER_MOVEMENT_TUNING,
} from './simulation';
import type { AabbObstacle, PlayerState, ProjectileState } from './types';
import { createWeaponState } from './weapons';

const TEST_NOW = 1_700_000_300_000;
const STEP = 0.05;

const createSimulation = (playerCount = 2, botFill = false): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode: 'deathmatch', playerCount, botFill }),
    [{ id: 'alpha', name: 'Alpha' }, { id: 'bravo', name: 'Bravo' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const player = (simulation: GameSimulation, id: string): PlayerState => {
  const result = simulation.state.players[id];
  if (!result) throw new Error(`Missing player ${id}`);
  return result;
};

const killWithRocket = (simulation: GameSimulation, attacker: PlayerState, victim: PlayerState): void => {
  victim.spawnProtection = 0;
  victim.shield = 0;
  victim.health = 70;
  const projectile: ProjectileState = {
    id: `test-rocket-${simulation.state.tick}`,
    kind: 'rocket',
    ownerId: attacker.id,
    team: attacker.team,
    weaponId: undefined,
    position: { x: victim.position.x, y: victim.position.y + 0.9, z: victim.position.z },
    velocity: { x: 0, y: 0, z: 0 },
    radius: 0.2,
    damage: 300,
    blastRadius: 5.5,
    armed: true,
    fuse: 0,
    alive: true,
  };
  simulation.state.projectiles.push(projectile);
  simulation.step(0.01);
  expect(victim.alive).toBe(false);
};

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW));
afterEach(() => vi.restoreAllMocks());

describe('equipment dropped on death', () => {
  it('drops the active weapon with exact remaining ammunition and all grenades', () => {
    const simulation = createSimulation();
    const attacker = player(simulation, 'alpha');
    const victim = player(simulation, 'bravo');
    attacker.position = { x: -20, y: 0, z: -20 };
    victim.position = { x: 20, y: 0, z: 20 };
    victim.inventory = [createWeaponState('sniper')];
    victim.activeWeapon = 0;
    victim.inventory[0]!.magazine = 3;
    victim.inventory[0]!.reserve = 7;
    victim.grenades = 2;

    killWithRocket(simulation, attacker, victim);

    const drops = simulation.state.pickups.filter((pickup) => pickup.temporary);
    expect(drops).toHaveLength(2);
    const weaponDrop = drops.find((pickup) => pickup.kind === 'weapon');
    expect(weaponDrop).toMatchObject({
      weaponId: 'sniper',
      weaponState: { id: 'sniper', magazine: 3, reserve: 7 },
      respawnTimer: 0,
    });
    expect(weaponDrop?.despawnTimer).toBeCloseTo(DROPPED_PICKUP_LIFETIME_SECONDS - 0.01, 6);
    expect(drops.find((pickup) => pickup.kind === 'grenade')).toMatchObject({
      amount: 2,
      temporary: true,
    });
    expect(victim.inventory[0]).toMatchObject({ magazine: 0, reserve: 0 });
    expect(victim.grenades).toBe(0);
  });

  it('requires E for a dropped weapon and equips its retained ammunition', () => {
    const simulation = createSimulation();
    const attacker = player(simulation, 'alpha');
    const victim = player(simulation, 'bravo');
    attacker.position = { x: -20, y: 0, z: -20 };
    victim.position = { x: 20, y: 0, z: 20 };
    victim.inventory = [createWeaponState('sniper')];
    victim.inventory[0]!.magazine = 2;
    victim.inventory[0]!.reserve = 5;
    victim.activeWeapon = 0;
    victim.grenades = 0;
    killWithRocket(simulation, attacker, victim);

    const drop = simulation.state.pickups.find((pickup) => pickup.temporary && pickup.kind === 'weapon');
    expect(drop).toBeDefined();
    attacker.position = { ...drop!.position };
    simulation.step(0);
    expect(drop?.available).toBe(true);
    expect(attacker.inventory.some((weapon) => weapon.id === 'sniper')).toBe(false);

    simulation.setInput(attacker.id, { ...emptyInput(), sequence: 1, use: true });
    simulation.step(0);

    expect(simulation.state.pickups.some((pickup) => pickup.id === drop?.id)).toBe(false);
    expect(attacker.inventory[attacker.activeWeapon]).toMatchObject({
      id: 'sniper',
      magazine: 2,
      reserve: 5,
    });
  });

  it('transfers all ammunition from an identical dropped weapon without magically reloading', () => {
    const simulation = createSimulation();
    const attacker = player(simulation, 'alpha');
    const victim = player(simulation, 'bravo');
    attacker.position = { x: -20, y: 0, z: -20 };
    victim.position = { x: 20, y: 0, z: 20 };
    attacker.inventory[0]!.magazine = 9;
    attacker.inventory[0]!.reserve = 0;
    victim.inventory[0]!.magazine = 3;
    victim.inventory[0]!.reserve = 7;
    victim.grenades = 0;
    killWithRocket(simulation, attacker, victim);
    const drop = simulation.state.pickups.find((pickup) => pickup.temporary && pickup.kind === 'weapon');
    attacker.position = { ...drop!.position };

    simulation.setInput(attacker.id, { ...emptyInput(), sequence: 1, use: true });
    simulation.step(0);

    expect(attacker.inventory[0]).toMatchObject({ magazine: 9, reserve: 10 });
    expect(simulation.state.pickups.some((pickup) => pickup.id === drop?.id)).toBe(false);
  });

  it('removes untouched death drops after the bounded lifetime', () => {
    const simulation = createSimulation();
    const attacker = player(simulation, 'alpha');
    const victim = player(simulation, 'bravo');
    attacker.position = { x: -20, y: 0, z: -20 };
    victim.position = { x: 20, y: 0, z: 20 };
    killWithRocket(simulation, attacker, victim);
    expect(simulation.state.pickups.some((pickup) => pickup.temporary)).toBe(true);

    for (let elapsed = 0; elapsed < DROPPED_PICKUP_LIFETIME_SECONDS + STEP; elapsed += STEP) {
      simulation.step(STEP);
    }

    expect(simulation.state.pickups.some((pickup) => pickup.temporary)).toBe(false);
  });
});

describe('grenade rack quantities', () => {
  it('grants a pair from a fixed rack while respecting the two-grenade cap', () => {
    for (const startingGrenades of [0, 1]) {
      const simulation = createSimulation();
      const local = player(simulation, 'alpha');
      const rack = simulation.state.pickups.find((pickup) => pickup.kind === 'grenade' && !pickup.temporary);
      expect(rack?.amount).toBe(2);
      local.grenades = startingGrenades;
      local.position = { ...rack!.position };

      simulation.step(0);

      expect(local.grenades).toBe(MAX_PLAYER_GRENADES);
      expect(rack?.available).toBe(false);
    }
  });

  it('leaves the unused grenade in a temporary death pile when capacity is one', () => {
    const simulation = createSimulation();
    const attacker = player(simulation, 'alpha');
    const victim = player(simulation, 'bravo');
    attacker.position = { x: -20, y: 0, z: -20 };
    victim.position = { x: 20, y: 0, z: 20 };
    victim.grenades = 2;
    killWithRocket(simulation, attacker, victim);
    const drop = simulation.state.pickups.find((pickup) => pickup.temporary && pickup.kind === 'grenade');
    expect(drop?.amount).toBe(2);

    attacker.grenades = 1;
    attacker.position = { ...drop!.position };
    simulation.step(0);

    expect(attacker.grenades).toBe(2);
    expect(simulation.state.pickups.find((pickup) => pickup.id === drop?.id)?.amount).toBe(1);
  });
});

describe('authoritative crouch movement', () => {
  it('uses a lower capsule and a deliberately slower crouch-walk speed', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'alpha');
    local.position = { x: 0, y: 6.05, z: 0 };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.setInput(local.id, {
      ...emptyInput(),
      sequence: 1,
      yaw: 0,
      moveZ: 1,
      crouch: true,
    });

    for (let index = 0; index < 20; index += 1) simulation.step(STEP);

    expect(local.crouched).toBe(true);
    expect(local.height).toBeCloseTo(1.22, 6);
    expect(Math.hypot(local.velocity.x, local.velocity.z)).toBeCloseTo(
      PLAYER_MOVEMENT_TUNING.moveSpeed * PLAYER_MOVEMENT_TUNING.crouchSpeedScale,
      5,
    );
  });

  it('does not stand into a low ceiling and stands as soon as headroom returns', () => {
    const simulation = createSimulation();
    const local = player(simulation, 'alpha');
    const feet = { ...local.position };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    const ceiling: AabbObstacle = {
      id: 'test-low-ceiling',
      min: { x: feet.x - 1, y: feet.y + 1.3, z: feet.z - 1 },
      max: { x: feet.x + 1, y: feet.y + 1.5, z: feet.z + 1 },
      kind: 'platform',
      color: 0xffffff,
    };
    simulation.map.obstacles.push(ceiling);
    try {
      simulation.setInput(local.id, { ...emptyInput(), sequence: 1, yaw: local.yaw, crouch: true });
      simulation.step(0);
      expect(local.crouched).toBe(true);
      expect(local.height).toBeCloseTo(1.22, 6);

      simulation.setInput(local.id, { ...emptyInput(), sequence: 2, yaw: local.yaw, crouch: false });
      simulation.step(0);
      expect(local.crouched).toBe(true);
      expect(local.height).toBeCloseTo(1.22, 6);

      simulation.map.obstacles.splice(simulation.map.obstacles.indexOf(ceiling), 1);
      simulation.step(0);
      expect(local.crouched).toBe(false);
      expect(local.height).toBeCloseTo(1.8, 6);
    } finally {
      const index = simulation.map.obstacles.indexOf(ceiling);
      if (index >= 0) simulation.map.obstacles.splice(index, 1);
    }
  });
});
