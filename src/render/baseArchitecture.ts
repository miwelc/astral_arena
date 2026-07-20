import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { AabbObstacle, MapDefinition } from '../game/types';

type TeamId = 'aurora' | 'nova';

const TEAM_STYLE: Record<TeamId, { accent: number; glow: number }> = {
  aurora: { accent: 0x76d8f2, glow: 0x25bfea },
  nova: { accent: 0xf28aa7, glow: 0xe9457a },
};

export interface BaseArchitectureOptions {
  quality?: 'low' | 'high';
  seed?: number;
}

export interface BaseArchitectureBundle {
  group: THREE.Group;
  dispose: () => void;
}

interface ArchitectureTextures {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  roughness: THREE.DataTexture;
}

interface ArchitectureMaterials {
  panel: THREE.MeshPhysicalMaterial;
  darkPanel: THREE.MeshPhysicalMaterial;
  structure: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  floorMarking: THREE.MeshBasicMaterial;
  growBed: THREE.MeshPhysicalMaterial;
  foliage: THREE.MeshStandardMaterial;
  team: Record<TeamId, THREE.MeshPhysicalMaterial>;
  teamGlow: Record<TeamId, THREE.MeshStandardMaterial>;
  screen: THREE.MeshStandardMaterial;
}

interface PhysicalSurfaceProfile {
  color: number;
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  envMapIntensity: number;
}

interface ArchitectureMaterialProfile {
  panel: PhysicalSurfaceProfile;
  darkPanel: PhysicalSurfaceProfile;
  structure: {
    color: number;
    roughness: number;
    metalness: number;
    envMapIntensity: number;
  };
  glass: PhysicalSurfaceProfile;
  rubber: { color: number; roughness: number; metalness: number };
  floorMarking: number;
  teamSurface: { roughness: number; metalness: number; clearcoat: number };
  screen: {
    color: number;
    emissive: number;
    emissiveIntensity: number;
    roughness: number;
    metalness: number;
  };
}

/**
 * Crater is a bright ceramic research campus, while Umbra is an orbital
 * installation built from low-albedo pressure hull panels. Keeping this
 * distinction at the material boundary lets both architecture builders retain
 * the same semantic material names, batching and disposal contracts.
 */
const ARCHITECTURE_MATERIAL_PROFILES: Record<MapDefinition['id'], ArchitectureMaterialProfile> = {
  'crater-ridge': {
    panel: {
      color: 0xf7f4ec,
      roughness: 0.34,
      metalness: 0.1,
      clearcoat: 0.38,
      clearcoatRoughness: 0.27,
      envMapIntensity: 1.08,
    },
    darkPanel: {
      color: 0x1a292f,
      roughness: 0.4,
      metalness: 0.48,
      clearcoat: 0.18,
      clearcoatRoughness: 0.32,
      envMapIntensity: 1.05,
    },
    structure: { color: 0x101a1e, roughness: 0.31, metalness: 0.74, envMapIntensity: 1.08 },
    glass: {
      color: 0x68aebd,
      roughness: 0.1,
      metalness: 0.08,
      clearcoat: 0.95,
      clearcoatRoughness: 0.06,
      envMapIntensity: 1.4,
    },
    rubber: { color: 0x080c0e, roughness: 0.72, metalness: 0.08 },
    floorMarking: 0xd9e9df,
    teamSurface: { roughness: 0.38, metalness: 0.24, clearcoat: 0.34 },
    screen: {
      color: 0x8ce7df,
      emissive: 0x37cfc5,
      emissiveIntensity: 2.45,
      roughness: 0.16,
      metalness: 0.16,
    },
  },
  'umbra-station': {
    panel: {
      color: 0x263342,
      roughness: 0.25,
      metalness: 0.68,
      clearcoat: 0.24,
      clearcoatRoughness: 0.18,
      envMapIntensity: 1.38,
    },
    darkPanel: {
      color: 0x080d16,
      roughness: 0.32,
      metalness: 0.82,
      clearcoat: 0.12,
      clearcoatRoughness: 0.24,
      envMapIntensity: 1.28,
    },
    structure: { color: 0x070b12, roughness: 0.24, metalness: 0.88, envMapIntensity: 1.34 },
    glass: {
      color: 0x31546a,
      roughness: 0.07,
      metalness: 0.18,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.58,
    },
    rubber: { color: 0x020407, roughness: 0.66, metalness: 0.18 },
    floorMarking: 0x7b91a6,
    teamSurface: { roughness: 0.26, metalness: 0.5, clearcoat: 0.22 },
    screen: {
      color: 0x87b9ff,
      emissive: 0x2a67d8,
      emissiveIntensity: 2.75,
      roughness: 0.12,
      metalness: 0.32,
    },
  },
};

interface GeometryBatch {
  material: THREE.Material;
  geometries: THREE.BufferGeometry[];
  sources: string[];
  castShadow: boolean;
  receiveShadow: boolean;
}

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

const clampByte = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/**
 * Browser-independent panel maps. Grid seams, fasteners, wear and fine
 * scratches share the same mask in all three maps, so the surface reads as a
 * manufactured material instead of colour painted onto primitive geometry.
 */
