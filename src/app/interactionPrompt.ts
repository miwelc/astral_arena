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

  const pickup = state.pickups
    .filter((candidate) => {
      if (!canUseWeaponPickup(player, candidate) || !candidate.weaponId) return false;
      const existing = player.inventory.find((weapon) => weapon.id === candidate.weaponId);
      return !existing || existing.reserve < WEAPONS[existing.id].maxReserve;
    })
    .sort((left, right) => distanceSquared(player.position, left.position) - distanceSquared(player.position, right.position))[0];
  if (!pickup?.weaponId) return null;

  const definition = WEAPONS[pickup.weaponId];
  const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
  if (existing) {
    return {
      action: 'pickup-weapon',
      key: 'E',
      label: `REABASTECER ${definition.label.toUpperCase()}`,
      detail: `MUNICIÓN ${existing.reserve} / ${WEAPONS[existing.id].maxReserve}`,
    };
  }

  const replaced = player.inventory.length >= 2 ? player.inventory[player.activeWeapon] : undefined;
  return {
    action: 'pickup-weapon',
    key: 'E',
    label: `RECOGER ${definition.label.toUpperCase()}`,
    detail: replaced
      ? `SUSTITUYE ${WEAPONS[replaced.id].label.toUpperCase()}`
      : 'AÑADIR AL EQUIPO',
  };
};
