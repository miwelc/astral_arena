import { describe, expect, it } from 'vitest';

import { JUMP_PAD_ZONES } from './map';
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
  it('launches a grounded player from either grav pad in a visible arc onto the tower deck', () => {
    for (const pad of JUMP_PAD_ZONES) {
      const simulation = new GameSimulation(
        createDefaultConfig({ mode: 'towah-of-powah', format: 'duel', botFill: false }),
        [{ id: 'local', name: 'Local' }],
      );
      const local = simulation.state.players.local;
      if (!local) throw new Error('Missing local player');
      simulation.state.phase = 'playing';
      simulation.state.countdown = 0;
      local.position = { ...pad.center };
      local.velocity = { x: 0, y: 0, z: 0 };
      local.grounded = true;
      simulation.setInput(local.id, { ...emptyInput(), yaw: -Math.PI / 2 });

      const startX = Math.abs(local.position.x);
      simulation.step(0.05);
      expect(local.position.y).toBeGreaterThan(0);
      expect(local.position.y).toBeLessThan(2);
      expect(Math.abs(local.position.x)).toBeLessThan(startX);
      expect(local.grounded).toBe(false);

      let apex = local.position.y;
      let landedOnTower = false;
      for (let index = 0; index < 70; index += 1) {
        simulation.step(0.05);
        apex = Math.max(apex, local.position.y);
        if (local.grounded && local.position.y > 5.8) {
          landedOnTower = true;
          break;
        }
      }
      expect(apex).toBeGreaterThan(7);
      expect(landedOnTower).toBe(true);
      expect(local.position.y).toBeCloseTo(5.95, 4);
      expect(Math.abs(local.position.x)).toBeLessThan(8);
    }
  });
});