const createArchitectureTextures = (seed: number): ArchitectureTextures => {
  const size = 64;
  const albedoPixels = new Uint8Array(size * size * 4);
  const normalPixels = new Uint8Array(size * size * 4);
  const roughnessPixels = new Uint8Array(size * size * 4);
  const random = seededRandom(seed);
  const wear = new Float32Array(size * size);
  for (let index = 0; index < wear.length; index += 1) wear[index] = random();

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = (y * size + x) * 4;
      const gridX = x % 16;
      const gridY = y % 16;
      const seam = gridX === 0 || gridX === 15 || gridY === 0 || gridY === 15;
      const seamShoulder = gridX === 1 || gridX === 14 || gridY === 1 || gridY === 14;
      const fastener = (
        (gridX === 3 || gridX === 12)
        && (gridY === 3 || gridY === 12)
      );
      const scratch = ((x * 7 + y * 13 + seed) % 97) < 2 && gridX > 3 && gridY > 2;
      const noise = (wear[y * size + x] ?? 0.5) - 0.5;
      const base = seam ? 72 : seamShoulder ? 184 : fastener ? 82 : 228 + noise * 14;
      const warmWear = scratch ? 18 : 0;

      albedoPixels[pixel] = clampByte(base + warmWear);
      albedoPixels[pixel + 1] = clampByte(base + (scratch ? 7 : 3));
      albedoPixels[pixel + 2] = clampByte(base - (scratch ? 15 : 1));
      albedoPixels[pixel + 3] = 255;

      const normalX = seam ? (gridX === 0 ? 92 : gridX === 15 ? 164 : 128) : 128;
      const normalY = seam ? (gridY === 0 ? 92 : gridY === 15 ? 164 : 128) : 128;
      normalPixels[pixel] = normalX;
      normalPixels[pixel + 1] = normalY;
      normalPixels[pixel + 2] = fastener ? 182 : seam ? 198 : scratch ? 220 : 252;
      normalPixels[pixel + 3] = 255;

      const roughness = seam ? 232 : fastener ? 118 : scratch ? 96 : 142 + noise * 42;
      const roughnessByte = clampByte(roughness);
      roughnessPixels[pixel] = roughnessByte;
      roughnessPixels[pixel + 1] = roughnessByte;
      roughnessPixels[pixel + 2] = roughnessByte;
      roughnessPixels[pixel + 3] = 255;
    }
  }

  const configure = (texture: THREE.DataTexture, color = false): THREE.DataTexture => {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.flipY = false;
    if (color) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    albedo: configure(new THREE.DataTexture(albedoPixels, size, size, THREE.RGBAFormat), true),
    normal: configure(new THREE.DataTexture(normalPixels, size, size, THREE.RGBAFormat)),
    roughness: configure(new THREE.DataTexture(roughnessPixels, size, size, THREE.RGBAFormat)),
  };
};

const createArchitectureMaterials = (
  textures: ArchitectureTextures,
  mapId: MapDefinition['id'],
): ArchitectureMaterials => {
  const profile = ARCHITECTURE_MATERIAL_PROFILES[mapId];
  const sharedSurface = {
    map: textures.albedo,
    normalMap: textures.normal,
    normalScale: new THREE.Vector2(0.52, 0.52),
    roughnessMap: textures.roughness,
  };
  return {
    panel: new THREE.MeshPhysicalMaterial({
      name: 'architecture-white-panel',
      ...profile.panel,
      ...sharedSurface,
    }),
    darkPanel: new THREE.MeshPhysicalMaterial({
      name: 'architecture-dark-panel',
      ...profile.darkPanel,
      ...sharedSurface,
    }),
    structure: new THREE.MeshStandardMaterial({
      name: 'architecture-structural-steel',
      ...profile.structure,
    }),
    glass: new THREE.MeshPhysicalMaterial({
      name: 'architecture-laminated-glass',
      ...profile.glass,
      transmission: 0.22,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
    }),
    rubber: new THREE.MeshStandardMaterial({
      name: 'architecture-rubber',
      ...profile.rubber,
    }),
    floorMarking: new THREE.MeshBasicMaterial({
      name: 'architecture-floor-marking',
      color: profile.floorMarking,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
    }),
    growBed: new THREE.MeshPhysicalMaterial({
      name: 'architecture-hydroponic-bed',
      color: 0x21383b,
      roughness: 0.34,
      metalness: 0.42,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
    }),
    foliage: new THREE.MeshStandardMaterial({
      name: 'architecture-crop-foliage',
      color: 0x5c9d51,
      roughness: 0.82,
      metalness: 0,
      side: THREE.DoubleSide,
    }),
    team: {
      aurora: new THREE.MeshPhysicalMaterial({
        name: 'architecture-aurora-panel',
        color: TEAM_STYLE.aurora.accent,
        ...sharedSurface,
        ...profile.teamSurface,
      }),
      nova: new THREE.MeshPhysicalMaterial({
        name: 'architecture-nova-panel',
        color: TEAM_STYLE.nova.accent,
        ...sharedSurface,
        ...profile.teamSurface,
      }),
    },
    teamGlow: {
      aurora: new THREE.MeshStandardMaterial({
        name: 'architecture-aurora-light',
        color: TEAM_STYLE.aurora.accent,
        emissive: TEAM_STYLE.aurora.glow,
        emissiveIntensity: 2.7,
        roughness: 0.16,
        toneMapped: false,
      }),
      nova: new THREE.MeshStandardMaterial({
        name: 'architecture-nova-light',
        color: TEAM_STYLE.nova.accent,
        emissive: TEAM_STYLE.nova.glow,
        emissiveIntensity: 2.7,
        roughness: 0.16,
        toneMapped: false,
      }),
    },
    screen: new THREE.MeshStandardMaterial({
      name: 'architecture-information-screen',
      ...profile.screen,
      toneMapped: false,
    }),
  };
};

const boxMesh = (
  name: string,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
  material: THREE.Material,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const cylinderBetween = (
  name: string,
  start: THREE.Vector3,
  end: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  radialSegments = 8,
): THREE.Mesh => {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, radialSegments),
    material,
  );
  mesh.name = name;
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

const obstacleById = (map: MapDefinition, id: string): AabbObstacle => {
  const obstacle = map.obstacles.find((candidate) => candidate.id === id);
  if (!obstacle) throw new Error(`Base architecture requires map obstacle "${id}".`);
  return obstacle;
};

