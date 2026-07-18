import * as THREE from 'three';

export const VISUAL_SUN_DIRECTION = new THREE.Vector3(-0.52, 0.64, -0.56).normalize();

const TWO_PI = Math.PI * 2;

const createCanvas = (width: number, height: number): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

const getContext = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('No se pudo crear el contexto 2D para las texturas visuales.');
  return context;
};

const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const smoothstep = (value: number): number => value * value * (3 - 2 * value);

const latticeHash = (x: number, y: number, seed: number): number => {
  let value = Math.imul(x + seed, 0x27d4eb2d) ^ Math.imul(y - seed, 0x165667b1);
  value = Math.imul(value ^ (value >>> 15), 0x85ebca6b);
  return ((value ^ (value >>> 13)) >>> 0) / 4294967295;
};

/** Periodic value noise, so the generated ground can repeat without hard seams. */
const tiledNoise = (x: number, y: number, period: number, seed: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothstep(x - x0);
  const ty = smoothstep(y - y0);
  const wrap = (value: number): number => ((value % period) + period) % period;
  const left = wrap(x0);
  const right = wrap(x0 + 1);
  const top = wrap(y0);
  const bottom = wrap(y0 + 1);

  const topValue = THREE.MathUtils.lerp(
    latticeHash(left, top, seed),
    latticeHash(right, top, seed),
    tx,
  );
  const bottomValue = THREE.MathUtils.lerp(
    latticeHash(left, bottom, seed),
    latticeHash(right, bottom, seed),
    tx,
  );
  return THREE.MathUtils.lerp(topValue, bottomValue, ty);
};

/**
 * Equirectangular, cold daylight environment which shares the renderer's sun
 * direction. It is intended as PMREM input, not as a replacement for the sky.
 */
export const createColdEnvironmentTexture = (width = 1024, height = 512): THREE.CanvasTexture => {
  const safeWidth = Math.max(64, Math.round(width));
  const safeHeight = Math.max(32, Math.round(height));
  const canvas = createCanvas(safeWidth, safeHeight);
  const context = getContext(canvas);

  const sky = context.createLinearGradient(0, 0, 0, safeHeight);
  sky.addColorStop(0, '#08172f');
  sky.addColorStop(0.25, '#17385b');
  sky.addColorStop(0.47, '#547e99');
  sky.addColorStop(0.56, '#9cc7cb');
  sky.addColorStop(0.66, '#668e91');
  sky.addColorStop(1, '#101c27');
  context.fillStyle = sky;
  context.fillRect(0, 0, safeWidth, safeHeight);

  const horizon = context.createLinearGradient(0, safeHeight * 0.43, 0, safeHeight * 0.69);
  horizon.addColorStop(0, 'rgba(151, 204, 215, 0)');
  horizon.addColorStop(0.48, 'rgba(195, 228, 220, 0.2)');
  horizon.addColorStop(1, 'rgba(102, 151, 159, 0)');
  context.fillStyle = horizon;
  context.fillRect(0, safeHeight * 0.43, safeWidth, safeHeight * 0.26);

  // Three.js equirectangular lookup uses longitude around Y and latitude for V.
  const sunU = Math.atan2(VISUAL_SUN_DIRECTION.z, VISUAL_SUN_DIRECTION.x) / TWO_PI + 0.5;
  const sunV = Math.asin(THREE.MathUtils.clamp(VISUAL_SUN_DIRECTION.y, -1, 1)) / Math.PI + 0.5;
  const sunX = sunU * safeWidth;
  const sunY = (1 - sunV) * safeHeight;
  const haloRadius = safeHeight * 0.19;

  const drawSunAt = (x: number): void => {
    const halo = context.createRadialGradient(x, sunY, 0, x, sunY, haloRadius);
    halo.addColorStop(0, 'rgba(255, 246, 218, 0.95)');
    halo.addColorStop(0.08, 'rgba(255, 235, 195, 0.62)');
    halo.addColorStop(0.32, 'rgba(181, 219, 215, 0.22)');
    halo.addColorStop(1, 'rgba(126, 183, 196, 0)');
    context.fillStyle = halo;
    context.fillRect(x - haloRadius, sunY - haloRadius, haloRadius * 2, haloRadius * 2);

    const diskRadius = Math.max(2, safeHeight * 0.0125);
    const disk = context.createRadialGradient(x, sunY, 0, x, sunY, diskRadius);
    disk.addColorStop(0, 'rgba(255, 255, 239, 1)');
    disk.addColorStop(0.68, 'rgba(255, 242, 204, 0.98)');
    disk.addColorStop(1, 'rgba(255, 231, 190, 0)');
    context.fillStyle = disk;
    context.beginPath();
    context.arc(x, sunY, diskRadius, 0, TWO_PI);
    context.fill();
  };

  // Repeated copies preserve the light if a future sun direction reaches the seam.
  drawSunAt(sunX);
  drawSunAt(sunX - safeWidth);
  drawSunAt(sunX + safeWidth);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'cold-equirectangular-environment';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
};

