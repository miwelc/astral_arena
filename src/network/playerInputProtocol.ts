import { PLAYER_PITCH_LIMIT, type PlayerInput } from '../game/types';

export const DIGITAL_INPUT_KEYS = [
  'fire',
  'aim',
  'jump',
  'reload',
  'swap',
  'melee',
  'grenade',
  'crouch',
  'use',
] as const satisfies readonly (keyof PlayerInput)[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict runtime boundary shared by host input and snapshot validation. */
export const isValidPlayerInput = (value: unknown): value is PlayerInput => {
  if (!isRecord(value)) return false;
  if (!(Number.isSafeInteger(value.sequence)
    && (value.sequence as number) >= 0
    && typeof value.moveX === 'number' && Number.isFinite(value.moveX) && Math.abs(value.moveX) <= 1
    && typeof value.moveZ === 'number' && Number.isFinite(value.moveZ) && Math.abs(value.moveZ) <= 1
    && typeof value.yaw === 'number' && Number.isFinite(value.yaw) && Math.abs(value.yaw) <= Math.PI + 0.001
    && typeof value.pitch === 'number' && Number.isFinite(value.pitch) && Math.abs(value.pitch) <= PLAYER_PITCH_LIMIT + 0.001
  )) return false;
  for (const key of DIGITAL_INPUT_KEYS) {
    if (typeof value[key] !== 'boolean') return false;
  }
  return true;
};