const addGlazedCollisionWall = (
  group: THREE.Group,
  prefix: string,
  obstacle: AabbObstacle,
  windowY: number,
  count: number,
  materials: ArchitectureMaterials,
  exteriorFace: 'min' | 'max',
): void => {
  const sizeX = obstacle.max.x - obstacle.min.x;
  const sizeZ = obstacle.max.z - obstacle.min.z;
  const axis: 'x' | 'z' = sizeX >= sizeZ ? 'x' : 'z';
  const start = obstacle.min[axis];
  const end = obstacle.max[axis];
  const length = end - start;
  const cell = length / count;
  const wallThickness = axis === 'x' ? sizeZ : sizeX;
  const wallFixed = axis === 'x'
    ? (obstacle.min.z + obstacle.max.z) * 0.5
    : (obstacle.min.x + obstacle.max.x) * 0.5;
  const exterior = axis === 'x'
    ? obstacle[exteriorFace].z
    : obstacle[exteriorFace].x;
  const faceOffset = exteriorFace === 'min' ? -0.035 : 0.035;
  const paneWidth = Math.max(0.32, cell - 0.24);
  const paneGeometry = new THREE.BoxGeometry(
    axis === 'x' ? paneWidth : 0.055,
    1.28,
    axis === 'x' ? 0.055 : paneWidth,
  );
  const panes = new THREE.InstancedMesh(paneGeometry, materials.glass, count);
  panes.name = `${prefix}-windows`;
  panes.castShadow = false;
  panes.receiveShadow = true;
  const transform = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    const along = Math.min(start, end) + cell * (index + 0.5);
    transform.position.set(
      axis === 'x' ? along : exterior + faceOffset,
      windowY,
      axis === 'x' ? exterior + faceOffset : along,
    );
    transform.rotation.set(0, 0, 0);
    transform.scale.set(1, 1, 1);
    transform.updateMatrix();
    panes.setMatrixAt(index, transform.matrix);
  }
  panes.instanceMatrix.needsUpdate = true;
  group.add(panes);

  const lowerHeight = Math.max(0.08, windowY - 0.64 - obstacle.min.y);
  const upperHeight = Math.max(0.08, obstacle.max.y - (windowY + 0.64));
  group.add(boxMesh(
    `${prefix}-lower-spandrel`,
    axis === 'x' ? [length, lowerHeight, wallThickness] : [wallThickness, lowerHeight, length],
    axis === 'x'
      ? [(start + end) * 0.5, obstacle.min.y + lowerHeight * 0.5, wallFixed]
      : [wallFixed, obstacle.min.y + lowerHeight * 0.5, (start + end) * 0.5],
    materials.panel,
  ));
  group.add(boxMesh(
    `${prefix}-upper-spandrel`,
    axis === 'x' ? [length, upperHeight, wallThickness] : [wallThickness, upperHeight, length],
    axis === 'x'
      ? [(start + end) * 0.5, obstacle.max.y - upperHeight * 0.5, wallFixed]
      : [wallFixed, obstacle.max.y - upperHeight * 0.5, (start + end) * 0.5],
    materials.panel,
  ));

  const mullionGeometry = new THREE.BoxGeometry(
    axis === 'x' ? 0.16 : wallThickness * 1.02,
    1.42,
    axis === 'x' ? wallThickness * 1.02 : 0.16,
  );
  const mullions = new THREE.InstancedMesh(mullionGeometry, materials.structure, count + 1);
  mullions.name = `${prefix}-mullions`;
  mullions.castShadow = true;
  mullions.receiveShadow = true;
  for (let index = 0; index <= count; index += 1) {
    const along = start + cell * index;
    transform.position.set(
      axis === 'x' ? along : wallFixed,
      windowY,
      axis === 'x' ? wallFixed : along,
    );
    transform.updateMatrix();
    mullions.setMatrixAt(index, transform.matrix);
  }
  mullions.instanceMatrix.needsUpdate = true;
  group.add(mullions);
};

const addRail = (
  group: THREE.Group,
  prefix: string,
  start: THREE.Vector3,
  end: THREE.Vector3,
  baseY: number,
  material: THREE.Material,
  spacing = 1.65,
): void => {
  const horizontalStart = start.clone().setY(baseY);
  const horizontalEnd = end.clone().setY(baseY);
  const length = horizontalStart.distanceTo(horizontalEnd);
  const posts = Math.max(2, Math.ceil(length / spacing) + 1);
  for (let index = 0; index < posts; index += 1) {
    const ratio = index / (posts - 1);
    const position = horizontalStart.clone().lerp(horizontalEnd, ratio);
    group.add(cylinderBetween(
      `${prefix}-post-${index}`,
      position,
      position.clone().add(new THREE.Vector3(0, 0.92, 0)),
      0.045,
      material,
    ));
  }
  group.add(cylinderBetween(
    `${prefix}-handrail`,
    horizontalStart.clone().add(new THREE.Vector3(0, 0.92, 0)),
    horizontalEnd.clone().add(new THREE.Vector3(0, 0.92, 0)),
    0.065,
    material,
    10,
  ));
  group.add(cylinderBetween(
    `${prefix}-midrail`,
    horizontalStart.clone().add(new THREE.Vector3(0, 0.48, 0)),
    horizontalEnd.clone().add(new THREE.Vector3(0, 0.48, 0)),
    0.032,
    material,
  ));
};

const addCeilingLights = (
  group: THREE.Group,
  prefix: string,
  xValues: readonly number[],
  zValues: readonly number[],
  y: number,
  material: THREE.Material,
): void => {
  let index = 0;
  for (const x of xValues) {
    for (const z of zValues) {
      const light = boxMesh(`${prefix}-ceiling-light-${index}`, [1.35, 0.055, 0.18], [x, y, z], material);
      light.castShadow = false;
      group.add(light);
      index += 1;
    }
  }
};

