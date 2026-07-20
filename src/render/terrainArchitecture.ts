import * as THREE from 'three';

import type { AabbObstacle } from '../game/types';

export type ObstacleVisualClass = 'earth' | 'rock' | 'planter' | 'authored' | 'facility';

const FACILITY_ZONE_PALETTES = {
  // The emplacement and service hardware stay in graphite/blue-grey so the
  // restored ceramic buildings do not collapse into one all-white mass.
  tower: [0x2d4148, 0x4f666b],
  base: [0xf1f0e9, 0xd8e1dc, 0xc9d7dd],
  relay: [0xe8ebe5, 0xc3d4d0],
  greenhouse: [0xe5e9df, 0xc5d5cd],
  logistics: [0x72878a, 0x91a4a5],
  cargo: [0x536f78, 0x79776f, 0x70847c, 0x515c69],
  neutral: [0xe7e9e3, 0xcbd8d8, 0xb9cecf],
} as const;

const AUTHORED_COLLISION_VOLUMES = new Set([
  'south-greenhouse-growbed-west',
  'south-greenhouse-growbed-east',
]);

/**
 * Collision names are authored around gameplay responsibilities, but the
 * renderer still needs an explicit surface vocabulary. Keeping that mapping
 * here prevents words such as "planter" from accidentally turning a metal
 * hydroponics module into a grass-covered boulder.
 */
export const classifyObstacleVisual = (
  obstacle: Pick<AabbObstacle, 'id' | 'kind'>,
): ObstacleVisualClass => {
  if (AUTHORED_COLLISION_VOLUMES.has(obstacle.id)) return 'authored';
  if (/^south-planter-(west|east)(?:-|$)/.test(obstacle.id)) return 'planter';
  if (obstacle.id.includes('outcrop') || /^(north|south)-mid-cover-/.test(obstacle.id)) return 'rock';
  if (obstacle.id.includes('earth-') || /^(north|south)-ridge-(west|east)(?:-|$)/.test(obstacle.id)) {
    return 'earth';
  }
  return 'facility';
};

/** Stable zone-aware coating selection; variation is intentional but mirrored
 * combat spaces still read as one human-built facility. */
export const artificialSurfaceColor = (obstacle: Pick<AabbObstacle, 'id' | 'kind'>): number => {
  const id = obstacle.id;
  const palette = id.startsWith('tower-')
    ? FACILITY_ZONE_PALETTES.tower
    : id.includes('base')
      ? FACILITY_ZONE_PALETTES.base
      : id.includes('relay') || id.startsWith('north-overlook')
        ? FACILITY_ZONE_PALETTES.relay
        : id.includes('greenhouse') || id.startsWith('south-planter')
          ? FACILITY_ZONE_PALETTES.greenhouse
          : id.includes('-mid-') || id.includes('gallery') || id.includes('canopy')
            ? FACILITY_ZONE_PALETTES.logistics
            : /cover|crate|console|slab|screen/.test(id)
              ? FACILITY_ZONE_PALETTES.cargo
              : FACILITY_ZONE_PALETTES.neutral;
  let hash = 2166136261;
  // Team prefixes intentionally share the same suffix-driven finish so mirror
  // geometry remains coherent while cyan/red IFF lighting carries allegiance.
  const stableId = id
    .replace(/^umbra-(west|east)-/, 'umbra-team-')
    .replace(/^(west|east|aurora|nova)-/, 'team-');
  for (let index = 0; index < stableId.length; index += 1) {
    hash ^= stableId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length]!;
};

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

const signedPower = (value: number, power: number): number =>
  Math.sign(value) * Math.pow(Math.abs(value), power);

const ringPoint = (
  angle: number,
  superellipsePower: number,
  radius: number,
  halfWidth: number,
  halfDepth: number,
): readonly [number, number] => {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    signedPower(cosine, superellipsePower) * halfWidth * radius,
    signedPower(sine, superellipsePower) * halfDepth * radius,
  ];
};

/**
 * Closed, deterministic superellipse mound. Earth uses a broad walkable crown
 * and softly eroded skirt; rock uses an asymmetric, faceted profile. Its axial
 * extrema remain aligned with the collision AABB while the corners recede,
 * removing the tell-tale rounded-box silhouette.
 */
