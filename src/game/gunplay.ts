import { add, clamp, dot, normalize, scale } from './math';
import type { Vec3, WeaponDefinition, WeaponState } from './types';

const cross = (left: Vec3, right: Vec3): Vec3 => ({
  x: left.y * right.z - left.z * right.y,
  y: left.z * right.x - left.x * right.z,
  z: left.x * right.y - left.y * right.x,
});

/** Returns the exact authoritative cone angle for a round and current bloom. */
export const shotSpread = (
  definition: WeaponDefinition,
  weapon: Pick<WeaponState, 'bloom'>,
  burstIndex = 0,
): number => {
  const authoredBurstSpread = definition.burstSpread?.[burstIndex];
  if (authoredBurstSpread !== undefined) return authoredBurstSpread;
  return definition.spread + (definition.maxSpread - definition.spread) * clamp(weapon.bloom, 0, 1);
};

/**
 * Uniformly samples a circular cone around `forward`. The old component-wise
 * jitter made a square pattern whose apparent size changed with aim direction.
 */
export const sampleDirectionInCone = (
  forwardValue: Vec3,
  halfAngle: number,
  radialRandom: number,
  angularRandom: number,
): Vec3 => {
  const forward = normalize(forwardValue);
  if (halfAngle <= 0) return forward;
  const reference = Math.abs(dot(forward, { x: 0, y: 1, z: 0 })) > 0.98
    ? { x: 1, y: 0, z: 0 }
    : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, reference));
  const up = normalize(cross(right, forward));
  const radius = Math.sqrt(clamp(radialRandom, 0, 1)) * Math.tan(halfAngle);
  const angle = clamp(angularRandom, 0, 1) * Math.PI * 2;
  return normalize(add(
    forward,
    add(scale(right, Math.cos(angle) * radius), scale(up, Math.sin(angle) * radius)),
  ));
};

export const damageScaleAtDistance = (definition: WeaponDefinition, hitDistance: number): number => {
  const start = definition.damageFalloffStart;
  const end = definition.damageFalloffEnd;
  if (start === undefined || end === undefined || end <= start || hitDistance <= start) return 1;
  const amount = clamp((hitDistance - start) / (end - start), 0, 1);
  return 1 + ((definition.minimumDamageScale ?? 0.25) - 1) * amount;
};