const addCargoDetail = (
  group: THREE.Group,
  prefix: string,
  obstacle: AabbObstacle,
  materials: ArchitectureMaterials,
  team: TeamId,
): void => {
  const centerX = (obstacle.min.x + obstacle.max.x) * 0.5;
  const centerY = (obstacle.min.y + obstacle.max.y) * 0.5;
  const centerZ = (obstacle.min.z + obstacle.max.z) * 0.5;
  const sizeX = obstacle.max.x - obstacle.min.x;
  const sizeY = obstacle.max.y - obstacle.min.y;
  const sizeZ = obstacle.max.z - obstacle.min.z;
  for (const zSide of [-1, 1]) {
    const brace = boxMesh(
      `${prefix}-cargo-brace-${zSide < 0 ? 'front' : 'back'}`,
      [sizeX * 0.72, Math.min(0.14, sizeY * 0.1), 0.055],
      [centerX, centerY, centerZ + zSide * (sizeZ * 0.5 + 0.035)],
      materials.structure,
    );
    group.add(brace);
    const identifier = boxMesh(
      `${prefix}-cargo-id-${zSide < 0 ? 'front' : 'back'}`,
      [sizeX * 0.24, 0.08, 0.065],
      [centerX, centerY + sizeY * 0.24, centerZ + zSide * (sizeZ * 0.5 + 0.04)],
      materials.teamGlow[team],
    );
    identifier.castShadow = false;
    group.add(identifier);
  }
  for (const xSide of [-1, 1]) {
    for (const zSide of [-1, 1]) {
      group.add(boxMesh(
        `${prefix}-cargo-corner-${xSide}-${zSide}`,
        [0.11, sizeY * 0.92, 0.11],
        [centerX + xSide * sizeX * 0.46, centerY, centerZ + zSide * sizeZ * 0.46],
        materials.rubber,
      ));
    }
  }
};

const createTeamOperationsBuilding = (
  map: MapDefinition,
  team: TeamId,
  materials: ArchitectureMaterials,
): THREE.Group => {
  const side = team === 'aurora' ? 'west' : 'east';
  const direction = team === 'aurora' ? 1 : -1;
  const floor = obstacleById(map, `${side}-base`);
  const roof = obstacleById(map, `${side}-base-roof`);
  const balcony = obstacleById(map, `${side}-base-balcony`);
  const entryX = team === 'aurora' ? floor.max.x : floor.min.x;
  const floorY = floor.max.y;
  const group = new THREE.Group();
  group.name = `${team}-operations-building`;
  group.userData.hasInterior = true;
  group.userData.function = 'team-operations-and-flag-room';
  group.userData.entryClearWidth = 8.8;

  // Pressure-door portal. Panels are visibly retracted into their wall pockets,
  // so the collision opening and what the player sees agree.
  const portal = new THREE.Group();
  portal.name = `${team}-pressure-door`;
  for (const z of [-4.22, 4.22]) {
    portal.add(boxMesh(
      `${team}-door-jamb-${z < 0 ? 'north' : 'south'}`,
      [0.28, 3.78, 0.34],
      [entryX + direction * 0.08, floorY + 1.89, z],
      materials.structure,
    ));
    portal.add(boxMesh(
      `${team}-retracted-door-${z < 0 ? 'north' : 'south'}`,
      [0.18, 3.2, 0.72],
      [entryX + direction * 0.2, floorY + 1.65, z - Math.sign(z) * 0.46],
      materials.team[team],
    ));
    const status = boxMesh(
      `${team}-door-status-${z < 0 ? 'north' : 'south'}`,
      [0.08, 0.58, 0.09],
      [entryX + direction * 0.32, floorY + 2.25, z - Math.sign(z) * 0.7],
      materials.teamGlow[team],
    );
    status.castShadow = false;
    portal.add(status);
  }
  portal.add(boxMesh(
    `${team}-door-header`,
    [0.3, 0.34, 8.65],
    [entryX + direction * 0.08, floorY + 3.82, 0],
    materials.structure,
  ));
  group.add(portal);

  // Glazing follows the collision walls instead of floating independently.
  const frontFace = team === 'aurora' ? 'max' : 'min';
  addGlazedCollisionWall(group, `${team}-facade-north`, obstacleById(map, `${side}-base-front-n`), 2.62, 2, materials, frontFace);
  addGlazedCollisionWall(group, `${team}-facade-south`, obstacleById(map, `${side}-base-front-s`), 2.62, 2, materials, frontFace);
  addGlazedCollisionWall(group, `${team}-side-north`, obstacleById(map, `${side}-base-wing-n`), 2.72, 3, materials, 'min');
  addGlazedCollisionWall(group, `${team}-side-south`, obstacleById(map, `${side}-base-wing-s`), 2.72, 3, materials, 'max');

  // A real loading ramp visually bridges the two shallow collision treads.
  const rampLength = 2.43;
  const slope = Math.atan2(floorY, 2.4);
  const rampCenterX = entryX + direction * 1.2;
  const ramp = boxMesh(
    `${team}-loading-ramp`,
    [rampLength, 0.12, 6.55],
    [rampCenterX, floorY * 0.5 + 0.035, 0],
    materials.darkPanel,
  );
  ramp.rotation.z = direction * -slope;
  group.add(ramp);
  for (const z of [-3.32, 3.32]) {
    const start = new THREE.Vector3(entryX, floorY + 0.05, z);
    const end = new THREE.Vector3(entryX + direction * 2.4, 0.05, z);
    group.add(cylinderBetween(`${team}-ramp-edge-${z < 0 ? 'north' : 'south'}`, start, end, 0.055, materials.team[team], 8));
  }

  // Interior floor lane and hazard borders orient a flag carrier at a glance.
  const laneCenterX = (floor.min.x + floor.max.x) * 0.5;
  const lane = boxMesh(
    `${team}-interior-navigation-lane`,
    [Math.abs(floor.max.x - floor.min.x) * 0.82, 0.018, 1.35],
    [laneCenterX, floorY + 0.014, 0],
    materials.floorMarking,
  );
  lane.castShadow = false;
  group.add(lane);

  // Mezzanine rail ends before the stair opening and remains physically
  // aligned with the matching thin collision rail in map.ts.
  const railX = team === 'aurora' ? balcony.max.x + 0.02 : balcony.min.x - 0.02;
  addRail(
    group,
    `${team}-mezzanine`,
    new THREE.Vector3(railX, 0, -7.7),
    new THREE.Vector3(railX, 0, 4.7),
    balcony.max.y,
    materials.structure,
    1.55,
  );

  // Ceiling beams and cool service luminaires make the room read as an
  // occupied human facility when viewed from the doorway.
  const centerX = (floor.min.x + floor.max.x) * 0.5;
  for (const z of [-8, 0, 8]) {
    group.add(boxMesh(
      `${team}-ceiling-beam-${z}`,
      [Math.abs(floor.max.x - floor.min.x) - 0.7, 0.18, 0.16],
      [centerX, roof.min.y - 0.22, z],
      materials.structure,
    ));
  }
  addCeilingLights(group, team, [centerX - direction * 2.25, centerX + direction * 2.25], [-7.2, 0, 7.2], roof.min.y - 0.36, materials.screen);

  // Utility pipes follow the rear wall and turn down beside the mezzanine.
  const utilityX = team === 'aurora' ? floor.min.x + 0.5 : floor.max.x - 0.5;
  for (const z of [-9.4, 9.4]) {
    group.add(cylinderBetween(
      `${team}-utility-riser-${z < 0 ? 'north' : 'south'}`,
      new THREE.Vector3(utilityX, floorY + 0.2, z),
      new THREE.Vector3(utilityX, roof.min.y - 0.42, z),
      0.09,
      materials.rubber,
      10,
    ));
  }

  for (const suffix of ['n', 's']) {
    addCargoDetail(
      group,
      `${team}-interior-${suffix}`,
      obstacleById(map, `${side}-base-interior-crate-${suffix}`),
      materials,
      team,
    );
  }
  return group;
};

