import * as THREE from 'three';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

const seededRandom = (seed: number): (() => number) => {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

const clampInteger = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

const requirePositive = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive.`);
};

export interface FacilityPalette {
  panelLight: THREE.ColorRepresentation;
  panelSage: THREE.ColorRepresentation;
  panelBlue: THREE.ColorRepresentation;
  panelDark: THREE.ColorRepresentation;
  structural: THREE.ColorRepresentation;
  accent: THREE.ColorRepresentation;
  accentOrange: THREE.ColorRepresentation;
  accentBlue: THREE.ColorRepresentation;
  glass: THREE.ColorRepresentation;
  bark: THREE.ColorRepresentation;
  canopy: THREE.ColorRepresentation;
  fern: THREE.ColorRepresentation;
  grass: THREE.ColorRepresentation;
  wetRock: THREE.ColorRepresentation;
  lichen: THREE.ColorRepresentation;
  emissive: THREE.ColorRepresentation;
}

/**
 * Cool human-facility palette with distinct ceramic/alloy families. Clone
 * before changing individual colors.
 */
export const DEFAULT_FACILITY_PALETTE: Readonly<FacilityPalette> = Object.freeze({
  panelLight: 0xf4f3ec,
  panelSage: 0xc5d2cd,
  panelBlue: 0xb9cdd5,
  panelDark: 0x091218,
  structural: 0x15242a,
  accent: 0xa4e83f,
  accentOrange: 0xd47a45,
  accentBlue: 0x4c9db6,
  glass: 0x6fbcc7,
  bark: 0x101b19,
  canopy: 0x3b6242,
  fern: 0x568c4d,
  grass: 0x769f58,
  wetRock: 0x263c3b,
  lichen: 0x748e58,
  emissive: 0x4bd9ff,
});

export interface FacilityMaterialKit {
  panelLight: THREE.MeshPhysicalMaterial;
  panelSage: THREE.MeshPhysicalMaterial;
  panelBlue: THREE.MeshPhysicalMaterial;
  panelDark: THREE.MeshPhysicalMaterial;
  structural: THREE.MeshStandardMaterial;
  accent: THREE.MeshPhysicalMaterial;
  accentOrange: THREE.MeshPhysicalMaterial;
  accentBlue: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  bark: THREE.MeshStandardMaterial;
  canopy: THREE.MeshStandardMaterial;
  fern: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  wetRock: THREE.MeshPhysicalMaterial;
  lichen: THREE.MeshStandardMaterial;
  cable: THREE.MeshStandardMaterial;
  emissive: THREE.MeshStandardMaterial;
}

export interface FacilityMaterialOptions {
  palette?: Partial<FacilityPalette>;
  /** Multiplies emissive signage intensity. Bloom is controlled by the renderer. */
  emissiveIntensity?: number;
}

interface FacilitySkinTextures {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
}

const createFacilitySkinTextures = (): FacilitySkinTextures => {
  const size = 64;
  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const localX = x % 32;
      const localY = y % 16;
      const seamX = localX === 0 || localX === 31;
      const seamY = localY === 0 || localY === 15;
      const seam = seamX || seamY;
      const shoulder = localX === 1 || localX === 30 || localY === 1 || localY === 14;
      const fastener = (localX === 4 || localX === 27) && (localY === 3 || localY === 12);
      const brushed = Math.sin((x * 0.71 + y * 2.13) * Math.PI) * 4;
      const scratch = ((x * 17 + y * 31) % 149) < 2;
      const value = seam ? 72 : fastener ? 92 : shoulder ? 190 : 225 + brushed - (scratch ? 25 : 0);
      albedo[index] = Math.max(0, Math.min(255, Math.round(value)));
      albedo[index + 1] = Math.max(0, Math.min(255, Math.round(value + (scratch ? 4 : 0))));
      albedo[index + 2] = Math.max(0, Math.min(255, Math.round(value - (scratch ? 8 : 0))));
      albedo[index + 3] = 255;

      normal[index] = seamX ? (localX === 0 ? 94 : 162) : 128;
      normal[index + 1] = seamY ? (localY === 0 ? 94 : 162) : 128;
      normal[index + 2] = fastener ? 188 : seam ? 206 : scratch ? 224 : 252;
      normal[index + 3] = 255;

      const roughnessValue = seam ? 226 : fastener ? 112 : scratch ? 94 : 151 + brushed * 2.2;
      const roughnessByte = Math.max(0, Math.min(255, Math.round(roughnessValue)));
      roughness[index] = roughnessByte;
      roughness[index + 1] = roughnessByte;
      roughness[index + 2] = roughnessByte;
      roughness[index + 3] = 255;
    }
  }
  const configure = (pixels: Uint8Array, color = false): THREE.DataTexture => {
    const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };
  return {
    albedo: configure(albedo, true),
    normal: configure(normal),
    roughness: configure(roughness),
  };
};

/** Creates a shareable PBR material kit. Call `disposeFacilityMaterialKit` when it is no longer used. */
export const createFacilityMaterialKit = (
  options: FacilityMaterialOptions = {},
): FacilityMaterialKit => {
  const palette: FacilityPalette = { ...DEFAULT_FACILITY_PALETTE, ...options.palette };
  const emissiveIntensity = Math.max(0, options.emissiveIntensity ?? 2.2);
  const textures = createFacilitySkinTextures();
  const texturedSurface = {
    map: textures.albedo,
    normalMap: textures.normal,
    normalScale: new THREE.Vector2(0.48, 0.48),
    roughnessMap: textures.roughness,
  };

  return {
    panelLight: new THREE.MeshPhysicalMaterial({
      name: 'facility-panel-light',
      color: palette.panelLight,
      ...texturedSurface,
      metalness: 0.1,
      roughness: 0.28,
      clearcoat: 0.38,
      clearcoatRoughness: 0.26,
      envMapIntensity: 1.08,
    }),
    panelSage: new THREE.MeshPhysicalMaterial({
      name: 'facility-panel-sage-alloy',
      color: palette.panelSage,
      ...texturedSurface,
      metalness: 0.38,
      roughness: 0.44,
      clearcoat: 0.14,
      clearcoatRoughness: 0.42,
    }),
    panelBlue: new THREE.MeshPhysicalMaterial({
      name: 'facility-panel-desaturated-blue',
      color: palette.panelBlue,
      ...texturedSurface,
      metalness: 0.46,
      roughness: 0.35,
      clearcoat: 0.2,
      clearcoatRoughness: 0.34,
    }),
    panelDark: new THREE.MeshPhysicalMaterial({
      name: 'facility-panel-dark',
      color: palette.panelDark,
      normalMap: textures.normal,
      normalScale: new THREE.Vector2(0.36, 0.36),
      roughnessMap: textures.roughness,
      metalness: 0.62,
      roughness: 0.2,
      clearcoat: 0.28,
      clearcoatRoughness: 0.18,
    }),
    structural: new THREE.MeshStandardMaterial({
      name: 'facility-structural',
      color: palette.structural,
      metalness: 0.72,
      roughness: 0.28,
    }),
    accent: new THREE.MeshPhysicalMaterial({
      name: 'facility-lime-accent',
      color: palette.accent,
      metalness: 0.22,
      roughness: 0.3,
      clearcoat: 0.42,
      clearcoatRoughness: 0.2,
    }),
    accentOrange: new THREE.MeshPhysicalMaterial({
      name: 'facility-service-orange-accent',
      color: palette.accentOrange,
      metalness: 0.28,
      roughness: 0.38,
      clearcoat: 0.3,
      clearcoatRoughness: 0.28,
    }),
    accentBlue: new THREE.MeshPhysicalMaterial({
      name: 'facility-service-blue-accent',
      color: palette.accentBlue,
      metalness: 0.34,
      roughness: 0.33,
      clearcoat: 0.38,
      clearcoatRoughness: 0.24,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      name: 'facility-smoked-glass',
      color: palette.glass,
      metalness: 0.12,
      roughness: 0.12,
      transmission: 0.25,
      thickness: 0.08,
      transparent: true,
      opacity: 0.72,
      clearcoat: 0.75,
      clearcoatRoughness: 0.08,
    }),
    bark: new THREE.MeshStandardMaterial({
      name: 'facility-forest-bark',
      color: palette.bark,
      roughness: 0.93,
      metalness: 0.02,
      vertexColors: true,
    }),
    canopy: new THREE.MeshStandardMaterial({
      name: 'facility-forest-canopy',
      color: palette.canopy,
      roughness: 0.78,
      metalness: 0,
      vertexColors: true,
    }),
    fern: new THREE.MeshStandardMaterial({
      name: 'facility-forest-fern',
      color: palette.fern,
      roughness: 0.84,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    grass: new THREE.MeshStandardMaterial({
      name: 'facility-forest-grass',
      color: palette.grass,
      emissive: palette.grass,
      emissiveIntensity: 0.035,
      roughness: 0.88,
      metalness: 0,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
    wetRock: new THREE.MeshPhysicalMaterial({
      name: 'facility-wet-rock',
      color: palette.wetRock,
      metalness: 0.08,
      roughness: 0.43,
      clearcoat: 0.82,
      clearcoatRoughness: 0.16,
      vertexColors: true,
    }),
    lichen: new THREE.MeshStandardMaterial({
      name: 'facility-rock-lichen',
      color: palette.lichen,
      roughness: 0.96,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    cable: new THREE.MeshStandardMaterial({
      name: 'facility-rubber-cable',
      color: 0x080c0d,
      metalness: 0.18,
      roughness: 0.54,
    }),
    emissive: new THREE.MeshStandardMaterial({
      name: 'facility-emissive-cyan',
      color: palette.emissive,
      emissive: palette.emissive,
      emissiveIntensity,
      roughness: 0.22,
      metalness: 0.08,
      toneMapped: false,
    }),
  };
};

export const disposeFacilityMaterialKit = (kit: FacilityMaterialKit): void => {
  const textures = new Set<THREE.Texture>();
  for (const material of Object.values(kit)) {
    for (const texture of [material.map, material.normalMap, material.roughnessMap]) {
      if (texture) textures.add(texture);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
};

export interface ScatterBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CircularScatterExclusion {
  x: number;
  z: number;
  radius: number;
}

export interface RectangularScatterExclusion extends ScatterBounds {
  padding?: number;
}

export type ScatterExclusion = CircularScatterExclusion | RectangularScatterExclusion;

export type GroundHeightSampler = (x: number, z: number) => number;
export type ScatterDensitySampler = (x: number, z: number) => number;

interface ScatterPoint {
  x: number;
  y: number;
  z: number;
  random: number;
}

const validateBounds = (bounds: ScatterBounds): void => {
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ)) {
    throw new RangeError('Scatter bounds need max values greater than min values.');
  }
};

const isExcluded = (x: number, z: number, exclusions: readonly ScatterExclusion[]): boolean =>
  exclusions.some((exclusion) => {
    if ('radius' in exclusion) {
      const dx = x - exclusion.x;
      const dz = z - exclusion.z;
      return dx * dx + dz * dz < exclusion.radius * exclusion.radius;
    }
    const padding = exclusion.padding ?? 0;
    return (
      x >= exclusion.minX - padding &&
      x <= exclusion.maxX + padding &&
      z >= exclusion.minZ - padding &&
      z <= exclusion.maxZ + padding
    );
  });

const scatterPoints = (
  count: number,
  bounds: ScatterBounds,
  random: () => number,
  heightAt: GroundHeightSampler,
  exclusions: readonly ScatterExclusion[],
  densityAt?: ScatterDensitySampler,
): ScatterPoint[] => {
  validateBounds(bounds);
  const safeCount = clampInteger(count, 0, 100_000);
  const points: ScatterPoint[] = [];
  const attemptLimit = Math.max(24, safeCount * 18);

  for (let attempt = 0; attempt < attemptLimit && points.length < safeCount; attempt += 1) {
    const x = THREE.MathUtils.lerp(bounds.minX, bounds.maxX, random());
    const z = THREE.MathUtils.lerp(bounds.minZ, bounds.maxZ, random());
    if (isExcluded(x, z, exclusions)) continue;
    if (densityAt && random() > THREE.MathUtils.clamp(densityAt(x, z), 0, 1)) continue;
    const y = heightAt(x, z);
    if (!Number.isFinite(y)) continue;
    points.push({ x, y, z, random: random() });
  }
  return points;
};

const composeMatrix = (
  position: THREE.Vector3,
  rotation: THREE.Euler,
  scale: THREE.Vector3,
  target = new THREE.Matrix4(),
): THREE.Matrix4 => target.compose(position, new THREE.Quaternion().setFromEuler(rotation), scale);

const createBentTrunkGeometry = (): THREE.BufferGeometry => {
  const radialSegments = 7;
  const rings = 7;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const radius = THREE.MathUtils.lerp(0.09, 0.027, Math.pow(t, 0.72));
    const centerX = Math.sin(t * 2.6) * 0.025 * t;
    const centerZ = Math.sin(t * 3.4 + 0.8) * 0.018 * t;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = (segment / radialSegments) * TAU;
      positions.push(
        centerX + Math.cos(angle) * radius,
        t,
        centerZ + Math.sin(angle) * radius,
      );
    }
  }

  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const lower = ring * radialSegments + segment;
      const lowerNext = ring * radialSegments + next;
      const upper = (ring + 1) * radialSegments + segment;
      const upperNext = (ring + 1) * radialSegments + next;
      indices.push(lower, lowerNext, upperNext, lower, upperNext, upper);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const setInstanceColor = (
  mesh: THREE.InstancedMesh,
  index: number,
  lightnessOffset: number,
): void => {
  // Instance colors multiply the base material color. A neutral grey preserves
  // custom palettes while still producing natural per-instance value shifts.
  const value = THREE.MathUtils.clamp(1 + lightnessOffset, 0.72, 1.18);
  mesh.setColorAt(index, new THREE.Color().setRGB(value, value, value));
};

export interface TallTreeGroveOptions {
  seed: number;
  bounds: ScatterBounds;
  materials: FacilityMaterialKit;
  /** Target tree count before exclusions and density rejection. */
  count?: number;
  /** World-space minimum and maximum trunk height. */
  heightRange?: readonly [number, number];
  /** Samples terrain height. Defaults to a flat plane at y=0. */
  heightAt?: GroundHeightSampler;
  /** Circular or rectangular no-grow zones for paths, buildings and combat lanes. */
  exclusions?: readonly ScatterExclusion[];
  /** Optional 0..1 probability field used to form natural forest islands. */
  densityAt?: ScatterDensitySampler;
  castShadow?: boolean;
}

/**
 * Builds a sparse high canopy from three draw-call-friendly instanced layers:
 * bent trunks, angled branches and faceted crown clusters.
 */
export const createTallTreeGrove = (options: TallTreeGroveOptions): THREE.Group => {
  const random = seededRandom(options.seed);
  const heightRange = options.heightRange ?? [8.5, 15.5];
  requirePositive(heightRange[0], 'Minimum tree height');
  if (heightRange[1] < heightRange[0]) throw new RangeError('Tree height range is inverted.');
  const points = scatterPoints(
    options.count ?? 28,
    options.bounds,
    random,
    options.heightAt ?? (() => 0),
    options.exclusions ?? [],
    options.densityAt,
  );
  const castShadow = options.castShadow ?? true;
  const grove = new THREE.Group();
  grove.name = `tall-tree-grove-${Math.trunc(options.seed)}`;

  const treeRecords = points.map((point) => ({
    ...point,
    height: THREE.MathUtils.lerp(heightRange[0], heightRange[1], 0.2 + point.random * 0.8),
    width: THREE.MathUtils.lerp(0.76, 1.28, random()),
    rotation: random() * TAU,
    leanX: (random() - 0.5) * 0.075,
    leanZ: (random() - 0.5) * 0.075,
    branchCount: 2 + Math.floor(random() * 3),
    crownCount: 3 + Math.floor(random() * 3),
  }));
  const totalBranches = treeRecords.reduce((sum, tree) => sum + tree.branchCount, 0);
  const totalCrowns = treeRecords.reduce((sum, tree) => sum + tree.crownCount, 0);

  const trunks = new THREE.InstancedMesh(
    createBentTrunkGeometry(),
    options.materials.bark,
    treeRecords.length,
  );
  trunks.name = 'tree-trunks';
  trunks.castShadow = castShadow;
  trunks.receiveShadow = true;
  const branchGeometry = new THREE.CylinderGeometry(0.022, 0.045, 1, 5, 1, false);
  const branches = new THREE.InstancedMesh(branchGeometry, options.materials.bark, totalBranches);
  branches.name = 'tree-branches';
  branches.castShadow = castShadow;
  branches.receiveShadow = true;

  const crownGeometry = new THREE.IcosahedronGeometry(0.5, 2);
  const crowns = new THREE.InstancedMesh(crownGeometry, options.materials.canopy, totalCrowns);
  crowns.name = 'tree-crowns';
  crowns.castShadow = castShadow;
  crowns.receiveShadow = true;
  let branchIndex = 0;
  let crownIndex = 0;
  treeRecords.forEach((tree, treeIndex) => {
    const position = new THREE.Vector3(tree.x, tree.y, tree.z);
    const rotation = new THREE.Euler(tree.leanZ, tree.rotation, tree.leanX);
    const scale = new THREE.Vector3(tree.width, tree.height, tree.width);
    trunks.setMatrixAt(treeIndex, composeMatrix(position, rotation, scale));
    setInstanceColor(trunks, treeIndex, (random() - 0.5) * 0.055);

    for (let local = 0; local < tree.branchCount; local += 1) {
      const angle = tree.rotation + (local / tree.branchCount) * TAU + (random() - 0.5) * 0.7;
      const baseHeight = tree.height * (0.62 + random() * 0.25);
      const length = tree.height * (0.16 + random() * 0.12);
      const start = new THREE.Vector3(tree.x, tree.y + baseHeight, tree.z);
      const end = start.clone().add(
        new THREE.Vector3(
          Math.cos(angle) * length,
          length * (0.1 + random() * 0.25),
          Math.sin(angle) * length,
        ),
      );
      const direction = end.clone().sub(start);
      const midpoint = start.clone().add(end).multiplyScalar(0.5);
      const quaternion = new THREE.Quaternion().setFromUnitVectors(UP, direction.clone().normalize());
      const radius = tree.width * THREE.MathUtils.lerp(0.65, 1.05, random());
      branches.setMatrixAt(
        branchIndex,
        new THREE.Matrix4().compose(midpoint, quaternion, new THREE.Vector3(radius, direction.length(), radius)),
      );
      setInstanceColor(branches, branchIndex, (random() - 0.5) * 0.05);
      branchIndex += 1;
    }

    for (let local = 0; local < tree.crownCount; local += 1) {
      const angle = tree.rotation + (local / tree.crownCount) * TAU + random() * 0.4;
      const radial = local === 0 ? 0 : tree.height * (0.06 + random() * 0.08);
      const crownPosition = new THREE.Vector3(
        tree.x + Math.cos(angle) * radial,
        tree.y + tree.height * (0.82 + random() * 0.14),
        tree.z + Math.sin(angle) * radial,
      );
      const crownWidth = tree.height * (0.16 + random() * 0.08);
      crowns.setMatrixAt(
        crownIndex,
        composeMatrix(
          crownPosition,
          new THREE.Euler((random() - 0.5) * 0.22, random() * TAU, (random() - 0.5) * 0.18),
          new THREE.Vector3(
            crownWidth * (0.85 + random() * 0.3),
            crownWidth * (0.52 + random() * 0.26),
            crownWidth * (0.8 + random() * 0.38),
          ),
        ),
      );
      setInstanceColor(crowns, crownIndex, (random() - 0.5) * 0.08);
      crownIndex += 1;
    }
  });

  for (const mesh of [trunks, branches, crowns]) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    grove.add(mesh);
  }
  grove.userData.seed = options.seed;
  grove.userData.treeCount = treeRecords.length;
  grove.userData.instanceCount = treeRecords.length + totalBranches + totalCrowns;
  return grove;
};

const createFernFrondGeometry = (): THREE.BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];
  const segments = 7;

  // A tapered rachis with alternating pointed leaflets. It lies along +Z and curls upward.
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const z = t;
    const y = Math.sin(t * Math.PI * 0.7) * 0.2;
    const width = 0.022 * (1 - t * 0.65);
    positions.push(-width, y, z, width, y, z);
    if (index < segments) {
      const base = index * 2;
      indices.push(base, base + 2, base + 3, base, base + 3, base + 1);
    }
  }

  for (let index = 1; index < segments; index += 1) {
    const t = index / segments;
    const z = t;
    const y = Math.sin(t * Math.PI * 0.7) * 0.2;
    if (index > 0 && index < segments) {
      const leafletWidth = Math.sin(Math.PI * t) * 0.23 * (1 - t * 0.22);
      const leafletLength = 0.13 + (1 - t) * 0.08;
      const center = positions.length / 3;
      positions.push(
        0, y + 0.002, z,
        -leafletWidth, y + 0.018, z - leafletLength * 0.28,
        -leafletWidth * 0.12, y + 0.026, z + leafletLength,
        0, y + 0.002, z,
        leafletWidth, y + 0.018, z - leafletLength * 0.28,
        leafletWidth * 0.12, y + 0.026, z + leafletLength,
      );
      indices.push(center, center + 1, center + 2, center + 3, center + 5, center + 4);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const createGrassTuftGeometry = (): THREE.BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];
  const blades = 9;
  for (let blade = 0; blade < blades; blade += 1) {
    // An intentionally irregular crown reads as continuous lawn instead of a
    // field of identical black starbursts at grazing camera angles.
    const angle = (blade / blades) * TAU + Math.sin(blade * 4.17) * 0.18;
    const width = 0.018 + (blade % 4) * 0.0045;
    const height = 0.36 + (blade % 5) * 0.052 + Math.sin(blade * 2.31) * 0.025;
    const bend = 0.075 + (blade % 4) * 0.021;
    const rightX = Math.cos(angle) * width;
    const rightZ = Math.sin(angle) * width;
    const bendX = Math.sin(angle) * bend;
    const bendZ = -Math.cos(angle) * bend;
    const offset = positions.length / 3;
    positions.push(
      -rightX, 0, -rightZ,
      rightX, 0, rightZ,
      rightX * 0.45 + bendX * 0.4, height * 0.58, rightZ * 0.45 + bendZ * 0.4,
      bendX, height, bendZ,
    );
    indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

export interface UnderstoryFieldOptions {
  seed: number;
  bounds: ScatterBounds;
  materials: FacilityMaterialKit;
  /** Number of fern crowns; each crown expands to 5-9 instanced fronds. */
  fernCount?: number;
  /** Number of multi-blade grass tuft instances. */
  grassCount?: number;
  heightAt?: GroundHeightSampler;
  exclusions?: readonly ScatterExclusion[];
  densityAt?: ScatterDensitySampler;
  castShadow?: boolean;
}

/** Creates dense fern and grass layers using two InstancedMesh draw calls. */
export const createUnderstoryField = (options: UnderstoryFieldOptions): THREE.Group => {
  const random = seededRandom(options.seed);
  const heightAt = options.heightAt ?? (() => 0);
  const exclusions = options.exclusions ?? [];
  const fernCenters = scatterPoints(
    options.fernCount ?? 180,
    options.bounds,
    random,
    heightAt,
    exclusions,
    options.densityAt,
  );
  const grassPoints = scatterPoints(
    options.grassCount ?? 360,
    options.bounds,
    random,
    heightAt,
    exclusions,
    options.densityAt,
  );
  const fernRecords: Array<{ position: THREE.Vector3; rotation: number; size: number; tilt: number }> = [];

  for (const center of fernCenters) {
    const frondCount = 5 + Math.floor(random() * 5);
    const crownSize = 0.58 + random() * 0.78;
    for (let frond = 0; frond < frondCount; frond += 1) {
      const angle = (frond / frondCount) * TAU + (random() - 0.5) * 0.32;
      const radius = random() * crownSize * 0.18;
      fernRecords.push({
        position: new THREE.Vector3(
          center.x + Math.cos(angle) * radius,
          center.y + 0.018,
          center.z + Math.sin(angle) * radius,
        ),
        rotation: angle,
        size: crownSize * (0.72 + random() * 0.48),
        tilt: (random() - 0.5) * 0.11,
      });
    }
  }

  const field = new THREE.Group();
  field.name = `understory-field-${Math.trunc(options.seed)}`;
  const castShadow = options.castShadow ?? true;
  const ferns = new THREE.InstancedMesh(createFernFrondGeometry(), options.materials.fern, fernRecords.length);
  ferns.name = 'fern-fronds';
  ferns.castShadow = castShadow;
  ferns.receiveShadow = true;
  fernRecords.forEach((record, index) => {
    ferns.setMatrixAt(
      index,
      composeMatrix(
        record.position,
        new THREE.Euler(record.tilt, record.rotation, 0),
        new THREE.Vector3(record.size, record.size, record.size),
      ),
    );
    setInstanceColor(ferns, index, (random() - 0.48) * 0.13);
  });

  const grasses = new THREE.InstancedMesh(
    createGrassTuftGeometry(),
    options.materials.grass,
    grassPoints.length,
  );
  grasses.name = 'grass-tufts';
  grasses.castShadow = castShadow;
  grasses.receiveShadow = true;
  grassPoints.forEach((point, index) => {
    const size = 0.48 + random() * 0.62;
    grasses.setMatrixAt(
      index,
      composeMatrix(
        new THREE.Vector3(point.x, point.y + 0.01, point.z),
        new THREE.Euler((random() - 0.5) * 0.08, random() * TAU, (random() - 0.5) * 0.08),
        new THREE.Vector3(size * (0.75 + random() * 0.45), size, size * (0.75 + random() * 0.45)),
      ),
    );
    setInstanceColor(grasses, index, (random() - 0.45) * 0.16);
  });

  for (const mesh of [ferns, grasses]) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    field.add(mesh);
  }
  field.userData.seed = options.seed;
  field.userData.fernCrownCount = fernCenters.length;
  field.userData.fernFrondCount = fernRecords.length;
  field.userData.grassCount = grassPoints.length;
  return field;
};

const createWeatheredRockGeometry = (seed: number): THREE.BufferGeometry => {
  const random = seededRandom(seed);
  const geometry = new THREE.IcosahedronGeometry(1, 2).toNonIndexed();
  const position = geometry.getAttribute('position');
  const vertex = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index);
    const vertical = vertex.y * 0.5 + 0.5;
    const angular = Math.sin(Math.atan2(vertex.z, vertex.x) * 5 + seed) * 0.055;
    const scale = 0.82 + random() * 0.24 + angular - vertical * 0.035;
    vertex.multiplyScalar(scale);
    vertex.y *= 0.7;
    if (vertex.y < -0.38) vertex.y = -0.38;
    position.setXYZ(index, vertex.x, vertex.y, vertex.z);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

export interface WetRockFieldOptions {
  seed: number;
  bounds: ScatterBounds;
  materials: FacilityMaterialKit;
  count?: number;
  /** Horizontal world-space radius range. */
  radiusRange?: readonly [number, number];
  heightAt?: GroundHeightSampler;
  exclusions?: readonly ScatterExclusion[];
  densityAt?: ScatterDensitySampler;
  castShadow?: boolean;
}

/** Builds three deterministic instanced rock variants plus sparse lichen caps. */
export const createWetRockField = (options: WetRockFieldOptions): THREE.Group => {
  const random = seededRandom(options.seed);
  const radiusRange = options.radiusRange ?? [0.45, 1.7];
  requirePositive(radiusRange[0], 'Minimum rock radius');
  if (radiusRange[1] < radiusRange[0]) throw new RangeError('Rock radius range is inverted.');
  const points = scatterPoints(
    options.count ?? 42,
    options.bounds,
    random,
    options.heightAt ?? (() => 0),
    options.exclusions ?? [],
    options.densityAt,
  );
  const records = points.map((point, index) => ({
    point,
    variant: index % 3,
    radius: THREE.MathUtils.lerp(radiusRange[0], radiusRange[1], Math.pow(random(), 1.7)),
    rotation: new THREE.Euler((random() - 0.5) * 0.3, random() * TAU, (random() - 0.5) * 0.25),
    stretch: new THREE.Vector3(0.72 + random() * 0.65, 0.62 + random() * 0.72, 0.72 + random() * 0.65),
  }));
  const field = new THREE.Group();
  field.name = `wet-rock-field-${Math.trunc(options.seed)}`;
  const castShadow = options.castShadow ?? true;

  for (let variant = 0; variant < 3; variant += 1) {
    const variantRecords = records.filter((record) => record.variant === variant);
    if (variantRecords.length === 0) continue;
    const rocks = new THREE.InstancedMesh(
      createWeatheredRockGeometry(options.seed + variant * 101),
      options.materials.wetRock,
      variantRecords.length,
    );
    rocks.name = `wet-rocks-variant-${variant}`;
    rocks.castShadow = castShadow;
    rocks.receiveShadow = true;
    variantRecords.forEach((record, index) => {
      const position = new THREE.Vector3(
        record.point.x,
        record.point.y + record.radius * 0.25,
        record.point.z,
      );
      rocks.setMatrixAt(
        index,
        composeMatrix(
          position,
          record.rotation,
          record.stretch.clone().multiplyScalar(record.radius),
        ),
      );
      setInstanceColor(rocks, index, (random() - 0.5) * 0.11);
    });
    rocks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingBox();
    rocks.computeBoundingSphere();
    field.add(rocks);
  }

  const lichenGeometry = new THREE.CircleGeometry(1, 7);
  lichenGeometry.rotateX(-Math.PI / 2);
  const lichenRecords = records.filter(() => random() > 0.5);
  const lichen = new THREE.InstancedMesh(lichenGeometry, options.materials.lichen, lichenRecords.length);
  lichen.name = 'rock-lichen-caps';
  lichen.receiveShadow = true;
  lichenRecords.forEach((record, index) => {
    lichen.setMatrixAt(
      index,
      composeMatrix(
        new THREE.Vector3(
          record.point.x + (random() - 0.5) * record.radius * 0.35,
          record.point.y + record.radius * record.stretch.y * 0.7 + 0.015,
          record.point.z + (random() - 0.5) * record.radius * 0.35,
        ),
        new THREE.Euler(0, random() * TAU, 0),
        new THREE.Vector3(record.radius * 0.18, record.radius * 0.18, record.radius * 0.18),
      ),
    );
  });
  lichen.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  lichen.computeBoundingBox();
  lichen.computeBoundingSphere();
  field.add(lichen);
  field.userData.seed = options.seed;
  field.userData.rockCount = records.length;
  return field;
};

const addBox = (
  parent: THREE.Object3D,
  name: string,
  size: THREE.Vector3,
  position: THREE.Vector3,
  material: THREE.Material,
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
  mesh.name = name;
  mesh.position.copy(position);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  parent.add(mesh);
  return mesh;
};

export type FacilitySignStyle = 'sector' | 'warning' | 'wayfinding';

export interface FacilitySignTextureOptions {
  seed: number;
  text: string;
  secondaryText?: string;
  style?: FacilitySignStyle;
  width?: number;
  height?: number;
  background?: string;
  foreground?: string;
  accent?: string;
}

/**
 * Generates a crisp procedural sign with sector code, microtype, registration
 * marks and optional hazard striping. The texture requires a browser Canvas API.
 */
export const createFacilitySignTexture = (
  options: FacilitySignTextureOptions,
): THREE.CanvasTexture => {
  const width = clampInteger(options.width ?? 1024, 256, 2048);
  const height = clampInteger(options.height ?? 384, 128, 1024);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create a 2D context for facility signage.');
  const style = options.style ?? 'sector';
  const background = options.background ?? (style === 'warning' ? '#c9ef3e' : '#e8eeea');
  const foreground = options.foreground ?? '#0a1217';
  const accent = options.accent ?? '#9bdc36';
  const random = seededRandom(options.seed);

  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = foreground;
  context.fillRect(0, 0, width, height * 0.08);
  context.fillRect(0, height * 0.92, width, height * 0.08);
  context.fillStyle = accent;
  context.fillRect(width * 0.035, height * 0.12, width * 0.014, height * 0.68);

  if (style === 'warning') {
    context.save();
    context.beginPath();
    context.rect(width * 0.72, 0, width * 0.28, height);
    context.clip();
    context.strokeStyle = foreground;
    context.lineWidth = width * 0.035;
    for (let x = width * 0.55; x < width * 1.25; x += width * 0.075) {
      context.beginPath();
      context.moveTo(x, height);
      context.lineTo(x + height, 0);
      context.stroke();
    }
    context.restore();
  }

  context.textBaseline = 'middle';
  context.fillStyle = foreground;
  context.font = `700 ${Math.round(height * 0.33)}px "Arial Narrow", "Helvetica Neue", sans-serif`;
  context.fillText(options.text.toUpperCase(), width * 0.085, height * 0.47, width * 0.59);
  context.font = `600 ${Math.round(height * 0.09)}px ui-monospace, SFMono-Regular, monospace`;
  const secondary = options.secondaryText ?? `AEE // ${Math.floor(random() * 90 + 10)}.${Math.floor(random() * 900 + 100)}`;
  context.fillText(secondary.toUpperCase(), width * 0.088, height * 0.75, width * 0.56);

  context.lineWidth = Math.max(2, width * 0.0035);
  context.strokeStyle = foreground;
  const mark = width * 0.025;
  for (const [x, y] of [
    [width * 0.02, height * 0.15],
    [width * 0.98, height * 0.15],
    [width * 0.02, height * 0.85],
    [width * 0.98, height * 0.85],
  ] as const) {
    context.beginPath();
    context.moveTo(x - mark, y);
    context.lineTo(x + mark, y);
    context.moveTo(x, y - mark);
    context.lineTo(x, y + mark);
    context.stroke();
  }

  context.globalAlpha = 0.2;
  context.lineWidth = 1;
  for (let line = 0; line < 16; line += 1) {
    const y = height * (0.12 + line * 0.048);
    context.beginPath();
    context.moveTo(width * 0.68, y);
    context.lineTo(width * (0.7 + random() * 0.24), y);
    context.stroke();
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = `facility-sign-${options.text.toLowerCase().replace(/\s+/g, '-')}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
};

export interface FacilitySignOptions extends FacilitySignTextureOptions {
  worldWidth?: number;
  worldHeight?: number;
}

/** Creates a +Z-facing PBR sign plane. Offset it 1-2 cm from its host surface. */
export const createFacilitySign = (options: FacilitySignOptions): THREE.Mesh => {
  const worldWidth = options.worldWidth ?? 2.8;
  const worldHeight = options.worldHeight ?? 0.9;
  requirePositive(worldWidth, 'Sign width');
  requirePositive(worldHeight, 'Sign height');
  const texture = createFacilitySignTexture(options);
  const material = new THREE.MeshStandardMaterial({
    name: `facility-sign-material-${options.text}`,
    map: texture,
    roughness: 0.46,
    metalness: 0.12,
    side: THREE.FrontSide,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldHeight), material);
  sign.name = `facility-sign-${options.text}`;
  sign.receiveShadow = true;
  sign.userData.ownsMaterial = true;
  return sign;
};

export interface FacilityBlockOptions {
  seed: number;
  materials: FacilityMaterialKit;
  width: number;
  height: number;
  depth: number;
  /** Approximate facade bay width; clamped to 2-12 bays. */
  panelWidth?: number;
  label?: string;
  secondaryLabel?: string;
  windowBand?: boolean;
  roofEquipment?: boolean;
  castShadow?: boolean;
}

/**
 * Creates a centered sci-fi facility block whose base rests at y=0. The dark
 * structural core remains visible through real facade gaps for convincing depth.
 */
export const createFacilityBlock = (options: FacilityBlockOptions): THREE.Group => {
  requirePositive(options.width, 'Facility width');
  requirePositive(options.height, 'Facility height');
  requirePositive(options.depth, 'Facility depth');
  const random = seededRandom(options.seed);
  const castShadow = options.castShadow ?? true;
  const group = new THREE.Group();
  group.name = `facility-block-${Math.trunc(options.seed)}`;
  const width = options.width;
  const height = options.height;
  const depth = options.depth;
  const skin = Math.min(0.13, Math.min(width, depth) * 0.025);
  const panelPalette = [
    options.materials.panelLight,
    options.materials.panelSage,
    options.materials.panelBlue,
  ] as const;
  const styleIndex = Math.abs(Math.trunc(options.seed)) % panelPalette.length;
  // The facility's architectural identity is pale ceramic. Sage and blue are
  // retained as secondary service coatings instead of darkening whole facade
  // bays, so different blocks remain varied without losing the bright base.
  const primaryPanel = options.materials.panelLight;
  const secondaryPanel = styleIndex === 0
    ? options.materials.panelLight
    : panelPalette[styleIndex]!;
  const signalAccent = styleIndex === 0
    ? options.materials.accent
    : styleIndex === 1
      ? options.materials.accentOrange
      : options.materials.accentBlue;

  addBox(
    group,
    'structural-core',
    new THREE.Vector3(width * 0.96, height * 0.94, depth * 0.96),
    new THREE.Vector3(0, height * 0.49, 0),
    options.materials.structural,
    castShadow,
  );
  addBox(
    group,
    'dark-foundation',
    new THREE.Vector3(width * 1.035, height * 0.12, depth * 1.035),
    new THREE.Vector3(0, height * 0.06, 0),
    options.materials.panelDark,
    castShadow,
  );

  const bayCount = clampInteger(width / (options.panelWidth ?? 2.2), 2, 12);
  const bayWidth = width / bayCount;
  const lowerHeight = height * 0.5;
  const upperHeight = height * 0.26;
  const windowBand = options.windowBand ?? true;
  for (const side of [-1, 1] as const) {
    for (let bay = 0; bay < bayCount; bay += 1) {
      const x = -width * 0.5 + bayWidth * (bay + 0.5);
      const panelMaterial = bay % 5 === (side > 0 ? 3 : 1) ? signalAccent : primaryPanel;
      addBox(
        group,
        `facade-${side > 0 ? 'front' : 'back'}-lower-${bay}`,
        new THREE.Vector3(bayWidth - skin * 0.45, lowerHeight, skin),
        new THREE.Vector3(x, height * 0.12 + lowerHeight * 0.5, side * (depth * 0.5 + skin * 0.5)),
        panelMaterial,
        castShadow,
      );
      addBox(
        group,
        `facade-${side > 0 ? 'front' : 'back'}-upper-${bay}`,
        new THREE.Vector3(bayWidth - skin * 0.45, upperHeight, skin),
        new THREE.Vector3(x, height * 0.72 + upperHeight * 0.5, side * (depth * 0.5 + skin * 0.5)),
        bay % 4 === 0 ? options.materials.panelDark : secondaryPanel,
        castShadow,
      );
    }
    if (windowBand) {
      addBox(
        group,
        `continuous-window-${side > 0 ? 'front' : 'back'}`,
        new THREE.Vector3(width * 0.89, height * 0.16, skin * 0.75),
        new THREE.Vector3(0, height * 0.63, side * (depth * 0.5 + skin * 1.12)),
        options.materials.glass,
        false,
      );
    }
  }

  const sideBayCount = clampInteger(depth / (options.panelWidth ?? 2.2), 2, 10);
  const sideBayDepth = depth / sideBayCount;
  for (const side of [-1, 1] as const) {
    for (let bay = 0; bay < sideBayCount; bay += 1) {
      const z = -depth * 0.5 + sideBayDepth * (bay + 0.5);
      addBox(
        group,
        `side-panel-${side > 0 ? 'east' : 'west'}-${bay}`,
        new THREE.Vector3(skin, height * 0.76, sideBayDepth - skin * 0.45),
        new THREE.Vector3(side * (width * 0.5 + skin * 0.5), height * 0.5, z),
        bay === sideBayCount - 1 ? signalAccent : primaryPanel,
        castShadow,
      );
    }
  }

  for (const x of [-1, 1] as const) {
    for (const z of [-1, 1] as const) {
      addBox(
        group,
        `corner-column-${x}-${z}`,
        new THREE.Vector3(skin * 2.8, height * 1.02, skin * 2.8),
        new THREE.Vector3(x * width * 0.5, height * 0.51, z * depth * 0.5),
        options.materials.panelDark,
        castShadow,
      );
    }
  }
  addBox(
    group,
    'lime-roof-fascia',
    new THREE.Vector3(width * 1.045, height * 0.075, depth * 1.045),
    new THREE.Vector3(0, height * 0.93, 0),
    signalAccent,
    castShadow,
  );
  addBox(
    group,
    'roof-cap',
    new THREE.Vector3(width * 1.015, height * 0.07, depth * 1.015),
    new THREE.Vector3(0, height + height * 0.035, 0),
    secondaryPanel,
    castShadow,
  );

  if (options.roofEquipment ?? true) {
    const equipmentCount = clampInteger(width / 3.5, 1, 4);
    for (let index = 0; index < equipmentCount; index += 1) {
      const equipmentWidth = width * (0.09 + random() * 0.05);
      const equipmentHeight = height * (0.08 + random() * 0.08);
      addBox(
        group,
        `roof-equipment-${index}`,
        new THREE.Vector3(equipmentWidth, equipmentHeight, depth * (0.12 + random() * 0.08)),
        new THREE.Vector3(
          THREE.MathUtils.lerp(-width * 0.34, width * 0.34, equipmentCount === 1 ? 0.5 : index / (equipmentCount - 1)),
          height + equipmentHeight * 0.5 + height * 0.075,
          (random() - 0.5) * depth * 0.42,
        ),
        index % 2 === 0 ? options.materials.panelDark : options.materials.structural,
        castShadow,
      );
    }
  }

  // A recessed door and luminous access strip establish human scale.
  addBox(
    group,
    'access-door',
    new THREE.Vector3(Math.min(1.5, width * 0.18), Math.min(2.7, height * 0.5), skin * 0.8),
    new THREE.Vector3(0, Math.min(2.7, height * 0.5) * 0.5 + height * 0.12, depth * 0.5 + skin * 1.15),
    options.materials.panelDark,
    castShadow,
  );
  addBox(
    group,
    'access-light',
    new THREE.Vector3(0.055, Math.min(1.8, height * 0.3), skin * 0.35),
    new THREE.Vector3(Math.min(0.95, width * 0.13), height * 0.39, depth * 0.5 + skin * 1.65),
    options.materials.emissive,
    false,
    false,
  );

  if (options.label && typeof document !== 'undefined') {
    const sign = createFacilitySign({
      seed: options.seed,
      text: options.label,
      secondaryText: options.secondaryLabel,
      style: 'sector',
      worldWidth: Math.min(width * 0.42, 3.4),
      worldHeight: Math.min(height * 0.16, 0.92),
    });
    sign.position.set(-width * 0.24, height * 0.81, depth * 0.5 + skin * 1.72);
    group.add(sign);
  }
  group.userData.seed = options.seed;
  group.userData.bounds = { width, height, depth };
  group.userData.facadeStyle = ['ceramic', 'sage-alloy', 'desaturated-blue'][styleIndex];
  return group;
};

export type FacilityPoint = THREE.Vector3 | readonly [number, number, number];

const toVector3 = (value: FacilityPoint): THREE.Vector3 =>
  value instanceof THREE.Vector3 ? value.clone() : new THREE.Vector3(value[0], value[1], value[2]);

const createCylinderBetween = (
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  radialSegments = 8,
): THREE.Mesh => {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, Math.max(length, 0.0001), radialSegments, 1, false),
    material,
  );
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  if (length > 0.0001) mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

export interface SuspendedCableOptions {
  start: FacilityPoint;
  end: FacilityPoint;
  material: THREE.Material;
  /** Downward catenary approximation in world units. */
  sag?: number;
  radius?: number;
  tubularSegments?: number;
  radialSegments?: number;
}

/** Creates a smooth catenary-like TubeGeometry between arbitrary 3D points. */
export const createSuspendedCable = (options: SuspendedCableOptions): THREE.Mesh => {
  const start = toVector3(options.start);
  const end = toVector3(options.end);
  const distance = start.distanceTo(end);
  requirePositive(distance, 'Cable length');
  const sag = Math.max(0, options.sag ?? Math.min(distance * 0.055, 0.6));
  const points: THREE.Vector3[] = [];
  for (let index = 0; index <= 4; index += 1) {
    const t = index / 4;
    const point = start.clone().lerp(end, t);
    point.y -= Math.sin(t * Math.PI) * sag;
    points.push(point);
  }
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(
      curve,
      clampInteger(options.tubularSegments ?? Math.ceil(distance * 5), 8, 160),
      options.radius ?? 0.025,
      clampInteger(options.radialSegments ?? 6, 4, 12),
      false,
    ),
    options.material,
  );
  cable.name = 'suspended-utility-cable';
  cable.castShadow = true;
  cable.receiveShadow = true;
  cable.userData.length = distance;
  cable.userData.sag = sag;
  return cable;
};

export interface FacilityRailOptions {
  start: FacilityPoint;
  end: FacilityPoint;
  materials: FacilityMaterialKit;
  /** Rail height above each endpoint. */
  height?: number;
  postSpacing?: number;
  postRadius?: number;
  /** Adds one gently sagging cable below the rigid handrail. */
  lowerCable?: boolean;
}

/** Builds a rigid gunmetal handrail with lime collars and an optional lower cable. */
export const createFacilityRail = (options: FacilityRailOptions): THREE.Group => {
  const start = toVector3(options.start);
  const end = toVector3(options.end);
  const distance = start.distanceTo(end);
  requirePositive(distance, 'Rail length');
  const height = options.height ?? 0.92;
  const spacing = options.postSpacing ?? 1.65;
  const radius = options.postRadius ?? 0.035;
  requirePositive(height, 'Rail height');
  requirePositive(spacing, 'Rail post spacing');
  requirePositive(radius, 'Rail post radius');
  const postCount = Math.max(2, Math.ceil(distance / spacing) + 1);
  const group = new THREE.Group();
  group.name = 'facility-safety-rail';

  for (let index = 0; index < postCount; index += 1) {
    const t = index / (postCount - 1);
    const base = start.clone().lerp(end, t);
    const top = base.clone().addScaledVector(UP, height);
    const post = createCylinderBetween(base, top, radius, options.materials.structural, 7);
    post.name = `rail-post-${index}`;
    group.add(post);
    const collar = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.65, radius * 1.65, 0.065, 8),
      options.materials.accent,
    );
    collar.name = `rail-collar-${index}`;
    collar.position.copy(top).addScaledVector(UP, -0.055);
    collar.castShadow = true;
    group.add(collar);
  }

  const railStart = start.clone().addScaledVector(UP, height);
  const railEnd = end.clone().addScaledVector(UP, height);
  const handrail = createCylinderBetween(railStart, railEnd, radius * 1.25, options.materials.panelDark, 8);
  handrail.name = 'rail-handrail';
  group.add(handrail);

  if (options.lowerCable ?? true) {
    const cable = createSuspendedCable({
      start: start.clone().addScaledVector(UP, height * 0.48),
      end: end.clone().addScaledVector(UP, height * 0.48),
      material: options.materials.cable,
      sag: Math.min(0.12, distance * 0.018),
      radius: radius * 0.62,
    });
    cable.name = 'rail-lower-cable';
    group.add(cable);
  }
  group.userData.length = distance;
  group.userData.postCount = postCount;
  return group;
};

export interface FacilityBlockPlacement extends Omit<FacilityBlockOptions, 'materials'> {
  position: FacilityPoint;
  rotationY?: number;
}

export interface FacilityRailPlacement extends Omit<FacilityRailOptions, 'materials'> {}

export interface FacilityCablePlacement extends Omit<SuspendedCableOptions, 'material'> {}

export type EnvironmentQuality = 'low' | 'medium' | 'high';

export interface FacilityEnvironmentOptions {
  seed: number;
  bounds: ScatterBounds;
  materials?: FacilityMaterialKit;
  quality?: EnvironmentQuality;
  heightAt?: GroundHeightSampler;
  exclusions?: readonly ScatterExclusion[];
  densityAt?: ScatterDensitySampler;
  vegetation?: boolean;
  rocks?: boolean;
  blocks?: readonly FacilityBlockPlacement[];
  rails?: readonly FacilityRailPlacement[];
  cables?: readonly FacilityCablePlacement[];
}

export interface FacilityEnvironmentBundle {
  group: THREE.Group;
  materials: FacilityMaterialKit;
  ownsMaterials: boolean;
  /** Disposes generated geometry, sign textures/materials, and an internally-created material kit. */
  dispose: () => void;
}

const qualityDensity = {
  low: { trees: 0.0022, ferns: 0.024, grass: 0.045, rocks: 0.004 },
  medium: { trees: 0.0042, ferns: 0.044, grass: 0.085, rocks: 0.006 },
  high: { trees: 0.0062, ferns: 0.068, grass: 0.135, rocks: 0.008 },
} satisfies Record<EnvironmentQuality, { trees: number; ferns: number; grass: number; rocks: number }>;

const materialSet = (kit: FacilityMaterialKit): Set<THREE.Material> =>
  new Set<THREE.Material>(Object.values(kit));

const disposeOwnedSceneResources = (
  root: THREE.Object3D,
  sharedMaterials: Set<THREE.Material>,
): void => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) {
      if (!sharedMaterials.has(material)) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    const withMap = material as THREE.Material & { map?: THREE.Texture | null };
    withMap.map?.dispose();
    material.dispose();
  }
};

/**
 * High-level composition helper. Counts scale with bounds area and quality;
 * explicit facility blocks, rails and cables are positioned by the caller.
 */
export const createFacilityEnvironment = (
  options: FacilityEnvironmentOptions,
): FacilityEnvironmentBundle => {
  validateBounds(options.bounds);
  const ownsMaterials = !options.materials;
  const materials = options.materials ?? createFacilityMaterialKit();
  const quality = options.quality ?? 'high';
  const density = qualityDensity[quality];
  const area = (options.bounds.maxX - options.bounds.minX) * (options.bounds.maxZ - options.bounds.minZ);
  const group = new THREE.Group();
  group.name = `facility-environment-${Math.trunc(options.seed)}`;
  const heightAt = options.heightAt ?? (() => 0);
  const exclusions = options.exclusions ?? [];

  if (options.vegetation ?? true) {
    group.add(
      createTallTreeGrove({
        seed: options.seed + 11,
        bounds: options.bounds,
        materials,
        count: Math.round(area * density.trees),
        heightAt,
        exclusions,
        densityAt: options.densityAt,
      }),
      createUnderstoryField({
        seed: options.seed + 23,
        bounds: options.bounds,
        materials,
        fernCount: Math.round(area * density.ferns),
        grassCount: Math.round(area * density.grass),
        heightAt,
        exclusions,
        densityAt: options.densityAt,
      }),
    );
  }
  if (options.rocks ?? true) {
    group.add(
      createWetRockField({
        seed: options.seed + 37,
        bounds: options.bounds,
        materials,
        count: Math.round(area * density.rocks),
        heightAt,
        exclusions,
        densityAt: options.densityAt,
      }),
    );
  }
  for (const blockOptions of options.blocks ?? []) {
    const block = createFacilityBlock({ ...blockOptions, materials });
    block.position.copy(toVector3(blockOptions.position));
    block.rotation.y = blockOptions.rotationY ?? 0;
    group.add(block);
  }
  for (const railOptions of options.rails ?? []) {
    group.add(createFacilityRail({ ...railOptions, materials }));
  }
  for (const cableOptions of options.cables ?? []) {
    group.add(createSuspendedCable({ ...cableOptions, material: materials.cable }));
  }

  group.userData.seed = options.seed;
  group.userData.quality = quality;
  let disposed = false;
  return {
    group,
    materials,
    ownsMaterials,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeOwnedSceneResources(group, materialSet(materials));
      if (ownsMaterials) disposeFacilityMaterialKit(materials);
      group.clear();
    },
  };
};
