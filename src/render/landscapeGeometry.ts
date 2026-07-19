import * as THREE from 'three';

const TAU = Math.PI * 2;

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

export interface LayeredRidgeOptions {
  seed: number;
  radius: number;
  height: number;
  material: THREE.Material | readonly THREE.Material[];
  /** Number of overlapping peaks used to form the silhouette. */
  layers?: number;
  /** Facet count per peak. Low values preserve the graphic style. */
  radialSegments?: number;
  /** Z compression. Values below one make the massif read as a ridge. */
  flattening?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

interface PeakGeometryOptions {
  radius: number;
  height: number;
  radialSegments: number;
  flattening: number;
  leanX: number;
  leanZ: number;
  random: () => number;
}

const createPeakGeometry = ({
  radius,
  height,
  radialSegments,
  flattening,
  leanX,
  leanZ,
  random,
}: PeakGeometryOptions): THREE.BufferGeometry => {
  const positions: number[] = [0, -height * 0.015, 0];
  const baseIndices: number[] = [];
  const shoulderIndices: number[] = [];

  for (let index = 0; index < radialSegments; index += 1) {
    const angle = (index / radialSegments) * TAU;
    const broadNoise = Math.sin(angle * 2 + random() * 0.7) * 0.08;
    const localRadius = radius * (0.82 + broadNoise + random() * 0.28);
    baseIndices.push(positions.length / 3);
    positions.push(
      Math.cos(angle) * localRadius,
      height * random() * 0.035,
      Math.sin(angle) * localRadius * flattening,
    );
  }

  for (let index = 0; index < radialSegments; index += 1) {
    const baseIndex = baseIndices[index]! * 3;
    const taper = 0.46 + random() * 0.16;
    shoulderIndices.push(positions.length / 3);
    positions.push(
      positions[baseIndex]! * taper + leanX * (0.34 + random() * 0.2),
      height * (0.34 + random() * 0.17),
      positions[baseIndex + 2]! * taper + leanZ * (0.34 + random() * 0.2),
    );
  }

  const apexIndex = positions.length / 3;
  positions.push(leanX, height, leanZ);

  const indices: number[] = [];
  for (let index = 0; index < radialSegments; index += 1) {
    const next = (index + 1) % radialSegments;
    const base = baseIndices[index]!;
    const nextBase = baseIndices[next]!;
    const shoulder = shoulderIndices[index]!;
    const nextShoulder = shoulderIndices[next]!;

    // Closed underside plus two faceted slope bands.
    indices.push(0, nextBase, base);
    indices.push(base, nextBase, nextShoulder, base, nextShoulder, shoulder);
    indices.push(shoulder, nextShoulder, apexIndex);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setIndex(indices);
  const geometry = indexed.toNonIndexed();
  indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

/**
 * Builds a deterministic, low-poly massif from overlapping asymmetric peaks.
 * Place and rotate the returned group from the renderer; its base sits at y=0.
 */
export const createLayeredRidge = (options: LayeredRidgeOptions): THREE.Group => {
  if (!(options.radius > 0) || !(options.height > 0)) {
    throw new RangeError('A layered ridge needs positive radius and height values.');
  }

  const materials: readonly THREE.Material[] =
    options.material instanceof THREE.Material ? [options.material] : options.material;
  if (materials.length === 0) throw new RangeError('A layered ridge needs at least one material.');

  const random = seededRandom(options.seed);
  const layerCount = clampInteger(options.layers ?? 3, 1, 7);
  const radialSegments = clampInteger(options.radialSegments ?? 9, 6, 18);
  const flattening = THREE.MathUtils.clamp(options.flattening ?? 0.68, 0.25, 1.25);
  const ridgeDirection = random() * TAU;
  const alongX = Math.cos(ridgeDirection);
  const alongZ = Math.sin(ridgeDirection);
  const group = new THREE.Group();
  group.name = `layered-ridge-${Math.trunc(options.seed)}`;

  for (let layer = 0; layer < layerCount; layer += 1) {
    const centralPeak = layer === 0;
    const band = Math.ceil(layer / 2);
    const side = layer % 2 === 0 ? 1 : -1;
    const sizeFalloff = centralPeak ? 1 : Math.max(0.46, 0.79 - band * 0.11 + random() * 0.08);
    const layerRadius = options.radius * sizeFalloff;
    const layerHeight = options.height * (centralPeak ? 1 : Math.max(0.42, 0.78 - band * 0.1 + random() * 0.08));
    const offset = centralPeak ? 0 : side * options.radius * (0.27 + band * 0.18);
    const depthOffset = centralPeak ? 0 : (random() - 0.5) * options.radius * flattening * 0.24;
    const leanAmount = layerRadius * (0.09 + random() * 0.13);

    const mesh = new THREE.Mesh(
      createPeakGeometry({
        radius: layerRadius,
        height: layerHeight,
        radialSegments,
        flattening: THREE.MathUtils.clamp(flattening * (0.88 + random() * 0.22), 0.2, 1.3),
        leanX: Math.cos(ridgeDirection + (random() - 0.5) * 1.4) * leanAmount,
        leanZ: Math.sin(ridgeDirection + (random() - 0.5) * 1.4) * leanAmount * flattening,
        random,
      }),
      materials[layer % materials.length]!,
    );
    mesh.name = centralPeak ? 'ridge-main-peak' : `ridge-shoulder-${layer}`;
    mesh.position.set(
      alongX * offset - alongZ * depthOffset,
      0,
      alongZ * offset + alongX * depthOffset,
    );
    mesh.rotation.y = (random() - 0.5) * 0.24;
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    group.add(mesh);
  }

  group.userData.seed = options.seed;
  group.userData.radius = options.radius;
  group.userData.height = options.height;
  return group;
};

export interface AlienPlantMaterials {
  stem: THREE.Material;
  leaf: THREE.Material;
  /** Optional emissive material for a few crystalline seed pods. */
  glow?: THREE.Material;
}

export interface ColdAlienPlantOptions {
  seed: number;
  materials: AlienPlantMaterials;
  height?: number;
  radius?: number;
  blades?: number;
  castShadow?: boolean;
}

interface LeafGeometryOptions {
  height: number;
  width: number;
  lean: number;
  twist: number;
  segments: number;
}

const createRibbonLeafGeometry = ({
  height,
  width,
  lean,
  twist,
  segments,
}: LeafGeometryOptions): THREE.BufferGeometry => {
  const sideVertexCount = (segments + 1) * 2;
  const positions: number[] = [];

  const appendSide = (): void => {
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const bell = Math.sin(Math.PI * Math.pow(t, 0.84));
      const halfWidth = width * Math.max(0.035, bell) * (1 - t * 0.32);
      const centerX = Math.sin(t * Math.PI * 0.72) * twist * width;
      const centerZ = lean * Math.pow(t, 1.45) + Math.sin(t * Math.PI) * height * 0.035;
      positions.push(centerX - halfWidth, t * height, centerZ);
      positions.push(centerX + halfWidth, t * height, centerZ);
    }
  };

  appendSide();
  appendSide();

  const indices: number[] = [];
  for (let step = 0; step < segments; step += 1) {
    const left = step * 2;
    const right = left + 1;
    const nextLeft = left + 2;
    const nextRight = left + 3;
    indices.push(left, nextLeft, nextRight, left, nextRight, right);

    const back = sideVertexCount;
    indices.push(back + left, back + nextRight, back + nextLeft, back + left, back + right, back + nextRight);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

/**
 * Creates a stylised cold-climate alien plant made from curved ribbon leaves.
 * Materials are supplied by the caller so many plants can share one material kit.
 */
export const createColdAlienPlant = (options: ColdAlienPlantOptions): THREE.Group => {
  const height = options.height ?? 2.25;
  const radius = options.radius ?? height * 0.34;
  if (!(height > 0) || !(radius > 0)) {
    throw new RangeError('An alien plant needs positive height and radius values.');
  }

  const random = seededRandom(options.seed);
  const bladeCount = clampInteger(options.blades ?? 6, 3, 12);
  const castShadow = options.castShadow ?? true;
  const group = new THREE.Group();
  group.name = `cold-alien-plant-${Math.trunc(options.seed)}`;

  const stemHeight = height * (0.34 + random() * 0.09);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.075, radius * 0.14, stemHeight, 5, 2),
    options.materials.stem,
  );
  stem.position.y = stemHeight * 0.5;
  stem.rotation.z = (random() - 0.5) * 0.08;
  stem.castShadow = castShadow;
  stem.receiveShadow = true;
  group.add(stem);

  for (let index = 0; index < bladeCount; index += 1) {
    const angle = (index / bladeCount) * TAU + (random() - 0.5) * 0.32;
    const bladeHeight = height * (0.62 + random() * 0.36);
    const lean = radius * (0.7 + random() * 0.72);
    const width = radius * (0.2 + random() * 0.12);
    const twist = (random() - 0.5) * 1.3;
    const leaf = new THREE.Mesh(
      createRibbonLeafGeometry({ height: bladeHeight, width, lean, twist, segments: 5 }),
      options.materials.leaf,
    );
    leaf.name = `ribbon-leaf-${index}`;
    leaf.position.y = height * (0.015 + random() * 0.055);
    leaf.rotation.y = angle;
    leaf.rotation.z = (random() - 0.5) * 0.08;
    leaf.castShadow = castShadow;
    leaf.receiveShadow = true;
    group.add(leaf);

    if (options.materials.glow && index % 3 === 0) {
      const pod = new THREE.Mesh(
        new THREE.OctahedronGeometry(radius * (0.075 + random() * 0.025), 0),
        options.materials.glow,
      );
      pod.name = `crystal-pod-${index}`;
      pod.position.set(twist * width * 0.64, bladeHeight * 0.93, lean * 0.9);
      pod.scale.y = 1.65;
      pod.castShadow = false;
      leaf.add(pod);
    }
  }

  group.userData.seed = options.seed;
  group.userData.swayPhase = random() * TAU;
  group.userData.swayStrength = 0.006 + random() * 0.008;
  return group;
};