const createRelayBuilding = (map: MapDefinition, materials: ArchitectureMaterials): THREE.Group => {
  const roof = obstacleById(map, 'north-relay-roof');
  const group = new THREE.Group();
  group.name = 'observatory-relay-building';
  group.userData.hasInterior = true;
  group.userData.function = 'meteorological-relay-and-power-weapon-room';

  // South-facing pressure door and front observation windows.
  const frontZ = -29.47;
  for (const x of [-2.08, 2.08]) {
    group.add(boxMesh(`relay-door-jamb-${x < 0 ? 'west' : 'east'}`, [0.3, 3.34, 0.26], [x, 1.83, frontZ], materials.structure));
  }
  group.add(boxMesh('relay-door-header', [4.45, 0.28, 0.27], [0, 3.52, frontZ], materials.structure));
  addGlazedCollisionWall(group, 'relay-front-west', obstacleById(map, 'north-relay-front-west'), 2.55, 2, materials, 'max');
  addGlazedCollisionWall(group, 'relay-front-east', obstacleById(map, 'north-relay-front-east'), 2.55, 2, materials, 'max');
  addGlazedCollisionWall(group, 'relay-side-west', obstacleById(map, 'north-relay-wall-west'), 2.62, 2, materials, 'min');
  addGlazedCollisionWall(group, 'relay-side-east', obstacleById(map, 'north-relay-wall-east'), 2.62, 2, materials, 'max');

  addCeilingLights(group, 'relay', [-4.6, 0, 4.6], [-33.35], roof.min.y - 0.32, materials.screen);

  // Communications mast, azimuth ring and paired antenna fins identify the
  // building's function from the opposite end of the map.
  group.add(cylinderBetween('relay-antenna-mast', new THREE.Vector3(0, roof.max.y, -33.4), new THREE.Vector3(0, roof.max.y + 3.6, -33.4), 0.13, materials.structure, 12));
  const azimuth = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.08, 8, 32), materials.team.aurora);
  azimuth.name = 'relay-antenna-azimuth-ring';
  azimuth.rotation.x = Math.PI / 2;
  azimuth.position.set(0, roof.max.y + 1.15, -33.4);
  group.add(azimuth);
  for (const side of [-1, 1]) {
    const fin = boxMesh(`relay-antenna-fin-${side}`, [0.08, 1.1, 0.82], [side * 0.6, roof.max.y + 2.7, -33.4], materials.panel);
    fin.rotation.z = side * 0.32;
    group.add(fin);
  }

  for (const side of ['west', 'east'] as const) {
    const consoleObstacle = obstacleById(map, `north-relay-console-${side}`);
    const x = (consoleObstacle.min.x + consoleObstacle.max.x) * 0.5;
    const console = boxMesh(`relay-${side}-console-screen`, [1.6, 0.68, 0.055], [x, consoleObstacle.max.y + 0.24, consoleObstacle.max.z + 0.035], materials.screen);
    console.rotation.x = -0.16;
    console.castShadow = false;
    group.add(console);
  }
  return group;
};