export const createOrganicObstacleGeometry = (
  size: THREE.Vector3,
  seed: number,
  rocky: boolean,
): THREE.BufferGeometry => {
  if (!(size.x > 0) || !(size.y > 0) || !(size.z > 0)) {
    throw new RangeError('Organic obstacle dimensions must be positive.');
  }
  const random = seededRandom(seed);
  const segments = rocky ? 15 : 20;
  const rings = rocky
    ? [
        { y: -0.5, radius: 0.87 },
        { y: -0.12, radius: 1 },
        { y: 0.31, radius: 0.82 },
        { y: 0.5, radius: 0.57 },
      ]
    : [
        { y: -0.5, radius: 0.92 },
        { y: -0.27, radius: 1 },
        { y: 0.24, radius: 0.96 },
        { y: 0.5, radius: 0.84 },
      ];
  const halfWidth = size.x * 0.5;
  const halfDepth = size.z * 0.5;
  // 2 / n is the exponent used by the common superellipse parameterization.
  // Earth approaches a softened rectangle; rocks retain a rounder footprint.
  const superellipsePower = rocky ? 0.66 : 0.38;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const phase = random() * Math.PI * 2;

  for (let ringIndex = 0; ringIndex < rings.length; ringIndex += 1) {
    const ring = rings[ringIndex]!;
    for (let segment = 0; segment < segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const broadNoise = Math.sin(angle * (rocky ? 3 : 2) + phase) * (rocky ? 0.075 : 0.035);
      const localNoise = (random() - 0.5) * (rocky ? 0.11 : 0.045);
      // Axial vertices keep the geometry close to the authoritative AABB.
      const axisVertex = segment % Math.round(segments / 4) === 0;
      const radius = ring.radius * (axisVertex ? 1 : 1 + broadNoise + localNoise);
      const [x, z] = ringPoint(angle, superellipsePower, radius, halfWidth, halfDepth);
      const verticalNoise = ringIndex === 0
        ? 0
        : (Math.sin(angle * 4.3 + phase * 1.7) + random() - 0.5)
          * size.y
          * (rocky ? 0.045 : 0.018);
      positions.push(x, ring.y * size.y + verticalNoise, z);
      uvs.push(x / Math.max(0.001, size.x) + 0.5, z / Math.max(0.001, size.z) + 0.5);
    }
  }

  for (let ringIndex = 0; ringIndex < rings.length - 1; ringIndex += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const next = (segment + 1) % segments;
      const lower = ringIndex * segments + segment;
      const lowerNext = ringIndex * segments + next;
      const upper = (ringIndex + 1) * segments + segment;
      const upperNext = (ringIndex + 1) * segments + next;
      // The angular rings advance around +Y. Keep the winding counter-clockwise
      // when viewed from outside the mound so WebGL's normal back-face culling
      // does not expose the far inner wall and make the volume look hollow.
      indices.push(lower, upperNext, lowerNext, lower, upper, upperNext);
    }
  }

  const bottomCenter = positions.length / 3;
  positions.push(0, -size.y * 0.5, 0);
  uvs.push(0.5, 0.5);
  const topCenter = positions.length / 3;
  const crownOffsetX = rocky ? (random() - 0.5) * size.x * 0.12 : 0;
  const crownOffsetZ = rocky ? (random() - 0.5) * size.z * 0.12 : 0;
  positions.push(crownOffsetX, size.y * (rocky ? 0.53 : 0.5), crownOffsetZ);
  uvs.push(0.5, 0.5);
  const topRingStart = (rings.length - 1) * segments;
  for (let segment = 0; segment < segments; segment += 1) {
    const next = (segment + 1) % segments;
    indices.push(bottomCenter, segment, next);
    indices.push(topCenter, topRingStart + next, topRingStart + segment);
  }

  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  indexed.setIndex(indices);
  const geometry = rocky ? indexed.toNonIndexed() : indexed;
  if (geometry !== indexed) indexed.dispose();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

/** Industrial cargo pod with clipped armour corners. Unlike a bevelled cube,
 * the eight-sided silhouette is part of the primitive itself and keeps broad
 * planar faces for readable panel textures and IFF markings. */
export const createChamferedCargoGeometry = (
  size: THREE.Vector3,
  insetRatio = 0.13,
): THREE.BufferGeometry => {
  if (!(size.x > 0) || !(size.y > 0) || !(size.z > 0)) {
    throw new RangeError('Cargo pod dimensions must be positive.');
  }
  const halfWidth = size.x * 0.5;
  const halfHeight = size.y * 0.5;
  const inset = Math.min(halfWidth, halfHeight) * THREE.MathUtils.clamp(insetRatio, 0.04, 0.34);
  const shape = new THREE.Shape();
  shape.moveTo(-halfWidth + inset, -halfHeight);
  shape.lineTo(halfWidth - inset, -halfHeight);
  shape.lineTo(halfWidth, -halfHeight + inset);
  shape.lineTo(halfWidth, halfHeight - inset);
  shape.lineTo(halfWidth - inset, halfHeight);
  shape.lineTo(-halfWidth + inset, halfHeight);
  shape.lineTo(-halfWidth, halfHeight - inset);
  shape.lineTo(-halfWidth, -halfHeight + inset);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: size.z,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -size.z * 0.5);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

export interface IndustrialPlanterMaterials {
  shell: THREE.Material;
  frame: THREE.Material;
  soil: THREE.Material;
  foliage: THREE.Material;
  accent: THREE.Material;
}

/**
 * Builds the visible shell for a collision-authored hydroponics terrace. The
 * wall remains manufactured metal/concrete; natural material is constrained
 * to a shallow inset on the horizontal growing surface.
 */