/** Creates a deterministic, tileable mineral/industrial ground albedo. */
export const createStylizedGroundTexture = (size = 512): THREE.CanvasTexture => {
  const safeSize = Math.max(64, Math.round(size));
  const canvas = createCanvas(safeSize, safeSize);
  const context = getContext(canvas);
  const image = context.createImageData(safeSize, safeSize);

  for (let y = 0; y < safeSize; y += 1) {
    const v = y / safeSize;
    for (let x = 0; x < safeSize; x += 1) {
      const u = x / safeSize;
      const macro =
        tiledNoise(u * 4, v * 4, 4, 0x11a7) * 0.56 +
        tiledNoise(u * 9, v * 9, 9, 0x519d) * 0.3 +
        tiledNoise(u * 27, v * 27, 27, 0x7c31) * 0.14;
      const fine = tiledNoise(u * 73, v * 73, 73, 0x4f2b) - 0.5;
      const mineralBand = Math.sin((u * 2 + v) * TWO_PI) * 0.5 + 0.5;
      const variation = (macro - 0.5) * 25 + fine * 8 + (mineralBand - 0.5) * 4;
      const offset = (y * safeSize + x) * 4;

      image.data[offset] = THREE.MathUtils.clamp(61 + variation * 0.72, 0, 255);
      image.data[offset + 1] = THREE.MathUtils.clamp(91 + variation, 0, 255);
      image.data[offset + 2] = THREE.MathUtils.clamp(96 + variation * 1.06, 0, 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);

  // Broad panel seams read at gameplay distance but stay subordinate to geometry.
  const panelStep = safeSize / 4;
  context.lineWidth = Math.max(0.75, safeSize / 420);
  context.strokeStyle = 'rgba(12, 35, 42, 0.2)';
  context.beginPath();
  for (let index = 0; index < 4; index += 1) {
    const coordinate = index * panelStep + 0.5;
    context.moveTo(coordinate, 0);
    context.lineTo(coordinate, safeSize);
    context.moveTo(0, coordinate);
    context.lineTo(safeSize, coordinate);
  }
  context.stroke();

  context.strokeStyle = 'rgba(174, 214, 207, 0.08)';
  context.lineWidth = Math.max(0.5, safeSize / 700);
  context.beginPath();
  for (let index = 0; index < 4; index += 1) {
    const coordinate = index * panelStep + 2;
    context.moveTo(coordinate, 0);
    context.lineTo(coordinate, safeSize);
    context.moveTo(0, coordinate);
    context.lineTo(safeSize, coordinate);
  }
  context.stroke();

  const random = seededRandom(0xc01d5eed);
  const crackCount = Math.max(10, Math.round(safeSize / 28));
  for (let crack = 0; crack < crackCount; crack += 1) {
    let currentX = random() * safeSize;
    let currentY = random() * safeSize;
    let angle = random() * TWO_PI;
    const segments = 3 + Math.floor(random() * 5);
    const points: Array<[number, number]> = [[currentX, currentY]];
    for (let segment = 0; segment < segments; segment += 1) {
      angle += (random() - 0.5) * 0.9;
      const length = safeSize * (0.008 + random() * 0.018);
      currentX += Math.cos(angle) * length;
      currentY += Math.sin(angle) * length;
      points.push([currentX, currentY]);
    }
    context.lineWidth = Math.max(0.45, safeSize * (0.0007 + random() * 0.0011));
    context.strokeStyle = `rgba(8, 29, 35, ${0.14 + random() * 0.14})`;
    // Draw translated copies so cracks crossing an edge continue after wrapping.
    for (const offsetY of [-safeSize, 0, safeSize]) {
      for (const offsetX of [-safeSize, 0, safeSize]) {
        const first = points[0]!;
        context.beginPath();
        context.moveTo(first[0] + offsetX, first[1] + offsetY);
        for (let index = 1; index < points.length; index += 1) {
          const point = points[index]!;
          context.lineTo(point[0] + offsetX, point[1] + offsetY);
        }
        context.stroke();
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'stylized-ground-albedo';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
};

export interface ForestGroundTextures {
  albedo: THREE.CanvasTexture;
  normal: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

/**
 * Deterministic, tileable forest-floor PBR set. The material deliberately
 * avoids baked directional light so it remains convincing under the arena's
 * moving camera and real sun/shadow setup.
 */
export const createForestGroundTextures = (size = 512): ForestGroundTextures => {
  const safeSize = Math.max(128, Math.round(size));
  const height = new Float32Array(safeSize * safeSize);
  const albedoCanvas = createCanvas(safeSize, safeSize);
  const albedoContext = getContext(albedoCanvas);
  const albedoImage = albedoContext.createImageData(safeSize, safeSize);
  const roughnessCanvas = createCanvas(safeSize, safeSize);
  const roughnessContext = getContext(roughnessCanvas);
  const roughnessImage = roughnessContext.createImageData(safeSize, safeSize);

  for (let y = 0; y < safeSize; y += 1) {
    const v = y / safeSize;
    for (let x = 0; x < safeSize; x += 1) {
      const u = x / safeSize;
      const macro =
        tiledNoise(u * 5, v * 5, 5, 0x51f0) * 0.5
        + tiledNoise(u * 13, v * 13, 13, 0x8d31) * 0.32
        + tiledNoise(u * 47, v * 47, 47, 0x2a61) * 0.18;
      const moss = smoothstep(THREE.MathUtils.clamp((macro - 0.34) / 0.52, 0, 1));
      const mineral = tiledNoise(u * 91, v * 91, 91, 0x771c) - 0.5;
      const rootBand = Math.abs(Math.sin((u * 2.1 + v * 1.35) * TWO_PI + macro * 2.4));
      const root = smoothstep(THREE.MathUtils.clamp((rootBand - 0.82) / 0.18, 0, 1));
      const wet = smoothstep(THREE.MathUtils.clamp((0.48 - macro) / 0.22, 0, 1));
      const index = y * safeSize + x;
      height[index] = macro * 0.72 + mineral * 0.06 + root * 0.22;

      const mossMix = moss * 0.76;
      const litterMix = Math.max(0, mineral) * 0.18;
      const rootMix = root * 0.42;
      const brightness = 0.86 + mineral * 0.15 - wet * 0.08;
      let red = THREE.MathUtils.lerp(38, 85, mossMix);
      let green = THREE.MathUtils.lerp(49, 117, mossMix);
      let blue = THREE.MathUtils.lerp(40, 72, mossMix);
      red = THREE.MathUtils.lerp(red, 113, litterMix) * brightness;
      green = THREE.MathUtils.lerp(green, 134, litterMix) * brightness;
      blue = THREE.MathUtils.lerp(blue, 90, litterMix) * brightness;
      red = THREE.MathUtils.lerp(red, 56, rootMix);
      green = THREE.MathUtils.lerp(green, 47, rootMix);
      blue = THREE.MathUtils.lerp(blue, 36, rootMix);

      const offset = index * 4;
      albedoImage.data[offset] = THREE.MathUtils.clamp(red, 0, 255);
      albedoImage.data[offset + 1] = THREE.MathUtils.clamp(green, 0, 255);
      albedoImage.data[offset + 2] = THREE.MathUtils.clamp(blue, 0, 255);
      albedoImage.data[offset + 3] = 255;

      const roughness = THREE.MathUtils.clamp(0.91 - wet * 0.3 - root * 0.08 + mineral * 0.06, 0.5, 0.98);
      const roughnessByte = Math.round(roughness * 255);
      roughnessImage.data[offset] = roughnessByte;
      roughnessImage.data[offset + 1] = roughnessByte;
      roughnessImage.data[offset + 2] = roughnessByte;
      roughnessImage.data[offset + 3] = 255;
    }
  }
  albedoContext.putImageData(albedoImage, 0, 0);
  roughnessContext.putImageData(roughnessImage, 0, 0);

  // Leaf litter adds scale cues without baking light or introducing seams.
  const random = seededRandom(0xf012e57);
  for (let leaf = 0; leaf < Math.round(safeSize / 2.8); leaf += 1) {
    const x = random() * safeSize;
    const y = random() * safeSize;
    const length = safeSize * (0.006 + random() * 0.014);
    const width = length * (0.14 + random() * 0.2);
    albedoContext.save();
    albedoContext.translate(x, y);
    albedoContext.rotate(random() * TWO_PI);
    albedoContext.fillStyle = random() > 0.54
      ? `rgba(106, 126, 73, ${0.18 + random() * 0.2})`
      : `rgba(47, 56, 39, ${0.2 + random() * 0.2})`;
    albedoContext.beginPath();
    albedoContext.ellipse(0, 0, length, width, 0, 0, TWO_PI);
    albedoContext.fill();
    albedoContext.restore();
  }

  const normalCanvas = createCanvas(safeSize, safeSize);
  const normalContext = getContext(normalCanvas);
  const normalImage = normalContext.createImageData(safeSize, safeSize);
  const wrap = (value: number): number => (value + safeSize) % safeSize;
  for (let y = 0; y < safeSize; y += 1) {
    for (let x = 0; x < safeSize; x += 1) {
      const left = height[y * safeSize + wrap(x - 1)]!;
      const right = height[y * safeSize + wrap(x + 1)]!;
      const top = height[wrap(y - 1) * safeSize + x]!;
      const bottom = height[wrap(y + 1) * safeSize + x]!;
      const normalX = (left - right) * 2.4;
      const normalY = (top - bottom) * 2.4;
      const inverseLength = 1 / Math.hypot(normalX, normalY, 1);
      const offset = (y * safeSize + x) * 4;
      normalImage.data[offset] = Math.round((normalX * inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 1] = Math.round((normalY * inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 3] = 255;
    }
  }
  normalContext.putImageData(normalImage, 0, 0);

  const makeTexture = (
    canvas: HTMLCanvasElement,
    name: string,
    colorSpace: THREE.ColorSpace,
  ): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = name;
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  };

  return {
    albedo: makeTexture(albedoCanvas, 'forest-ground-albedo', THREE.SRGBColorSpace),
    normal: makeTexture(normalCanvas, 'forest-ground-normal', THREE.NoColorSpace),
    roughness: makeTexture(roughnessCanvas, 'forest-ground-roughness', THREE.NoColorSpace),
  };
};

/** White ceramic/black composite/lime stripe surface used by facility paths. */
export const createFacilityPanelTexture = (size = 512): THREE.CanvasTexture => {
  const safeSize = Math.max(128, Math.round(size));
  const canvas = createCanvas(safeSize, safeSize);
  const context = getContext(canvas);
  context.fillStyle = '#dce3df';
  context.fillRect(0, 0, safeSize, safeSize);

  const half = safeSize * 0.5;
  context.fillStyle = '#11191d';
  context.fillRect(half - safeSize * 0.012, 0, safeSize * 0.024, safeSize);
  context.fillRect(0, half - safeSize * 0.012, safeSize, safeSize * 0.024);
  context.fillStyle = '#a8e63a';
  context.fillRect(0, safeSize * 0.09, safeSize, safeSize * 0.035);
  context.fillRect(safeSize * 0.875, 0, safeSize * 0.032, safeSize);

  context.strokeStyle = 'rgba(8, 16, 18, 0.32)';
  context.lineWidth = Math.max(1, safeSize / 256);
  context.strokeRect(safeSize * 0.025, safeSize * 0.025, safeSize * 0.95, safeSize * 0.95);
  context.strokeRect(safeSize * 0.055, safeSize * 0.055, safeSize * 0.39, safeSize * 0.37);
  context.strokeRect(safeSize * 0.555, safeSize * 0.555, safeSize * 0.39, safeSize * 0.37);

  const random = seededRandom(0xface71);
  for (let mark = 0; mark < Math.round(safeSize * 0.42); mark += 1) {
    const alpha = 0.025 + random() * 0.07;
    context.fillStyle = `rgba(13, 26, 27, ${alpha})`;
    const radius = 0.3 + random() * 1.8;
    context.beginPath();
    context.arc(random() * safeSize, random() * safeSize, radius, 0, TWO_PI);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'facility-panel-albedo';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
};

export type RadialTextureProfile = 'shadow' | 'glow';

export interface RadialTextureOptions {
  size?: number;
  profile?: RadialTextureProfile;
}

/**
 * White radial alpha mask. Tint it through the material: black for a contact
 * shadow or an HDR emissive color for a halo/sprite.
 */
export const createRadialTexture = ({
  size = 128,
  profile = 'shadow',
}: RadialTextureOptions = {}): THREE.CanvasTexture => {
  const safeSize = Math.max(32, Math.round(size));
  const canvas = createCanvas(safeSize, safeSize);
  const context = getContext(canvas);
  const center = safeSize * 0.5;
  const radius = safeSize * 0.49;
  const gradient = context.createRadialGradient(center, center, 0, center, center, radius);

  if (profile === 'shadow') {
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
    gradient.addColorStop(0.24, 'rgba(255, 255, 255, 0.72)');
    gradient.addColorStop(0.62, 'rgba(255, 255, 255, 0.24)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  } else {
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.1, 'rgba(255, 255, 255, 0.94)');
    gradient.addColorStop(0.38, 'rgba(255, 255, 255, 0.42)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  }

  context.fillStyle = gradient;
  context.fillRect(0, 0, safeSize, safeSize);

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `radial-${profile}-mask`;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
};