const createGreenhouseBuilding = (
  map: MapDefinition,
  materials: ArchitectureMaterials,
  quality: 'low' | 'high',
  seed: number,
): THREE.Group => {
  const roof = obstacleById(map, 'south-greenhouse-roof');
  const group = new THREE.Group();
  group.name = 'hydroponics-laboratory';
  group.userData.hasInterior = true;
  group.userData.function = 'food-production-and-botany-laboratory';

  const frontZ = 28.47;
  for (const x of [-2.08, 2.08]) {
    group.add(boxMesh(`greenhouse-door-jamb-${x < 0 ? 'west' : 'east'}`, [0.3, 2.94, 0.26], [x, 1.66, frontZ], materials.structure));
  }
  group.add(boxMesh('greenhouse-door-header', [4.45, 0.28, 0.27], [0, 3.15, frontZ], materials.structure));
  addGlazedCollisionWall(group, 'greenhouse-front-west', obstacleById(map, 'south-greenhouse-front-west'), 2.45, 3, materials, 'min');
  addGlazedCollisionWall(group, 'greenhouse-front-east', obstacleById(map, 'south-greenhouse-front-east'), 2.45, 3, materials, 'min');
  addGlazedCollisionWall(group, 'greenhouse-side-west', obstacleById(map, 'south-greenhouse-west'), 2.42, 3, materials, 'min');
  addGlazedCollisionWall(group, 'greenhouse-side-east', obstacleById(map, 'south-greenhouse-east'), 2.42, 3, materials, 'max');

  // Long skylights and roof ribs make the laboratory silhouette immediately
  // different from the military team bases. Opaque infill exactly covers the
  // gaps in the collision roof, so every visible surface is physically honest.
  for (const [x, width] of [[-8.075, 1.85], [-3.8, 0.9], [0, 0.9], [3.8, 0.9], [8.075, 1.85]] as const) {
    group.add(boxMesh(
      `greenhouse-roof-infill-${x}`,
      [width, 0.12, 5.35],
      [x, roof.max.y + 0.01, 32.4],
      materials.panel,
    ));
  }
  for (const z of [29.4625, 35.3375]) {
    group.add(boxMesh(
      `greenhouse-roof-edge-${z}`,
      [18, 0.12, 0.525],
      [0, roof.max.y + 0.01, z],
      materials.panel,
    ));
  }
  for (const x of [-5.7, -1.9, 1.9, 5.7]) {
    const skylight = boxMesh(`greenhouse-skylight-${x}`, [2.9, 0.055, 5.35], [x, roof.max.y + 0.045, 32.4], materials.glass);
    skylight.castShadow = false;
    group.add(skylight);
  }
  for (const x of [-8.82, -3.8, 0, 3.8, 8.82]) {
    group.add(boxMesh(
      `greenhouse-longitudinal-roof-rib-${x}`,
      [0.14, 0.14, 6.32],
      [x, roof.max.y + 0.09, 32.4],
      materials.structure,
    ));
  }
  for (const z of [29.5, 32.4, 35.3]) {
    group.add(boxMesh(`greenhouse-roof-rib-${z}`, [17.5, 0.12, 0.14], [0, roof.max.y + 0.09, z], materials.structure));
  }

  const random = seededRandom(seed);
  const plantCount = quality === 'high' ? 48 : 24;
  const plantGeometry = new THREE.PlaneGeometry(0.28, 0.72, 1, 2);
  plantGeometry.translate(0, 0.36, 0);
  for (const side of [-1, 1]) {
    const bed = obstacleById(map, side < 0 ? 'south-greenhouse-growbed-west' : 'south-greenhouse-growbed-east');
    const tray = boxMesh(
      `greenhouse-${side < 0 ? 'west' : 'east'}-nutrient-tray`,
      [bed.max.x - bed.min.x - 0.25, 0.12, bed.max.z - bed.min.z - 0.25],
      [(bed.min.x + bed.max.x) * 0.5, bed.max.y + 0.08, (bed.min.z + bed.max.z) * 0.5],
      materials.growBed,
    );
    group.add(tray);
    const plants = new THREE.InstancedMesh(plantGeometry, materials.foliage, plantCount);
    plants.name = `greenhouse-${side < 0 ? 'west' : 'east'}-crops`;
    const transform = new THREE.Object3D();
    for (let index = 0; index < plantCount; index += 1) {
      transform.position.set(
        THREE.MathUtils.lerp(bed.min.x + 0.35, bed.max.x - 0.35, random()),
        bed.max.y + 0.13,
        THREE.MathUtils.lerp(bed.min.z + 0.3, bed.max.z - 0.3, random()),
      );
      transform.rotation.set(0, random() * Math.PI, (random() - 0.5) * 0.16);
      const scale = 0.68 + random() * 0.42;
      transform.scale.set(scale, scale, scale);
      transform.updateMatrix();
      plants.setMatrixAt(index, transform.matrix);
    }
    plants.instanceMatrix.needsUpdate = true;
    plants.castShadow = true;
    plants.receiveShadow = true;
    group.add(plants);

    const pipeX = side < 0 ? bed.max.x + 0.26 : bed.min.x - 0.26;
    group.add(cylinderBetween(
      `greenhouse-${side < 0 ? 'west' : 'east'}-irrigation-pipe`,
      new THREE.Vector3(pipeX, bed.max.y + 0.22, bed.min.z),
      new THREE.Vector3(pipeX, bed.max.y + 0.22, bed.max.z),
      0.055,
      materials.team.aurora,
      8,
    ));
  }
  addCeilingLights(group, 'greenhouse', [-6, 0, 6], [30.1, 34.8], roof.min.y - 0.3, materials.screen);
  return group;
};

const createLogisticsDetails = (map: MapDefinition, materials: ArchitectureMaterials): THREE.Group => {
  const group = new THREE.Group();
  group.name = 'logistics-checkpoints-and-cargo';
  for (const team of ['aurora', 'nova'] as const) {
    const side = team === 'aurora' ? 'west' : 'east';
    const canopy = obstacleById(map, `${side}-mid-canopy`);
    const centerX = (canopy.min.x + canopy.max.x) * 0.5;
    const centerZ = (canopy.min.z + canopy.max.z) * 0.5;
    const sign = boxMesh(
      `${team}-logistics-route-sign`,
      [2.8, 0.72, 0.08],
      [centerX, canopy.min.y - 0.58, centerZ],
      materials.team[team],
    );
    group.add(sign);
    const glyph = boxMesh(
      `${team}-logistics-route-glyph`,
      [1.25, 0.09, 0.09],
      [centerX, canopy.min.y - 0.58, centerZ + 0.055],
      materials.teamGlow[team],
    );
    glyph.castShadow = false;
    group.add(glyph);
    addCeilingLights(group, `${team}-logistics`, [centerX - 2.25, centerX + 2.25], [-2.2, 2.2], canopy.min.y - 0.14, materials.screen);
  }

  const cargoIds = [
    ['cover-nw-a', 'aurora'], ['cover-nw-b', 'aurora'],
    ['cover-sw-a', 'aurora'], ['cover-sw-b', 'aurora'],
    ['cover-ne-a', 'nova'], ['cover-ne-b', 'nova'],
    ['cover-se-a', 'nova'], ['cover-se-b', 'nova'],
  ] as const;
  for (const [id, team] of cargoIds) addCargoDetail(group, id, obstacleById(map, id), materials, team);
  return group;
};

