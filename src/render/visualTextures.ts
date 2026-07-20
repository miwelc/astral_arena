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

/**
 * Dark orbital PMREM source for Umbra Station. The visible stars live in the
 * sky shader; this texture supplies broad blue-violet reflections, a hard
 * stellar key and a warm station bounce without washing the scene in a
 * terrestrial horizon colour.
 */
export const createOrbitalEnvironmentTexture = (width = 1024, height = 512): THREE.CanvasTexture => {
  const safeWidth = Math.max(64, Math.round(width));
  const safeHeight = Math.max(32, Math.round(height));
  const canvas = createCanvas(safeWidth, safeHeight);
  const context = getContext(canvas);

  const voidGradient = context.createLinearGradient(0, 0, 0, safeHeight);
  voidGradient.addColorStop(0, '#050914');
  voidGradient.addColorStop(0.38, '#10243b');
  voidGradient.addColorStop(0.56, '#29455f');
  voidGradient.addColorStop(0.72, '#121f34');
  voidGradient.addColorStop(1, '#040711');
  context.fillStyle = voidGradient;
  context.fillRect(0, 0, safeWidth, safeHeight);

  const stellarU = 0.18;
  const stellarX = stellarU * safeWidth;
  const stellarY = safeHeight * 0.3;
  const haloRadius = safeHeight * 0.3;
  for (const wrappedX of [stellarX - safeWidth, stellarX, stellarX + safeWidth]) {
    const halo = context.createRadialGradient(
      wrappedX,
      stellarY,
      0,
      wrappedX,
      stellarY,
      haloRadius,
    );
    halo.addColorStop(0, 'rgba(255, 247, 221, 1)');
    halo.addColorStop(0.035, 'rgba(176, 225, 255, 0.82)');
    halo.addColorStop(0.19, 'rgba(66, 134, 214, 0.34)');
    halo.addColorStop(1, 'rgba(22, 52, 115, 0)');
    context.fillStyle = halo;
    context.fillRect(
      wrappedX - haloRadius,
      stellarY - haloRadius,
      haloRadius * 2,
      haloRadius * 2,
    );
  }

  const stationBounce = context.createRadialGradient(
    safeWidth * 0.68,
    safeHeight * 0.72,
    0,
    safeWidth * 0.68,
    safeHeight * 0.72,
    safeHeight * 0.42,
  );
  stationBounce.addColorStop(0, 'rgba(255, 166, 94, 0.25)');
  stationBounce.addColorStop(0.34, 'rgba(126, 91, 144, 0.14)');
  stationBounce.addColorStop(1, 'rgba(13, 21, 48, 0)');
  context.fillStyle = stationBounce;
  context.fillRect(0, 0, safeWidth, safeHeight);

  const random = seededRandom(0x0b17a1);
  const starCount = Math.max(90, Math.round((safeWidth * safeHeight) / 2_900));
  for (let index = 0; index < starCount; index += 1) {
    const alpha = 0.18 + random() * 0.62;
    const size = random() > 0.94 ? 1.5 : 0.65;
    context.fillStyle = `rgba(${random() > 0.76 ? '186,220,255' : '238,242,255'},${alpha})`;
    context.fillRect(random() * safeWidth, random() * safeHeight * 0.82, size, size);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'umbra-orbital-equirectangular-environment';
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
  const pixelCount = safeSize * safeSize;
  const height = new Float32Array(pixelCount);
  const mossMask = new Float32Array(pixelCount);
  const puddleMask = new Float32Array(pixelCount);
  const rootMask = new Float32Array(pixelCount);
  const stoneMask = new Float32Array(pixelCount);
  const leafGreenMask = new Float32Array(pixelCount);
  const leafOchreMask = new Float32Array(pixelCount);
  const twigMask = new Float32Array(pixelCount);
  const fineVariation = new Float32Array(pixelCount);
  const albedoCanvas = createCanvas(safeSize, safeSize);
  const albedoContext = getContext(albedoCanvas);
  const albedoImage = albedoContext.createImageData(safeSize, safeSize);
  const roughnessCanvas = createCanvas(safeSize, safeSize);
  const roughnessContext = getContext(roughnessCanvas);
  const roughnessImage = roughnessContext.createImageData(safeSize, safeSize);

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
  const lerp = (start: number, end: number, alpha: number): number => start + (end - start) * alpha;
  const wrapCoordinate = (value: number): number => {
    const wrapped = value % safeSize;
    return wrapped < 0 ? wrapped + safeSize : wrapped;
  };
  const wrappedIndex = (x: number, y: number): number => (
    Math.floor(wrapCoordinate(y)) * safeSize + Math.floor(wrapCoordinate(x))
  );
  const mergeMask = (mask: Float32Array, index: number, value: number): void => {
    if (value > mask[index]!) mask[index] = value;
  };

  /**
   * Rasterises a soft, rotated dome directly into a toroidal buffer. Using the
   * same mask for height, colour and roughness keeps loose material physically
   * coherent while making every feature continue cleanly across tile edges.
   */
  const stampEllipse = (
    mask: Float32Array,
    centerX: number,
    centerY: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    edgeSoftness = 0.24,
  ): void => {
    const cosine = Math.cos(rotation);
    const sine = Math.sin(rotation);
    const extent = Math.ceil(Math.max(radiusX, radiusY) + 1);
    const minX = Math.floor(centerX - extent);
    const maxX = Math.ceil(centerX + extent);
    const minY = Math.floor(centerY - extent);
    const maxY = Math.ceil(centerY + extent);
    for (let y = minY; y <= maxY; y += 1) {
      const relativeY = y + 0.5 - centerY;
      for (let x = minX; x <= maxX; x += 1) {
        const relativeX = x + 0.5 - centerX;
        const localX = (relativeX * cosine + relativeY * sine) / radiusX;
        const localY = (-relativeX * sine + relativeY * cosine) / radiusY;
        const radialDistance = Math.hypot(localX, localY);
        if (radialDistance >= 1) continue;
        const dome = smoothstep(clamp01(1 - radialDistance));
        const softPlateau = smoothstep(clamp01((1 - radialDistance) / edgeSoftness));
        const value = lerp(dome, softPlateau, 0.16);
        mergeMask(mask, wrappedIndex(x, y), value);
      }
    }
  };

  /** Draws roots and twigs as soft capsules in the same toroidal buffers. */
  const stampSegment = (
    mask: Float32Array,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    radius: number,
  ): void => {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const lengthSquared = deltaX * deltaX + deltaY * deltaY;
    const minX = Math.floor(Math.min(startX, endX) - radius - 1);
    const maxX = Math.ceil(Math.max(startX, endX) + radius + 1);
    const minY = Math.floor(Math.min(startY, endY) - radius - 1);
    const maxY = Math.ceil(Math.max(startY, endY) + radius + 1);
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const pointX = x + 0.5;
        const pointY = y + 0.5;
        const projection = lengthSquared > 0
          ? clamp01(((pointX - startX) * deltaX + (pointY - startY) * deltaY) / lengthSquared)
          : 0;
        const nearestX = startX + deltaX * projection;
        const nearestY = startY + deltaY * projection;
        const distance = Math.hypot(pointX - nearestX, pointY - nearestY);
        if (distance >= radius) continue;
        const value = smoothstep(clamp01(1 - distance / radius));
        mergeMask(mask, wrappedIndex(x, y), value);
      }
    }
  };

  for (let y = 0; y < safeSize; y += 1) {
    const v = y / safeSize;
    for (let x = 0; x < safeSize; x += 1) {
      const u = x / safeSize;
      const index = y * safeSize + x;
      const broad = tiledNoise(u * 4, v * 4, 4, 0x51f0);
      const medium = tiledNoise(u * 11, v * 11, 11, 0x8d31);
      const granular = tiledNoise(u * 37, v * 37, 37, 0x2a61);
      const micro = tiledNoise(u * 113, v * 113, 113, 0x771c) - 0.5;
      const pore = tiledNoise(u * 191, v * 191, 191, 0x31af) - 0.5;
      const terrain = broad * 0.51 + medium * 0.31 + granular * 0.18;

      // Moss prefers raised, stable soil while water collects in broad basins.
      const mossDistribution = terrain * 0.72 + tiledNoise(u * 7, v * 7, 7, 0xb055) * 0.28;
      const moss = smoothstep(clamp01((mossDistribution - 0.47) / 0.31));
      const basin = 1 - (broad * 0.72 + medium * 0.28);
      const puddleShape = basin * 0.72 + tiledNoise(u * 9, v * 9, 9, 0x9e71) * 0.28;
      const puddle = smoothstep(clamp01((puddleShape - 0.61) / 0.16));

      mossMask[index] = moss * (1 - puddle * 0.92);
      puddleMask[index] = puddle;
      fineVariation[index] = micro * 0.7 + pore * 0.3;
      height[index] = terrain * 0.46 + micro * 0.035 + pore * 0.012 - puddle * 0.075;
    }
  }

  // Feature masks use deterministic toroidal stamps, so details crossing one
  // edge continue at the opposite edge instead of exposing a square tile.
  const random = seededRandom(0xf012e57);
  const rootSystemCount = Math.max(6, Math.round(safeSize / 72));
  for (let system = 0; system < rootSystemCount; system += 1) {
    let currentX = random() * safeSize;
    let currentY = random() * safeSize;
    let angle = random() * TWO_PI;
    const segmentCount = 7 + Math.floor(random() * 7);
    let radius = safeSize * (0.0042 + random() * 0.0048);
    for (let segment = 0; segment < segmentCount; segment += 1) {
      angle += (random() - 0.5) * 0.68;
      const length = safeSize * (0.026 + random() * 0.038);
      const nextX = currentX + Math.cos(angle) * length;
      const nextY = currentY + Math.sin(angle) * length;
      stampSegment(rootMask, currentX, currentY, nextX, nextY, radius);

      if (segment > 1 && random() > 0.63) {
        const branchAngle = angle + (random() > 0.5 ? 1 : -1) * (0.42 + random() * 0.7);
        const branchLength = length * (0.38 + random() * 0.5);
        stampSegment(
          rootMask,
          currentX,
          currentY,
          currentX + Math.cos(branchAngle) * branchLength,
          currentY + Math.sin(branchAngle) * branchLength,
          radius * 0.58,
        );
      }
      currentX = nextX;
      currentY = nextY;
      radius *= 0.9;
    }
  }

  const stoneCount = Math.max(52, Math.round(safeSize * 0.27));
  for (let stone = 0; stone < stoneCount; stone += 1) {
    const radius = safeSize * (0.0028 + random() * random() * 0.0095);
    stampEllipse(
      stoneMask,
      random() * safeSize,
      random() * safeSize,
      radius * (1.12 + random() * 0.65),
      radius * (0.68 + random() * 0.42),
      random() * TWO_PI,
      0.46,
    );
  }

  const leafCount = Math.max(280, Math.round(safeSize * 1.15));
  for (let leaf = 0; leaf < leafCount; leaf += 1) {
    const length = safeSize * (0.0045 + random() * 0.012);
    const target = random() > 0.58 ? leafOchreMask : leafGreenMask;
    stampEllipse(
      target,
      random() * safeSize,
      random() * safeSize,
      length,
      length * (0.15 + random() * 0.19),
      random() * TWO_PI,
      0.32,
    );
  }

  const twigCount = Math.max(30, Math.round(safeSize / 8));
  for (let twig = 0; twig < twigCount; twig += 1) {
    const startX = random() * safeSize;
    const startY = random() * safeSize;
    const angle = random() * TWO_PI;
    const length = safeSize * (0.012 + random() * 0.032);
    stampSegment(
      twigMask,
      startX,
      startY,
      startX + Math.cos(angle) * length,
      startY + Math.sin(angle) * length,
      Math.max(0.55, safeSize * (0.001 + random() * 0.0012)),
    );
  }

  // Build every PBR channel from the same semantic masks. Values describe
  // material colour only; all apparent direction and depth comes from normals.
  for (let index = 0; index < pixelCount; index += 1) {
    const moss = mossMask[index]!;
    const puddle = puddleMask[index]!;
    const root = rootMask[index]!;
    const stone = stoneMask[index]!;
    const greenLeaf = leafGreenMask[index]!;
    const ochreLeaf = leafOchreMask[index]!;
    const twig = twigMask[index]!;
    const variation = fineVariation[index]!;
    const leaf = Math.max(greenLeaf, ochreLeaf);

    // Damp mineral soil.
    let red = 132 + variation * 18;
    let green = 150 + variation * 20;
    let blue = 105 + variation * 15;

    // Dense moss has several greens, avoiding a single synthetic-looking hue.
    const mossVariation = clamp01(0.48 + variation * 1.4);
    red = lerp(red, lerp(100, 140, mossVariation), moss * 0.9);
    green = lerp(green, lerp(145, 195, mossVariation), moss * 0.9);
    blue = lerp(blue, lerp(80, 110, mossVariation), moss * 0.9);

    // Puddles are dark because the saturated soil absorbs more light, not
    // because a directional highlight has been painted into the albedo.
    red = lerp(red, 60 + variation * 7, puddle * 0.82);
    green = lerp(green, 82 + variation * 8, puddle * 0.82);
    blue = lerp(blue, 78 + variation * 8, puddle * 0.82);

    red = lerp(red, 135 + variation * 12, root * 0.88);
    green = lerp(green, 105 + variation * 10, root * 0.88);
    blue = lerp(blue, 72 + variation * 9, root * 0.88);

    // Quartz/slate pebbles remain neutral so real scene lights define form.
    red = lerp(red, 155 + variation * 18, stone * 0.84);
    green = lerp(green, 165 + variation * 17, stone * 0.84);
    blue = lerp(blue, 155 + variation * 16, stone * 0.84);

    red = lerp(red, 100 + variation * 12, greenLeaf * 0.92);
    green = lerp(green, 150 + variation * 16, greenLeaf * 0.92);
    blue = lerp(blue, 78 + variation * 10, greenLeaf * 0.92);
    red = lerp(red, 180 + variation * 15, ochreLeaf * 0.92);
    green = lerp(green, 145 + variation * 13, ochreLeaf * 0.92);
    blue = lerp(blue, 80 + variation * 10, ochreLeaf * 0.92);
    red = lerp(red, 100, twig * 0.9);
    green = lerp(green, 78, twig * 0.9);
    blue = lerp(blue, 55, twig * 0.9);

    const offset = index * 4;
    albedoImage.data[offset] = Math.round(Math.min(255, Math.max(0, red)));
    albedoImage.data[offset + 1] = Math.round(Math.min(255, Math.max(0, green)));
    albedoImage.data[offset + 2] = Math.round(Math.min(255, Math.max(0, blue)));
    albedoImage.data[offset + 3] = 255;

    let roughness = 0.9 + variation * 0.045;
    roughness = lerp(roughness, 0.96, moss * 0.82);
    roughness = lerp(roughness, 0.24 + Math.abs(variation) * 0.12, puddle * 0.94);
    roughness = lerp(roughness, 0.72, root * 0.72);
    roughness = lerp(roughness, puddle > 0.2 ? 0.38 : 0.64, stone * 0.82);
    roughness = lerp(roughness, ochreLeaf > greenLeaf ? 0.78 : 0.86, leaf * 0.82);
    roughness = lerp(roughness, 0.81, twig * 0.76);
    const roughnessByte = Math.round(clamp01(roughness) * 255);
    roughnessImage.data[offset] = roughnessByte;
    roughnessImage.data[offset + 1] = roughnessByte;
    roughnessImage.data[offset + 2] = roughnessByte;
    roughnessImage.data[offset + 3] = 255;

    // Overlaid features become part of the scalar height field before normal
    // generation, including fine litter that was previously colour-only.
    height[index] = height[index]! + root * 0.15
      + stone * 0.21
      + leaf * 0.052
      + twig * 0.075
      + moss * 0.022;
  }
  albedoContext.putImageData(albedoImage, 0, 0);
  roughnessContext.putImageData(roughnessImage, 0, 0);

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
      const normalX = (left - right) * 3.35;
      const normalY = (top - bottom) * 3.35;
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

