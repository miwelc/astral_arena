import { distanceSquared } from '../game/math';
import { canUseTowerTurret, canUseWeaponPickup } from '../game/simulation';
import type { MatchState, PlayerState } from '../game/types';
import { WEAPONS } from '../game/weapons';

export interface InteractionPrompt {
  action: 'enter-turret' | 'exit-turret' | 'pickup-weapon';
  key: 'E';
  label: string;
  detail: string;
}

/** Chooses one actionable context prompt using the same predicates as simulation. */
export const interactionPromptFor = (
  state: MatchState,
  player: PlayerState,
): InteractionPrompt | null => {
  if (!player.alive || state.phase !== 'playing') return null;

  if (state.config.mode === 'towah-of-powah' && state.tower.turretOwnerId === player.id) {
    return {
      action: 'exit-turret',
      key: 'E',
      label: 'SALIR DE LA TORRETA',
      detail: 'EMPLAZAMIENTO M41',
    };
  }

  if (
    state.config.mode === 'towah-of-powah'
    && state.tower.turretOwnerId === null
    && canUseTowerTurret(player, state.tower)
  ) {
    return {
      action: 'enter-turret',
      key: 'E',
      label: 'USAR TORRETA M41',
      detail: 'CONTROL MANUAL · TORRE CENTRAL',
    };
  }

  // This runs from the HUD loop. A single minimum scan keeps the exact nearest
  // usable-pickup semantics without allocating and sorting a temporary list.
  let pickup: MatchState['pickups'][number] | undefined;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  for (const candidate of state.pickups) {
    if (!canUseWeaponPickup(player, candidate) || !candidate.weaponId) continue;
    const existing = player.inventory.find((weapon) => weapon.id === candidate.weaponId);
    if (existing) {
      const definition = WEAPONS[existing.id];
      const capacity = definition.maxReserve - existing.reserve;
      const offered = candidate.weaponState
        ? candidate.weaponState.magazine + candidate.weaponState.reserve
        : definition.magazineSize;
      if (capacity <= 0 || offered <= 0) continue;
    }
    const candidateDistanceSquared = distanceSquared(player.position, candidate.position);
    // `sort` is stable, so retaining the first candidate on a tie preserves the
    // previous selection order.
    if (candidateDistanceSquared < nearestDistanceSquared) {
      pickup = candidate;
      nearestDistanceSquared = candidateDistanceSquared;
    }
  }
  if (!pickup?.weaponId) return null;

  const definition = WEAPONS[pickup.weaponId];
  const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
  if (existing) {
    const offered = pickup.weaponState
      ? pickup.weaponState.magazine + pickup.weaponState.reserve
      : definition.magazineSize;
    return {
      action: 'pickup-weapon',
      key: 'E',
      label: `REABASTECER ${definition.label.toUpperCase()}`,
      detail: `${pickup.temporary ? 'ARMA CAÍDA' : 'MUNICIÓN'} · +${offered} PROYECTILES`,
    };
  }

  const replaced = player.inventory.length >= 2 ? player.inventory[player.activeWeapon] : undefined;
  return {
    action: 'pickup-weapon',
    key: 'E',
    label: `RECOGER ${definition.label.toUpperCase()}`,
    detail: replaced
      ? `${pickup.temporary ? `${pickup.weaponState?.magazine ?? 0} + ${pickup.weaponState?.reserve ?? 0} PROYECTILES · ` : ''}SUSTITUYE ${WEAPONS[replaced.id].label.toUpperCase()}`
      : 'AÑADIR AL EQUIPO',
  };
};