/**
 * Architectural dressing for Estación Umbra. Gameplay collision is authored
 * in the map; these pieces explain it as a coherent orbital communications
 * complex through airlock frames, bridge trusses, lighting, glazing and
 * functional antenna/power hardware.
 */
const createUmbraStationArchitecture = (
  map: MapDefinition,
  materials: ArchitectureMaterials,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = 'umbra-station-architecture';
  group.userData.hasInteriors = true;
  group.userData.function = 'orbital-communications-and-life-support-station';

  for (const team of ['aurora', 'nova'] as const) {
    const side = team === 'aurora' ? 'west' : 'east';
    const direction = team === 'aurora' ? 1 : -1;
    const floor = obstacleById(map, `umbra-${side}-base-floor`);
    const roof = obstacleById(map, `umbra-${side}-base-roof`);
    const entryX = team === 'aurora' ? floor.max.x : floor.min.x;
    const centerX = (floor.min.x + floor.max.x) * 0.5;

    // The broad ground portal stays visibly open and receives a luminous IFF
    // spine so flag carriers can orient in peripheral vision.
    for (const z of [-3.62, 3.62]) {
      group.add(boxMesh(
        `umbra-${team}-main-airlock-jamb-${z < 0 ? 'north' : 'south'}`,
        [0.3, 3.62, 0.28],
        [entryX + direction * 0.07, floor.max.y + 1.81, z],
        materials.structure,
      ));
      const status = boxMesh(
        `umbra-${team}-main-airlock-status-${z < 0 ? 'north' : 'south'}`,
        [0.075, 0.9, 0.1],
        [entryX + direction * 0.25, floor.max.y + 2.22, z - Math.sign(z) * 0.42],
        materials.teamGlow[team],
      );
      status.castShadow = false;
      group.add(status);
    }
    group.add(boxMesh(
      `umbra-${team}-main-airlock-header`,
      [0.32, 0.3, 7.35],
      [entryX + direction * 0.07, 4.02, 0],
      materials.structure,
    ));

    const routeLine = boxMesh(
      `umbra-${team}-flag-room-route-line`,
      [Math.abs(floor.max.x - floor.min.x) * 0.82, 0.018, 1.1],
      [centerX, floor.max.y + 0.012, 0],
      materials.floorMarking,
    );
    routeLine.castShadow = false;
    group.add(routeLine);
    addCeilingLights(
      group,
      `umbra-${team}-habitat`,
      [centerX - direction * 2.15, centerX + direction * 2.15],
      [-7, 0, 7],
      roof.min.y - 0.34,
      materials.screen,
    );

    // Independent upper pressure doors communicate why both exposed bridges
    // are valid routes rather than scenery glued to the habitation shell.
    for (const zSide of [-1, 1]) {
      const z = zSide * 10.24;
      for (const xOffset of [-1.7, 1.7]) {
        group.add(boxMesh(
          `umbra-${team}-${zSide < 0 ? 'north' : 'south'}-upper-door-jamb-${xOffset}`,
          [0.18, 2.18, 0.28],
          [team === 'aurora' ? -31.1 + xOffset : 31.1 + xOffset, 3.85, z],
          materials.structure,
        ));
      }
      group.add(boxMesh(
        `umbra-${team}-${zSide < 0 ? 'north' : 'south'}-upper-door-header`,
        [3.55, 0.2, 0.3],
        [team === 'aurora' ? -31.1 : 31.1, 4.94, z],
        materials.team[team],
      ));
    }

    for (const suffix of ['a', 'b']) {
      addCargoDetail(
        group,
        `umbra-${team}-habitat-${suffix}`,
        obstacleById(map, `umbra-${side}-base-crate-${suffix}`),
        materials,
        team,
      );
    }
  }

  // Repeating bridge trusses and compact route lights give the exposed ring a
  // purpose-built silhouette without adding invisible collision to the deck.
  for (const side of ['west', 'east'] as const) {
    const team = side === 'west' ? 'aurora' : 'nova';
    for (const lane of ['north', 'south'] as const) {
      const deck = obstacleById(map, `umbra-${side}-${lane}-catwalk`);
      const centerX = (deck.min.x + deck.max.x) * 0.5;
      const centerZ = (deck.min.z + deck.max.z) * 0.5;
      const length = deck.max.x - deck.min.x;
      for (const zEdge of [deck.min.z + 0.18, deck.max.z - 0.18]) {
        group.add(boxMesh(
          `umbra-${side}-${lane}-underslung-truss-${zEdge}`,
          [length - 0.5, 0.14, 0.12],
          [centerX, deck.min.y - 0.16, zEdge],
          materials.structure,
        ));
      }
      for (const x of [deck.min.x + 3, centerX, deck.max.x - 3]) {
        const beacon = boxMesh(
          `umbra-${side}-${lane}-route-beacon-${x}`,
          [0.11, 0.08, 0.34],
          [x, deck.max.y + 0.1, centerZ],
          materials.teamGlow[team],
        );
        beacon.castShadow = false;
        group.add(beacon);
      }
    }
  }

  const relayRoof = obstacleById(map, 'umbra-north-relay-roof');
  const relayCenterZ = (relayRoof.min.z + relayRoof.max.z) * 0.5;
  addCeilingLights(group, 'umbra-relay', [-5.2, 0, 5.2], [-20.5, -16.2], relayRoof.min.y - 0.28, materials.screen);
  group.add(cylinderBetween(
    'umbra-relay-primary-mast',
    new THREE.Vector3(0, relayRoof.max.y, relayCenterZ),
    new THREE.Vector3(0, relayRoof.max.y + 5.4, relayCenterZ),
    0.16,
    materials.structure,
    12,
  ));
  const dish = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 2.15, 0.32, 24, 1, true),
    materials.panel,
  );
  dish.name = 'umbra-relay-deep-space-dish';
  dish.rotation.z = -0.48;
  dish.position.set(0.8, relayRoof.max.y + 4.05, relayCenterZ);
  dish.castShadow = true;
  group.add(dish);
  for (const x of [-5.4, 5.4]) {
    // These sit on the relay's opaque pressure wall, so they read as recessed
    // telemetry displays rather than fake windows painted over solid collision.
    const telemetryPanel = boxMesh(
      `umbra-relay-telemetry-panel-${x < 0 ? 'west' : 'east'}`,
      [3.2, 1.28, 0.055],
      [x, 4.8, -22.86],
      materials.screen,
    );
    telemetryPanel.castShadow = false;
    group.add(telemetryPanel);
  }

  const annexRoof = obstacleById(map, 'umbra-south-annex-roof');
  addCeilingLights(group, 'umbra-power-annex-lower', [-5, 0, 5], [16.2, 21.2], 2.36, materials.screen);
  addCeilingLights(group, 'umbra-power-annex-upper', [-5, 0, 5], [17.1, 21.4], annexRoof.min.y - 0.26, materials.screen);
  for (const x of [-5.2, 5.2]) {
    const bus = cylinderBetween(
      `umbra-annex-power-bus-${x < 0 ? 'west' : 'east'}`,
      new THREE.Vector3(x, annexRoof.max.y + 0.16, 15.2),
      new THREE.Vector3(x, annexRoof.max.y + 0.16, 22.2),
      0.11,
      x < 0 ? materials.team.aurora : materials.team.nova,
      10,
    );
    group.add(bus);
  }
  for (const x of [-4.6, 0, 4.6]) {
    const skylight = boxMesh(
      `umbra-annex-skylight-${x}`,
      [3.2, 0.055, 4.8],
      [x, annexRoof.max.y + 0.045, 20.2],
      materials.glass,
    );
    skylight.castShadow = false;
    group.add(skylight);
  }

  return group;
};