export const createIndustrialPlanterVisual = (
  obstacle: AabbObstacle,
  materials: IndustrialPlanterMaterials,
): THREE.Group => {
  const size = new THREE.Vector3(
    obstacle.max.x - obstacle.min.x,
    obstacle.max.y - obstacle.min.y,
    obstacle.max.z - obstacle.min.z,
  );
  const center = new THREE.Vector3(
    (obstacle.min.x + obstacle.max.x) * 0.5,
    (obstacle.min.y + obstacle.max.y) * 0.5,
    (obstacle.min.z + obstacle.max.z) * 0.5,
  );
  const group = new THREE.Group();
  group.name = `${obstacle.id}-industrial-visual`;
  group.position.copy(center);

  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(size.x, size.y, size.z),
    materials.shell,
  );
  shell.name = `${obstacle.id}-manufactured-shell`;
  shell.castShadow = size.y > 0.4;
  shell.receiveShadow = true;
  group.add(shell);

  const frameThickness = Math.min(0.12, Math.max(0.045, Math.min(size.x, size.z) * 0.032));
  const frameHeight = Math.min(0.16, Math.max(0.07, size.y * 0.13));
  const upperY = size.y * 0.5 + frameHeight * 0.18;
  for (const z of [-1, 1] as const) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(size.x + frameThickness * 1.4, frameHeight, frameThickness),
      materials.frame,
    );
    rail.name = `${obstacle.id}-edge-${z < 0 ? 'north' : 'south'}`;
    rail.position.set(0, upperY, z * (size.z * 0.5 + frameThickness * 0.15));
    rail.castShadow = true;
    group.add(rail);
  }
  for (const x of [-1, 1] as const) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(frameThickness, frameHeight, size.z),
      materials.frame,
    );
    rail.name = `${obstacle.id}-edge-${x < 0 ? 'west' : 'east'}`;
    rail.position.set(x * (size.x * 0.5 + frameThickness * 0.15), upperY, 0);
    rail.castShadow = true;
    group.add(rail);
  }

  const isGrowingBed = !obstacle.id.endsWith('-step') && !obstacle.id.endsWith('-cover');
  if (isGrowingBed && size.x > 2 && size.z > 2) {
    const soil = new THREE.Mesh(
      new THREE.PlaneGeometry(
        Math.max(0.25, size.x - frameThickness * 3.2),
        Math.max(0.25, size.z - frameThickness * 3.2),
      ),
      materials.soil,
    );
    soil.name = `${obstacle.id}-contained-soil`;
    soil.rotation.x = -Math.PI / 2;
    soil.position.y = size.y * 0.5 + 0.012;
    soil.receiveShadow = true;
    group.add(soil);

    const rows = Math.max(2, Math.min(4, Math.floor(size.z / 1.15)));
    const columns = Math.max(4, Math.min(12, Math.floor(size.x / 0.62)));
    const bladeGeometry = new THREE.PlaneGeometry(0.11, 0.32, 1, 2);
    bladeGeometry.translate(0, 0.16, 0);
    const crops = new THREE.InstancedMesh(bladeGeometry, materials.foliage, rows * columns);
    crops.name = `${obstacle.id}-ordered-crop-rows`;
    crops.castShadow = false;
    crops.receiveShadow = true;
    const transform = new THREE.Object3D();
    let cropIndex = 0;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = THREE.MathUtils.lerp(-size.x * 0.34, size.x * 0.34, columns === 1 ? 0.5 : column / (columns - 1));
        const z = THREE.MathUtils.lerp(-size.z * 0.28, size.z * 0.28, rows === 1 ? 0.5 : row / (rows - 1));
        const phase = (column * 0.618 + row * 0.271) % 1;
        transform.position.set(x, size.y * 0.5 + 0.018, z);
        transform.rotation.set(0, phase * Math.PI, 0);
        transform.scale.set(0.78 + phase * 0.28, 0.82 + phase * 0.24, 1);
        transform.updateMatrix();
        crops.setMatrixAt(cropIndex, transform.matrix);
        cropIndex += 1;
      }
    }
    crops.instanceMatrix.needsUpdate = true;
    crops.computeBoundingBox();
    crops.computeBoundingSphere();
    group.add(crops);
  }

  const horizontal = size.x >= size.z;
  const accent = new THREE.Mesh(
    new THREE.BoxGeometry(
      horizontal ? size.x * 0.38 : 0.035,
      Math.min(0.075, size.y * 0.1),
      horizontal ? 0.035 : size.z * 0.38,
    ),
    materials.accent,
  );
  accent.name = `${obstacle.id}-status-strip`;
  accent.position.set(
    horizontal ? 0 : -(size.x * 0.5 + 0.02),
    Math.min(size.y * 0.18, 0.32),
    horizontal ? -(size.z * 0.5 + 0.02) : 0,
  );
  group.add(accent);
  group.userData.surfaceClass = 'planter';
  group.userData.naturalMaterialConfinedToTop = true;
  return group;
};