/**
 * Manufactured deck albedo used by facility paths. Umbra receives its own
 * graphite pressure-deck treatment instead of inheriting Crater's white
 * ceramic and lime safety paint.
 */
export const createFacilityPanelTexture = (
  size = 512,
  style: 'ceramic' | 'orbital' = 'ceramic',
): THREE.CanvasTexture => {
  const safeSize = Math.max(128, Math.round(size));
  const canvas = createCanvas(safeSize, safeSize);
  const context = getContext(canvas);
  const orbital = style === 'orbital';
  context.fillStyle = orbital ? '#354b60' : '#dce3df';
  context.fillRect(0, 0, safeSize, safeSize);

  const half = safeSize * 0.5;
  context.fillStyle = orbital ? '#142334' : '#11191d';
  context.fillRect(half - safeSize * (orbital ? 0.018 : 0.012), 0, safeSize * (orbital ? 0.036 : 0.024), safeSize);
  context.fillRect(0, half - safeSize * (orbital ? 0.018 : 0.012), safeSize, safeSize * (orbital ? 0.036 : 0.024));
  context.fillStyle = orbital ? '#5ddff2' : '#a8e63a';
  context.fillRect(0, safeSize * 0.09, safeSize, safeSize * (orbital ? 0.018 : 0.035));
  context.fillRect(safeSize * 0.875, 0, safeSize * (orbital ? 0.016 : 0.032), safeSize);
  if (orbital) {
    context.fillStyle = '#d88856';
    context.fillRect(0, safeSize * 0.895, safeSize, safeSize * 0.012);
    context.fillStyle = 'rgba(116, 149, 180, 0.34)';
    context.fillRect(safeSize * 0.055, safeSize * 0.56, safeSize * 0.39, safeSize * 0.37);
    context.fillStyle = 'rgba(30, 48, 67, 0.42)';
    context.fillRect(safeSize * 0.555, safeSize * 0.055, safeSize * 0.39, safeSize * 0.37);
  }

  context.strokeStyle = orbital ? 'rgba(4, 12, 22, 0.72)' : 'rgba(8, 16, 18, 0.32)';
  context.lineWidth = Math.max(1, safeSize / 256);
  context.strokeRect(safeSize * 0.025, safeSize * 0.025, safeSize * 0.95, safeSize * 0.95);
  context.strokeRect(safeSize * 0.055, safeSize * 0.055, safeSize * 0.39, safeSize * 0.37);
  context.strokeRect(safeSize * 0.555, safeSize * 0.555, safeSize * 0.39, safeSize * 0.37);

  if (orbital) {
    context.strokeStyle = 'rgba(166, 205, 229, 0.2)';
    context.lineWidth = Math.max(0.6, safeSize / 620);
    for (const inset of [0.065, 0.435, 0.565, 0.935]) {
      context.beginPath();
      context.moveTo(safeSize * inset, safeSize * 0.14);
      context.lineTo(safeSize * inset, safeSize * 0.86);
      context.stroke();
    }
  }

  const random = seededRandom(0xface71);
  for (let mark = 0; mark < Math.round(safeSize * 0.42); mark += 1) {
    const alpha = (orbital ? 0.035 : 0.025) + random() * (orbital ? 0.09 : 0.07);
    context.fillStyle = orbital
      ? `rgba(${random() > 0.82 ? '145,174,195' : '7,17,27'}, ${alpha})`
      : `rgba(13, 26, 27, ${alpha})`;
    const radius = 0.3 + random() * 1.8;
    context.beginPath();
    context.arc(random() * safeSize, random() * safeSize, radius, 0, TWO_PI);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = orbital ? 'umbra-pressure-deck-albedo' : 'facility-panel-albedo';
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
};

export interface TechnicalSurfaceTextures {
  normal: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
}

/**
 * Tileable micro-surface shared by ceramic architecture, weapon shells and
 * astronaut armour. Panel joints, recessed fasteners and fine abrasion add
 * material scale without baking a light direction into the albedo.
 */
export const createTechnicalSurfaceTextures = (size = 256): TechnicalSurfaceTextures => {
  const safeSize = Math.max(128, Math.round(size));
  const height = new Float32Array(safeSize * safeSize);
  const roughnessCanvas = createCanvas(safeSize, safeSize);
  const roughnessContext = getContext(roughnessCanvas);
  const roughnessImage = roughnessContext.createImageData(safeSize, safeSize);
  const fract = (value: number): number => value - Math.floor(value);
  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

  for (let y = 0; y < safeSize; y += 1) {
    const v = y / safeSize;
    for (let x = 0; x < safeSize; x += 1) {
      const u = x / safeSize;
      const panelU = fract(u * 4);
      const panelV = fract(v * 4);
      const seamDistance = Math.min(panelU, 1 - panelU, panelV, 1 - panelV);
      const seam = 1 - smoothstep(clamp01((seamDistance - 0.006) / 0.032));
      const fastenerX = panelU - 0.12;
      const fastenerY = panelV - 0.12;
      const fastener = 1 - smoothstep(clamp01((Math.hypot(fastenerX, fastenerY) - 0.025) / 0.045));
      const brushed = tiledNoise(u * 67, v * 67, 67, 0x7e611) - 0.5;
      const grain = tiledNoise(u * 149, v * 149, 149, 0x5ca7c) - 0.5;
      const abrasion = Math.abs(Math.sin((u * 31 + v * 3.7) * TWO_PI + brushed * 2.2));
      const scratch = smoothstep(clamp01((abrasion - 0.965) / 0.035));
      const index = y * safeSize + x;
      height[index] = brushed * 0.035 + grain * 0.015 - seam * 0.13 + fastener * 0.19 - scratch * 0.035;

      const roughness = clamp01(0.54 + grain * 0.12 + seam * 0.2 - fastener * 0.16 + scratch * 0.18);
      const byte = Math.round(roughness * 255);
      const offset = index * 4;
      roughnessImage.data[offset] = byte;
      roughnessImage.data[offset + 1] = byte;
      roughnessImage.data[offset + 2] = byte;
      roughnessImage.data[offset + 3] = 255;
    }
  }
  roughnessContext.putImageData(roughnessImage, 0, 0);

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
      const normalX = (left - right) * 4.1;
      const normalY = (top - bottom) * 4.1;
      const inverseLength = 1 / Math.hypot(normalX, normalY, 1);
      const offset = (y * safeSize + x) * 4;
      normalImage.data[offset] = Math.round((normalX * inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 1] = Math.round((normalY * inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
      normalImage.data[offset + 3] = 255;
    }
  }
  normalContext.putImageData(normalImage, 0, 0);

  const makeTexture = (canvas: HTMLCanvasElement, name: string): THREE.CanvasTexture => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.name = name;
    texture.colorSpace = THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    return texture;
  };

  return {
    normal: makeTexture(normalCanvas, 'technical-surface-normal'),
    roughness: makeTexture(roughnessCanvas, 'technical-surface-roughness'),
  };
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
