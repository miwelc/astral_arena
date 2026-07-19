export interface TextureRepeat {
  x: number;
  y: number;
}

export interface SurfaceUvTransform {
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
}

export interface SurfaceTint {
  r: number;
  g: number;
  b: number;
}

export interface ExplosionVisualProfile {
  coreScale: number;
  coreOpacity: number;
  fireballScale: number;
  fireballOpacity: number;
  shockScale: number;
  shockOpacity: number;
  smokeScale: number;
  smokeOpacity: number;
  sparkOpacity: number;
  lightIntensity: number;
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const saturate = (value: number): number => clamp(value, 0, 1);

const smoothstep = (value: number): number => {
  const clamped = saturate(value);
  return clamped * clamped * (3 - 2 * clamped);
};

const rangeStep = (start: number, end: number, value: number): number =>
  smoothstep((value - start) / Math.max(0.0001, end - start));

const easeOutCubic = (value: number): number => 1 - Math.pow(1 - saturate(value), 3);

const hashUnit = (seed: number): number => {
  let state = Math.trunc(seed) >>> 0;
  state = Math.imul(state ^ (state >>> 16), 0x21f0aaad);
  state = Math.imul(state ^ (state >>> 15), 0x735a2d97);
  return ((state ^ (state >>> 15)) >>> 0) / 4294967296;
};

/** Keeps procedural floor details at a believable world scale on every arena size. */
export const computeGroundTextureRepeat = (
  width: number,
  depth: number,
  tileWorldSize = 16,
): TextureRepeat => ({
  x: clamp(Math.abs(width) / Math.max(4, tileWorldSize), 3.5, 9),
  y: clamp(Math.abs(depth) / Math.max(4, tileWorldSize), 3.5, 9),
});

/**
 * Counteracts the shared ground texture transform on individual earthworks.
 * The resulting UV density follows object size, while deterministic offsets
 * ensure neighbouring planters do not expose the same roots and stones.
 */
export const computeSurfaceUvTransform = (
  width: number,
  depth: number,
  sharedRepeat: TextureRepeat,
  seed: number,
  tileWorldSize = 13.5,
): SurfaceUvTransform => {
  const safeTileSize = Math.max(2, tileWorldSize);
  const desiredU = clamp(Math.abs(width) / safeTileSize, 0.68, 3.8);
  const desiredV = clamp(Math.abs(depth) / safeTileSize, 0.68, 3.8);
  const variationU = 0.9 + hashUnit(seed ^ 0x4c11db7) * 0.2;
  const variationV = 0.9 + hashUnit(seed ^ 0x9e3779b9) * 0.2;
  return {
    scaleU: desiredU * variationU / Math.max(0.01, Math.abs(sharedRepeat.x)),
    scaleV: desiredV * variationV / Math.max(0.01, Math.abs(sharedRepeat.y)),
    offsetU: hashUnit(seed ^ 0x68bc21eb),
    offsetV: hashUnit(seed ^ 0x2c1b3c6d),
  };
};

/** Broad, non-tile-aligned colour variation layered over repeated PBR maps. */
export const evaluateSurfaceTint = (x: number, z: number, seed: number): SurfaceTint => {
  const phase = hashUnit(seed) * Math.PI * 2;
  const broad = Math.sin(x * 0.083 + z * 0.047 + phase) * 0.5
    + Math.cos(z * 0.071 - x * 0.029 + phase * 1.7) * 0.5;
  const medium = Math.sin(x * 0.19 - z * 0.14 + phase * 0.63);
  const value = clamp(0.985 + broad * 0.045 + medium * 0.018, 0.9, 1.08);
  return {
    r: clamp(value * 0.99, 0.88, 1.08),
    g: clamp(value * 1.015, 0.88, 1.1),
    b: clamp(value * 0.965, 0.86, 1.06),
  };
};

/** Time profile for a bright initial detonation followed by fire, smoke and debris. */
export const evaluateExplosionVisual = (progress: number): ExplosionVisualProfile => {
  const value = saturate(progress);
  const flash = 1 - rangeStep(0.02, 0.2, value);
  const fireFade = 1 - rangeStep(0.1, 0.48, value);
  const smokeRise = rangeStep(0.06, 0.22, value);
  const smokeFade = 1 - rangeStep(0.68, 1, value);
  return {
    coreScale: 0.42 + easeOutCubic(value / 0.3) * 2.9,
    coreOpacity: (1 - rangeStep(0.06, 0.34, value)) * 0.98,
    fireballScale: 0.52 + easeOutCubic(value / 0.48) * 3.65,
    fireballOpacity: fireFade * 0.68,
    shockScale: 0.5 + easeOutCubic(value / 0.68) * 8.4,
    shockOpacity: (1 - rangeStep(0.05, 0.62, value)) * 0.72,
    smokeScale: 0.38 + easeOutCubic(value) * 4.6,
    smokeOpacity: smokeRise * smokeFade * 0.36,
    sparkOpacity: (1 - rangeStep(0.16, 0.82, value)) * 0.96,
    lightIntensity: flash * 54 + fireFade * 13,
  };
};
