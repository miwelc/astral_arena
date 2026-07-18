import { describe, expect, it } from 'vitest';

import { emptyInput } from './math';
import { createDefaultConfig, GameSimulation } from './simulation';
import { DEFAULT_LOADOUT, TOWER_LOADOUT, WEAPONS } from './weapons';

describe('arena weapon balance', () => {
  it('keeps the intended prototype body-shot and power-weapon breakpoints', () => {
    const totalDurability = 170;

    expect(Math.ceil(totalDurability / WEAPONS['pulse-rifle'].damage)).toBe(14);
    expect(Math.ceil(totalDurability / WEAPONS.sidearm.damage)).toBe(6);
    expect(Math.ceil(totalDurability / WEAPONS.sniper.damage)).toBe(2);
    expect(WEAPONS.sniper.damage * WEAPONS.sniper.headMultiplier).toBeGreaterThan(totalDurability);
    expect(WEAPONS.shotgun.damage * 10).toBeLessThan(totalDurability);
    expect(WEAPONS.shotgun.damage * 11).toBeGreaterThan(totalDurability);
    expect(WEAPONS['rocket-launcher'].damage).toBeGreaterThan(totalDurability);
  });

  it('uses symmetric starts and the special Towah loadout', () => {
    expect(DEFAULT_LOADOUT).toEqual(['pulse-rifle', 'sidearm']);
    expect(TOWER_LOADOUT).toEqual(['shotgun', 'sidearm']);

    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'towah-of-powah', format: 'duel', botFill: false }),
      [{ id: 'local', name: 'Local' }],
    );
    const local = simulation.state.players.local;
    expect(local?.maxShield).toBe(0);
    expect(local?.inventory.map((weapon) => weapon.id)).toEqual(TOWER_LOADOUT);
    expect(simulation.state.pickups.every((pickup) => pickup.kind !== 'overshield')).toBe(true);
    expect(simulation.state.pickups.filter((pickup) => pickup.kind === 'weapon').every((pickup) => pickup.weaponId === 'shotgun')).toBe(true);
  });
});

describe('tower access', () => {
  it('carries a grounded player from either grav pad onto the tower deck', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'towah-of-powah', format: 'duel', botFill: false }),
      [{ id: 'local', name: 'Local' }],
    );
    const local = simulation.state.players.local;
    if (!local) throw new Error('Missing local player');
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    local.position = { x: -9.6, y: 0, z: 0 };
    local.velocity = { x: 0, y: 0, z: 0 };
    local.grounded = true;
    simulation.setInput(local.id, { ...emptyInput(), yaw: -Math.PI / 2 });

    simulation.step(0.05);
    expect(local.position.y).toBeGreaterThan(5.85);
    expect(local.position.x).toBeGreaterThan(-7);

    for (let index = 0; index < 30; index += 1) simulation.step(0.05);
    expect(local.grounded).toBe(true);
    expect(local.position.y).toBeCloseTo(5.85, 4);
  });
});
