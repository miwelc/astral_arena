export const HIP_FIRE_FOV = 74;

/**
 * Converts the simulation's intentionally small recoil angle into a restrained
 * first-person pose impulse. Keeping this function monotonic means weapon
 * tuning remains the single source of truth for how heavy a shot feels.
 */
export const visualRecoilImpulse = (weaponRecoil: number): number =>
  Math.min(1.35, Math.max(0.12, weaponRecoil * 14));

/** Resolves an optical zoom step without manufacturing ADS for unscoped guns. */
export const opticalZoomFov = (
  zoomFov: readonly number[] | undefined,
  aiming: boolean,
  requestedStep: number,
): number => {
  if (!aiming || !zoomFov?.length) return HIP_FIRE_FOV;
  const step = Math.min(zoomFov.length - 1, Math.max(0, Math.trunc(requestedStep)));
  return zoomFov[step] ?? HIP_FIRE_FOV;
};

export interface HitVisualEvent {
  type: string;
  headshot?: boolean;
  fatal?: boolean;
  shieldDamage?: number;
  healthDamage?: number;
}

export interface HitVisualProfile {
  color: number;
  opacity: number;
  duration: number;
  endScale: number;
  fatalHeadshot: boolean;
}

/** Keeps shield, flesh and precision-kill feedback readable at a glance. */
export const hitVisualProfile = (event: HitVisualEvent): HitVisualProfile => {
  const fatalHeadshot = event.headshot === true && event.fatal === true;
  if (fatalHeadshot) {
    return {
      color: 0xffd5a1,
      opacity: 1,
      duration: 0.34,
      endScale: 2.65,
      fatalHeadshot: true,
    };
  }

  const healthHit = (event.healthDamage ?? 0) > 0;
  const shieldOnly = (event.shieldDamage ?? 0) > 0 && !healthHit;
  if (healthHit) {
    return {
      color: 0xff6257,
      opacity: 0.82,
      duration: 0.26,
      endScale: 2.05,
      fatalHeadshot: false,
    };
  }
  if (shieldOnly || event.type === 'shield-break') {
    return {
      color: 0x64ecff,
      opacity: event.type === 'shield-break' ? 0.9 : 0.72,
      duration: event.type === 'shield-break' ? 0.3 : 0.23,
      endScale: event.type === 'shield-break' ? 2.4 : 1.85,
      fatalHeadshot: false,
    };
  }

  return {
    color: 0xff806e,
    opacity: 0.74,
    duration: 0.24,
    endScale: 1.95,
    fatalHeadshot: false,
  };
};
