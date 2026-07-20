import { clamp } from '../game/math';
import type { GameEvent, Vec3 } from '../game/types';

export type CombatWarningTone = 'critical' | 'warning' | 'utility';

export interface CombatWarning {
  label: 'RECARGAR' | 'SIN MUNICIÓN' | 'POCAS BALAS' | 'SIN GRANADAS';
  tone: CombatWarningTone;
}

interface WarningWeaponState {
  magazine: number;
  reserve: number;
  reloadTimer: number;
}

/**
 * Chooses one terse warning for the space next to the reticle. Ammunition that
 * prevents firing outranks inventory information; an active reload suppresses
 * the otherwise misleading RECARGAR prompt.
 */
export const selectCombatWarning = (
  weapon: WarningWeaponState | null | undefined,
  magazineSize: number | null | undefined,
  grenades: number,
  grenadeAttempted = false,
): CombatWarning | null => {
  if (weapon && magazineSize && magazineSize > 0) {
    if (weapon.magazine <= 0 && weapon.reserve <= 0) {
      return { label: 'SIN MUNICIÓN', tone: 'critical' };
    }
    if (weapon.magazine <= 0 && weapon.reserve > 0 && weapon.reloadTimer <= 0) {
      return { label: 'RECARGAR', tone: 'critical' };
    }
    const lowMagazineThreshold = Math.max(1, Math.floor(magazineSize * 0.2));
    if (weapon.reloadTimer <= 0 && weapon.magazine <= lowMagazineThreshold) {
      return { label: 'POCAS BALAS', tone: 'warning' };
    }
  }
  return grenades <= 0 && grenadeAttempted ? { label: 'SIN GRANADAS', tone: 'utility' } : null;
};

interface DamagePresentationEvent {
  amount?: number;
  shieldDamage?: number;
  healthDamage?: number;
  sourcePosition?: Vec3;
}

interface DamagePresentationTarget {
  position: Vec3;
  yaw: number;
  maxShield: number;
}

export interface DirectionalDamagePresentation {
  angleDegrees: number;
  strength: number;
  tone: 'shield' | 'health';
}

/**
 * Finds the newest local hit in the not-yet-scanned suffix of an event log.
 * Match events are ordered by increasing id, so reaching the cursor lets the
 * HUD stop without revisiting older history on every animation frame.
 */
export const latestDamageEventAfter = (
  events: readonly GameEvent[],
  targetId: string,
  afterEventId: number,
): GameEvent | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.id <= afterEventId) break;
    if (event.type === 'hit' && event.targetId === targetId) return event;
  }
  return undefined;
};

/**
 * Converts an authoritative world-space damage source into a clockwise HUD
 * angle: 0° is ahead, 90° right and 180° behind the local player.
 */
export const directionalDamagePresentation = (
  event: DamagePresentationEvent,
  target: DamagePresentationTarget,
): DirectionalDamagePresentation => {
  const source = event.sourcePosition;
  let angleDegrees = 0;
  if (source) {
    const deltaX = source.x - target.position.x;
    const deltaZ = source.z - target.position.z;
    const forwardX = -Math.sin(target.yaw);
    const forwardZ = -Math.cos(target.yaw);
    const rightX = Math.cos(target.yaw);
    const rightZ = -Math.sin(target.yaw);
    const forwardAmount = deltaX * forwardX + deltaZ * forwardZ;
    const rightAmount = deltaX * rightX + deltaZ * rightZ;
    if (Math.abs(forwardAmount) + Math.abs(rightAmount) > 0.0001) {
      angleDegrees = Math.atan2(rightAmount, forwardAmount) * 180 / Math.PI;
    }
  }

  const explicitDamage = Math.max(0, event.shieldDamage ?? 0) + Math.max(0, event.healthDamage ?? 0);
  const totalDamage = explicitDamage > 0 ? explicitDamage : Math.max(0, event.amount ?? 0);
  const healthWasDamaged = (event.healthDamage ?? 0) > 0
    || (event.shieldDamage === undefined && target.maxShield <= 0);
  return {
    angleDegrees,
    strength: clamp(totalDamage / 95, 0.34, 1),
    tone: healthWasDamaged ? 'health' : 'shield',
  };
};