/**
 * Static opaque architecture does not need one WebGL draw per beam, crate
 * brace or door jamb. Bake those meshes into one geometry per material while
 * retaining their source names as metadata for inspection and tests. Glass
 * and InstancedMesh vegetation/window arrays stay separate for correct sorting.
 */
const batchStaticArchitecture = (group: THREE.Group): void => {
  group.updateWorldMatrix(true, true);
  const batches = new Map<string, GeometryBatch>();
  const originals: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh) return;
    if (Array.isArray(object.material) || object.material.transparent) return;
    const geometry = object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    const batch: GeometryBatch = batches.get(object.material.uuid) ?? {
      material: object.material,
      geometries: [] as THREE.BufferGeometry[],
      sources: [] as string[],
      castShadow: false,
      receiveShadow: false,
    };
    batch.geometries.push(geometry);
    if (object.name) batch.sources.push(object.name);
    batch.castShadow ||= object.castShadow;
    batch.receiveShadow ||= object.receiveShadow;
    batches.set(object.material.uuid, batch);
    originals.push(object);
  });

  for (const original of originals) {
    original.removeFromParent();
    original.geometry.dispose();
  }
  for (const batch of batches.values()) {
    const merged = mergeGeometries(batch.geometries, false);
    for (const geometry of batch.geometries) geometry.dispose();
    if (!merged) throw new Error(`Unable to batch architecture material ${batch.material.name}.`);
    const mesh = new THREE.Mesh(merged, batch.material);
    mesh.name = `architecture-batch-${batch.material.name || batch.material.uuid}`;
    mesh.castShadow = batch.castShadow;
    mesh.receiveShadow = batch.receiveShadow;
    mesh.userData.sourceNames = batch.sources;
    group.add(mesh);
  }
};

/**
 * Adds functionally legible detail to the collision-authored map buildings.
 * This does not add hidden gameplay collision: doors, windows, rails, ramps,
 * interiors and props are all aligned to AABBs exported by map.ts.
 */
export const createBaseArchitecture = (
  map: MapDefinition,
  options: BaseArchitectureOptions = {},
): BaseArchitectureBundle => {
  const quality = options.quality ?? 'high';
  const seed = Math.trunc(options.seed ?? 0x4a91c7);
  const textures = createArchitectureTextures(seed);
  const materials = createArchitectureMaterials(textures, map.id);
  const group = new THREE.Group();
  group.name = 'human-base-architecture';
  group.userData.architectureVersion = 1;
  if (map.id === 'umbra-station') {
    group.add(createUmbraStationArchitecture(map, materials));
  } else {
    group.add(
      createTeamOperationsBuilding(map, 'aurora', materials),
      createTeamOperationsBuilding(map, 'nova', materials),
      createRelayBuilding(map, materials),
      createGreenhouseBuilding(map, materials, quality, seed ^ 0x9e3779b9),
      createLogisticsDetails(map, materials),
    );
  }
  batchStaticArchitecture(group);

  const materialSet = new Set<THREE.Material>([
    materials.panel,
    materials.darkPanel,
    materials.structure,
    materials.glass,
    materials.rubber,
    materials.floorMarking,
    materials.growBed,
    materials.foliage,
    materials.team.aurora,
    materials.team.nova,
    materials.teamGlow.aurora,
    materials.teamGlow.nova,
    materials.screen,
  ]);
  const textureSet = new Set<THREE.Texture>([textures.albedo, textures.normal, textures.roughness]);
  let disposed = false;
  return {
    group,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<THREE.BufferGeometry>();
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) geometries.add(object.geometry);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materialSet) material.dispose();
      for (const texture of textureSet) texture.dispose();
      group.clear();
    },
  };
};
