import { describe, expect, it } from 'vitest';

import { TOWER_TURRET_LAYOUT } from '../game/map';
import { createDefaultConfig, GameSimulation } from '../game/simulation';
import { WEAPONS } from '../game/weapons';
import {
  HIP_FIRE_FOV,
  hitVisualProfile,
  opticalZoomFov,
  presentedTowerAim,
  visualRecoilImpulse,
} from './combatPresentation';

describe('combat presentation', () => {
  it('only changes FOV for weapons with an active optical zoom', () => {
    expect(opticalZoomFov(undefined, true, 0)).toBe(HIP_FIRE_FOV);
    expect(opticalZoomFov([53], false, 0)).toBe(HIP_FIRE_FOV);
    expect(opticalZoomFov([53], true, 0)).toBe(53);
    expect(opticalZoomFov([17.15, 8.62], true, 1)).toBe(8.62);
    expect(opticalZoomFov([17.15, 8.62], true, 99)).toBe(8.62);
  });

  it('preserves weapon recoil ordering instead of assigning one generic kick', () => {
    const automatic = visualRecoilImpulse(WEAPONS['pulse-rifle'].recoil);
    const sidearm = visualRecoilImpulse(WEAPONS.sidearm.recoil);
    const sniper = visualRecoilImpulse(WEAPONS.sniper.recoil);
    const rocket = visualRecoilImpulse(WEAPONS['rocket-launcher'].recoil);

    expect(automatic).toBeLessThan(sidearm);
    expect(sidearm).toBeLessThan(sniper);
    expect(sniper).toBeLessThan(rocket);
    expect(rocket).toBeLessThanOrEqual(1.35);
  });

  it('separates shield, health and fatal headshot responses', () => {
    const shield = hitVisualProfile({ type: 'hit', shieldDamage: 13, healthDamage: 0 });
    const health = hitVisualProfile({ type: 'hit', shieldDamage: 0, healthDamage: 13 });
    const headshot = hitVisualProfile({
      type: 'hit',
      headshot: true,
      fatal: true,
      shieldDamage: 0,
      healthDamage: 70,
    });

    expect(shield.color).not.toBe(health.color);
    expect(headshot.fatalHeadshot).toBe(true);
    expect(headshot.duration).toBeGreaterThan(health.duration);
    expect(headshot.endScale).toBeGreaterThan(health.endScale);
  });

  it('predicts the local turret operator aim while observers use host state', () => {
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'towah-of-powah', botFill: false }),
      [{ id: 'operator', name: 'Operator' }, { id: 'observer', name: 'Observer' }],
    );
    const operator = simulation.state.players.operator!;
    simulation.state.tower.turretOwnerId = operator.id;
    simulation.state.tower.turretYaw = -0.4;
    simulation.state.tower.turretPitch = 0.2;
    operator.yaw = 1.15;
    operator.pitch = -1.2;

    expect(presentedTowerAim(simulation.state, operator.id)).toEqual({
      yaw: operator.yaw,
      pitch: TOWER_TURRET_LAYOUT.minPitch,
    });
    expect(presentedTowerAim(simulation.state, 'observer')).toEqual({
      yaw: simulation.state.tower.turretYaw,
      pitch: simulation.state.tower.turretPitch,
    });
  });
});
