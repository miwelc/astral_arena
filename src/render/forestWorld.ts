import * as THREE from 'three';

import type { AabbObstacle, MapDefinition } from '../game/types';

const TAU = Math.PI * 2;
const TERRAIN_PADDING = 46;
const TERRAIN_CHUNK_SIZE = 48;
const VEGETATION_PADDING = 22;
const VEGETATION_TILE_SIZE = 48;

export interface TitanForestTextures {
  albedo?: THREE.Texture | null;
  normal?: THREE.Texture | null;
  roughness?: THREE.Texture | null;
}

export interface TitanForestWorldOptions {
  map: MapDefinition;
  /** Must match the authored creek depression in the map height sampler. */
  creekCenterZ: (x: number) => number;
  textures?: TitanForestTextures;
  quality?: 'low' | 'high';
  seed?: number;
}

export interface TitanForestRenderStats {
  terrainChunks: number;
  terrainVertices: number;
  vegetationTiles: number;
  treeInstances: number;
  crownInstances: number;
  grassInstances: number;
  fernInstances: number;
  rockInstances: number;
  renderables: number;
  shadowCasters: number;
  transparentRenderables: number;
}

export interface TitanForestWorldBundle {
  group: THREE.Group;
  stats: Readonly<TitanForestRenderStats>;
  update: (time: number, cameraPosition: THREE.Vector3) => void;
  dispose: () => void;
}

interface VegetationTile {
  center: THREE.Vector3;
  trees: THREE.Group;
  understory: THREE.Group;
}

interface TreeRecord {
  x: number;
  y: number;
  z: number;
  height: number;
  radius: number;
  rotation: number;
  color: number;
}

interface ScatterRecord {
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  color: number;
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

const clamp01 = (value: number): number => THREE.MathUtils.clamp(value, 0, 1);
const smooth01 = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

const sampleGround = (map: MapDefinition, x: number, z: number): number => {
  const height = map.groundHeightAt?.(x, z) ?? map.bounds.floorY;
  return Number.isFinite(height) ? height : map.bounds.floorY;
};

const terrainNoise = (x: number, z: number, seed: number): number => {
  const seedPhase = (seed % 997) * 0.0137;
  return (
    Math.sin(x * 0.041 + seedPhase) * 0.46
    + Math.cos(z * 0.053 - seedPhase * 0.71) * 0.31
    + Math.sin((x + z) * 0.021 + seedPhase * 1.4) * 0.23
  );
};

/**
 * Extends the authoritative walkable heightfield into a non-collidable alpine
 * rim. The extension is continuous at the map edge and rises into distant
 * cliffs, so collision-only boundary boxes never need a visible wall.
 */
export const sampleTitanForestVisualHeight = (
  map: MapDefinition,
  x: number,
  z: number,
  seed = 0x71a9e,
): number => {
  const clampedX = THREE.MathUtils.clamp(x, map.bounds.minX, map.bounds.maxX);
  const clampedZ = THREE.MathUtils.clamp(z, map.bounds.minZ, map.bounds.maxZ);
  const distanceX = Math.abs(x - clampedX);
  const distanceZ = Math.abs(z - clampedZ);
  const outsideDistance = Math.hypot(distanceX, distanceZ);
  const base = sampleGround(map, clampedX, clampedZ);
  if (outsideDistance < 0.0001) return base;
  const rim = smooth01(outsideDistance / TERRAIN_PADDING);
  const macro = 0.58 + terrainNoise(x, z, seed) * 0.22;
  const serration = Math.abs(Math.sin(x * 0.063) * Math.cos(z * 0.047));
  return base + rim * (9.5 + macro * 11 + serration * 7.5);
};

const sampleNormal = (
  heightAt: (x: number, z: number) => number,
  x: number,
  z: number,
  step: number,
  target = new THREE.Vector3(),
): THREE.Vector3 => {
  const left = heightAt(x - step, z);
  const right = heightAt(x + step, z);
  const back = heightAt(x, z - step);
  const front = heightAt(x, z + step);
  return target.set(left - right, step * 2, back - front).normalize();
};

const createTerrainChunkGeometry = (
  map: MapDefinition,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  segmentsX: number,
  segmentsZ: number,
  visualHeightAt: (x: number, z: number) => number,
): THREE.BufferGeometry => {
  const rowLength = segmentsX + 1;
  const vertexCount = rowLength * (segmentsZ + 1);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];
  const mapWidth = map.bounds.maxX - map.bounds.minX;
  const mapDepth = map.bounds.maxZ - map.bounds.minZ;
  const normal = new THREE.Vector3();
  const color = new THREE.Color();
  const lowland = new THREE.Color(0x5b7e49);
  const highland = new THREE.Color(0x879f66);
  const rock = new THREE.Color(0x596d62);
  const sampleStep = Math.max(0.7, Math.min((x1 - x0) / segmentsX, (z1 - z0) / segmentsZ));

  let vertex = 0;
  for (let row = 0; row <= segmentsZ; row += 1) {
    const v = row / segmentsZ;
    const z = THREE.MathUtils.lerp(z0, z1, v);
    for (let column = 0; column <= segmentsX; column += 1) {
      const u = column / segmentsX;
      const x = THREE.MathUtils.lerp(x0, x1, u);
      const y = visualHeightAt(x, z);
      sampleNormal(visualHeightAt, x, z, sampleStep, normal);
      const slope = smooth01((1 - normal.y - 0.045) / 0.34);
      const heightMix = smooth01((y - map.bounds.floorY) / 15);
      color.copy(lowland).lerp(highland, heightMix * 0.74).lerp(rock, slope * 0.86);
      const variation = 0.92 + terrainNoise(x * 2.1, z * 2.1, 0x5a21) * 0.055;
      color.multiplyScalar(variation);

      const positionOffset = vertex * 3;
      positions[positionOffset] = x;
      positions[positionOffset + 1] = y;
      positions[positionOffset + 2] = z;
      normals[positionOffset] = normal.x;
      normals[positionOffset + 1] = normal.y;
      normals[positionOffset + 2] = normal.z;
      colors[positionOffset] = color.r;
      colors[positionOffset + 1] = color.g;
      colors[positionOffset + 2] = color.b;
      const uvOffset = vertex * 2;
      uvs[uvOffset] = (x - map.bounds.minX) / mapWidth;
      uvs[uvOffset + 1] = (z - map.bounds.minZ) / mapDepth;
      vertex += 1;
    }
  }

  for (let row = 0; row < segmentsZ; row += 1) {
    for (let column = 0; column < segmentsX; column += 1) {
      const a = row * rowLength + column;
      const b = a + 1;
      const c = a + rowLength;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

interface WindUniforms {
  uForestTime: { value: number };
  uWindStrength: { value: number };
  uWindSpeed: { value: number };
}

const addWindToMaterial = <Material extends THREE.MeshStandardMaterial>(
  material: Material,
  strength: number,
  speed: number,
): WindUniforms => {
  const uniforms: WindUniforms = {
    uForestTime: { value: 0 },
    uWindStrength: { value: strength },
    uWindSpeed: { value: speed },
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uForestTime = uniforms.uForestTime;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.uniforms.uWindSpeed = uniforms.uWindSpeed;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n        uniform float uForestTime;\n        uniform float uWindStrength;\n        uniform float uWindSpeed;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n        float forestPhase = position.x * 1.73 + position.z * 2.17;\n        #ifdef USE_INSTANCING\n          forestPhase += instanceMatrix[3].x * 0.117 + instanceMatrix[3].z * 0.093;\n        #endif\n        float forestWeight = smoothstep(0.0, 1.0, max(position.y, 0.0));\n        float forestGust = sin(uForestTime * uWindSpeed + forestPhase)\n          + sin(uForestTime * uWindSpeed * 0.47 + forestPhase * 0.61) * 0.42;\n        transformed.x += forestGust * uWindStrength * forestWeight;\n        transformed.z += cos(uForestTime * uWindSpeed * 0.72 + forestPhase)\n          * uWindStrength * forestWeight * 0.55;`,
      );
  };
  material.customProgramCacheKey = () => `titan-forest-wind-${strength}-${speed}`;
  material.userData.windUniforms = uniforms;
  return uniforms;
};

const setInstanceColor = (mesh: THREE.InstancedMesh, index: number, color: number): void => {
  mesh.setColorAt(index, new THREE.Color(color));
};

const finishInstances = (mesh: THREE.InstancedMesh): void => {
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
};

const createSlenderTrunkGeometry = (): THREE.BufferGeometry => {
  const radialSegments = 7;
  const rings = 8;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const radius = THREE.MathUtils.lerp(0.46, 0.085, Math.pow(t, 0.66));
    const bendX = Math.sin(t * 2.7) * 0.09 * t;
    const bendZ = Math.sin(t * 3.4 + 0.8) * 0.055 * t;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * TAU;
      const nx = Math.cos(angle);
      const nz = Math.sin(angle);
      positions.push(bendX + nx * radius, t, bendZ + nz * radius);
      normals.push(nx, 0.08, nz);
      uvs.push(segment / radialSegments, t);
    }
  }
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = ring * radialSegments + next;
      const c = (ring + 1) * radialSegments + segment;
      const d = (ring + 1) * radialSegments + next;
      indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

/** Broad, shallow crown with a readable umbrella silhouette from player height. */
const createUmbrellaCrownGeometry = (): THREE.BufferGeometry => {
  const radialSegments = 12;
  const rings = [
    { y: -0.18, radius: 0.54 },
    { y: -0.02, radius: 1 },
    { y: 0.24, radius: 0.94 },
    { y: 0.58, radius: 0.58 },
    { y: 0.82, radius: 0.08 },
  ] as const;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length; ring += 1) {
    const specification = rings[ring]!;
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * TAU;
      const irregularity = 1 + Math.sin(segment * 2.7 + ring * 1.3) * 0.055;
      positions.push(
        Math.cos(angle) * specification.radius * irregularity,
        specification.y,
        Math.sin(angle) * specification.radius * irregularity,
      );
    }
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = ring * radialSegments + next;
      const c = (ring + 1) * radialSegments + segment;
      const d = (ring + 1) * radialSegments + next;
      indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const createGrassTuftGeometry = (): THREE.BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];
  const blades = 7;
  for (let blade = 0; blade < blades; blade += 1) {
    const angle = blade / blades * TAU + Math.sin(blade * 3.71) * 0.18;
    const width = 0.037 + (blade % 3) * 0.007;
    const height = 0.72 + (blade % 4) * 0.095;
    const bend = 0.11 + (blade % 3) * 0.035;
    const rightX = Math.cos(angle) * width;
    const rightZ = Math.sin(angle) * width;
    const bendX = Math.sin(angle) * bend;
    const bendZ = -Math.cos(angle) * bend;
    const offset = positions.length / 3;
    positions.push(
      -rightX, 0, -rightZ,
      rightX, 0, rightZ,
      rightX * 0.4 + bendX * 0.35, height * 0.58, rightZ * 0.4 + bendZ * 0.35,
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

const createFernCrownGeometry = (): THREE.BufferGeometry => {
  const positions: number[] = [];
  const indices: number[] = [];
  const fronds = 7;
  const segments = 4;
  for (let frond = 0; frond < fronds; frond += 1) {
    const angle = frond / fronds * TAU;
    const sideX = Math.cos(angle) * 0.055;
    const sideZ = Math.sin(angle) * 0.055;
    const forwardX = Math.sin(angle);
    const forwardZ = -Math.cos(angle);
    for (let segment = 0; segment <= segments; segment += 1) {
      const t = segment / segments;
      const width = Math.sin(Math.PI * t) * 0.22 + 0.018;
      const reach = t * (0.78 + (frond % 3) * 0.08);
      const y = Math.sin(t * Math.PI * 0.72) * 0.34;
      positions.push(
        forwardX * reach - sideX * width, y, forwardZ * reach - sideZ * width,
        forwardX * reach + sideX * width, y, forwardZ * reach + sideZ * width,
      );
      if (segment < segments) {
        const offset = frond * (segments + 1) * 2 + segment * 2;
        indices.push(offset, offset + 2, offset + 3, offset, offset + 3, offset + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const obstacleBlocksPoint = (
  obstacle: AabbObstacle,
  x: number,
  z: number,
  padding: number,
): boolean => (
  x >= obstacle.min.x - padding
  && x <= obstacle.max.x + padding
  && z >= obstacle.min.z - padding
  && z <= obstacle.max.z + padding
);

const pointNearMapFeature = (
  map: MapDefinition,
  x: number,
  z: number,
  padding: number,
): boolean => {
  if (map.obstacles.some((obstacle) => obstacleBlocksPoint(obstacle, x, z, padding))) return true;
  if (Object.values(map.flagBases).some((base) => Math.hypot(x - base.x, z - base.z) < 6 + padding)) return true;
  if (Math.hypot(x - map.towerCenter.x, z - map.towerCenter.z) < 10 + padding) return true;
  if (map.spawns.some((spawn) => Math.hypot(x - spawn.position.x, z - spawn.position.z) < 2.2 + padding)) return true;
  if (map.pickups.some((pickup) => Math.hypot(x - pickup.position.x, z - pickup.position.z) < 1.1 + padding)) return true;
  return false;
};

const createScatterRecords = (
  options: {
    count: number;
    random: () => number;
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    map: MapDefinition;
    visualHeightAt: (x: number, z: number) => number;
    creekCenterZ: (x: number) => number;
    kind: 'tree' | 'grass' | 'fern';
  },
): ScatterRecord[] => {
  const records: ScatterRecord[] = [];
  const centerX = (options.map.bounds.minX + options.map.bounds.maxX) * 0.5;
  const centerZ = (options.map.bounds.minZ + options.map.bounds.maxZ) * 0.5;
  const attempts = Math.max(24, options.count * 12);
  for (let attempt = 0; attempt < attempts && records.length < options.count; attempt += 1) {
    const x = THREE.MathUtils.lerp(options.x0, options.x1, options.random());
    const z = THREE.MathUtils.lerp(options.z0, options.z1, options.random());
    const inside = x >= options.map.bounds.minX && x <= options.map.bounds.maxX
      && z >= options.map.bounds.minZ && z <= options.map.bounds.maxZ;
    const featurePadding = options.kind === 'tree' ? 3.6 : options.kind === 'fern' ? 0.85 : 0.42;
    if (inside && pointNearMapFeature(options.map, x, z, featurePadding)) continue;
    const riverDistance = Math.abs(z - options.creekCenterZ(x));
    if (riverDistance < (options.kind === 'tree' ? 8.2 : 3.4)) continue;
    const laneDistance = Math.min(Math.abs(x - centerX), Math.abs(z - centerZ));
    if (inside && laneDistance < (options.kind === 'tree' ? 8.5 : 2.7)) continue;

    const height = options.visualHeightAt(x, z);
    const normal = sampleNormal(options.visualHeightAt, x, z, 0.9);
    const maximumSlope = options.kind === 'tree' ? 0.83 : options.kind === 'grass' ? 0.9 : 0.86;
    if (normal.y < maximumSlope) continue;
    const island = terrainNoise(x * 1.6, z * 1.6, options.kind === 'tree' ? 0x7a11 : 0x45e9);
    const edge = inside ? 0 : 0.28;
    const riverBankBoost = options.kind === 'fern'
      ? smooth01(1 - Math.abs(riverDistance - 5.5) / 7.5) * 0.36
      : 0;
    const probability = clamp01(0.52 + island * 0.24 + edge + riverBankBoost);
    if (options.random() > probability) continue;
    const scale = options.kind === 'tree'
      ? 0.8 + options.random() * 0.48
      : options.kind === 'grass'
        ? 0.44 + options.random() * 0.7
        : 0.62 + options.random() * 0.72;
    const green = options.kind === 'grass'
      ? new THREE.Color(0x789861).lerp(new THREE.Color(0xa4b875), options.random() * 0.42)
      : new THREE.Color(0x527758).lerp(new THREE.Color(0x87a76c), options.random() * 0.44);
    records.push({
      x,
      y: height,
      z,
      scale,
      rotation: options.random() * TAU,
      color: green.getHex(),
    });
  }
  return records;
};

const createTreeTile = (
  records: readonly TreeRecord[],
  trunkGeometry: THREE.BufferGeometry,
  crownGeometry: THREE.BufferGeometry,
  trunkMaterial: THREE.MeshStandardMaterial,
  crownMaterial: THREE.MeshStandardMaterial,
  castShadow: boolean,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = 'titan-tree-tile';
  if (records.length === 0) return group;
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, records.length);
  trunks.name = 'titan-slender-tree-trunks';
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, records.length * 2);
  crowns.name = 'titan-umbrella-tree-crowns';
  trunks.castShadow = castShadow;
  crowns.castShadow = castShadow;
  trunks.receiveShadow = true;
  crowns.receiveShadow = true;
  const transform = new THREE.Object3D();
  let crownIndex = 0;
  records.forEach((tree, index) => {
    transform.position.set(tree.x, tree.y, tree.z);
    transform.rotation.set(0, tree.rotation, (index % 2 ? -1 : 1) * 0.012);
    transform.scale.set(tree.radius, tree.height, tree.radius);
    transform.updateMatrix();
    trunks.setMatrixAt(index, transform.matrix);
    setInstanceColor(trunks, index, index % 3 === 0 ? 0xb4b7a5 : 0x8f9a86);

    const crownWidth = tree.height * (0.24 + tree.radius * 0.025);
    transform.position.set(tree.x, tree.y + tree.height * 0.82, tree.z);
    transform.rotation.set(0, tree.rotation, 0);
    transform.scale.set(crownWidth, crownWidth * 0.42, crownWidth * (0.82 + (index % 4) * 0.045));
    transform.updateMatrix();
    crowns.setMatrixAt(crownIndex, transform.matrix);
    setInstanceColor(crowns, crownIndex, tree.color);
    crownIndex += 1;

    const satelliteAngle = tree.rotation + 1.25 + (index % 3) * 0.64;
    transform.position.set(
      tree.x + Math.cos(satelliteAngle) * crownWidth * 0.28,
      tree.y + tree.height * 0.9,
      tree.z + Math.sin(satelliteAngle) * crownWidth * 0.28,
    );
    transform.rotation.set(0, satelliteAngle, 0);
    transform.scale.set(crownWidth * 0.68, crownWidth * 0.31, crownWidth * 0.61);
    transform.updateMatrix();
    crowns.setMatrixAt(crownIndex, transform.matrix);
    setInstanceColor(crowns, crownIndex, new THREE.Color(tree.color).offsetHSL(0.01, -0.03, 0.035).getHex());
    crownIndex += 1;
  });
  finishInstances(trunks);
  finishInstances(crowns);
  group.add(trunks, crowns);
  return group;
};

const createUnderstoryTile = (
  grassRecords: readonly ScatterRecord[],
  fernRecords: readonly ScatterRecord[],
  grassGeometry: THREE.BufferGeometry,
  fernGeometry: THREE.BufferGeometry,
  grassMaterial: THREE.MeshStandardMaterial,
  fernMaterial: THREE.MeshStandardMaterial,
): THREE.Group => {
  const group = new THREE.Group();
  group.name = 'titan-understory-tile';
  const transform = new THREE.Object3D();
  if (grassRecords.length > 0) {
    const grass = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassRecords.length);
    grass.name = 'titan-dense-grass';
    grass.castShadow = false;
    grass.receiveShadow = true;
    grassRecords.forEach((record, index) => {
      transform.position.set(record.x, record.y + 0.015, record.z);
      transform.rotation.set(0, record.rotation, 0);
      transform.scale.set(record.scale * (0.8 + (index % 5) * 0.045), record.scale, record.scale);
      transform.updateMatrix();
      grass.setMatrixAt(index, transform.matrix);
      setInstanceColor(grass, index, record.color);
    });
    finishInstances(grass);
    group.add(grass);
  }
  if (fernRecords.length > 0) {
    const ferns = new THREE.InstancedMesh(fernGeometry, fernMaterial, fernRecords.length);
    ferns.name = 'titan-natural-ferns';
    ferns.castShadow = false;
    ferns.receiveShadow = true;
    fernRecords.forEach((record, index) => {
      transform.position.set(record.x, record.y + 0.025, record.z);
      transform.rotation.set(0, record.rotation, 0);
      transform.scale.setScalar(record.scale);
      transform.updateMatrix();
      ferns.setMatrixAt(index, transform.matrix);
      setInstanceColor(ferns, index, record.color);
    });
    finishInstances(ferns);
    group.add(ferns);
  }
  return group;
};

const createCreekGeometry = (
  map: MapDefinition,
  creekCenterZ: (x: number) => number,
): THREE.BufferGeometry => {
  const startX = map.bounds.minX - 12;
  const endX = map.bounds.maxX + 12;
  const segments = Math.max(96, Math.round((endX - startX) / 1.45));
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices: number[] = [];
  for (let segment = 0; segment <= segments; segment += 1) {
    const t = segment / segments;
    const x = THREE.MathUtils.lerp(startX, endX, t);
    const centerZ = creekCenterZ(x);
    const width = 3.6 + Math.sin(x * 0.085) * 0.62 + Math.sin(x * 0.027 + 1.4) * 0.42;
    const y = sampleGround(map, x, centerZ) + 0.13;
    for (let side = 0; side < 2; side += 1) {
      const index = segment * 2 + side;
      const offset = index * 3;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = centerZ + (side === 0 ? -width : width);
      normals[offset] = 0;
      normals[offset + 1] = 1;
      normals[offset + 2] = 0;
      const uvOffset = index * 2;
      uvs[uvOffset] = t * 13;
      uvs[uvOffset + 1] = side;
    }
    if (segment < segments) {
      const a = segment * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const createCreekMaterial = (): THREE.ShaderMaterial => new THREE.ShaderMaterial({
  name: 'titan-creek-water',
  transparent: true,
  opacity: 0.88,
  depthWrite: true,
  side: THREE.DoubleSide,
  fog: true,
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeepColor: { value: new THREE.Color(0x123f48) },
      uShallowColor: { value: new THREE.Color(0x4c9187) },
      uSunColor: { value: new THREE.Color(0xffd6a0) },
    },
  ]),
  vertexShader: /* glsl */ `
    #include <fog_pars_vertex>
    varying vec2 vUv;
    varying vec3 vWorldPosition;
    void main() {
      vUv = uv;
      vec3 transformed = position;
      transformed.y += sin(position.x * 0.19 + position.z * 0.13) * 0.018;
      vec4 world = modelMatrix * vec4(transformed, 1.0);
      vWorldPosition = world.xyz;
      vec4 mvPosition = viewMatrix * world;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: /* glsl */ `
    #include <fog_pars_fragment>
    varying vec2 vUv;
    varying vec3 vWorldPosition;
    uniform float uTime;
    uniform vec3 uDeepColor;
    uniform vec3 uShallowColor;
    uniform vec3 uSunColor;
    void main() {
      float waveA = sin(vWorldPosition.x * 0.31 + vWorldPosition.z * 0.18 + uTime * 0.72);
      float waveB = sin(vWorldPosition.x * -0.17 + vWorldPosition.z * 0.43 - uTime * 0.51);
      vec3 normal = normalize(vec3(waveA * 0.09, 1.0, waveB * 0.075));
      vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
      float fresnel = pow(1.0 - max(dot(normal, viewDirection), 0.0), 2.6);
      float bank = smoothstep(0.0, 0.34, min(vUv.y, 1.0 - vUv.y));
      vec3 color = mix(uShallowColor, uDeepColor, bank * 0.72 + fresnel * 0.24);
      vec3 lightDirection = normalize(vec3(-0.48, 0.61, -0.63));
      vec3 reflected = reflect(-lightDirection, normal);
      float glint = pow(max(dot(reflected, viewDirection), 0.0), 72.0);
      color += uSunColor * glint * 1.35;
      color += vec3(0.12, 0.24, 0.22) * (waveA + waveB + 2.0) * 0.035;
      gl_FragColor = vec4(color, mix(0.76, 0.9, fresnel));
      #include <fog_fragment>
    }
  `,
});

const createWetRockField = (
  map: MapDefinition,
  creekCenterZ: (x: number) => number,
  visualHeightAt: (x: number, z: number) => number,
  material: THREE.MeshStandardMaterial,
  seed: number,
  quality: 'low' | 'high',
): THREE.InstancedMesh => {
  const random = seededRandom(seed);
  const count = quality === 'high' ? 170 : 96;
  const geometry = new THREE.DodecahedronGeometry(1, 1);
  const rocks = new THREE.InstancedMesh(geometry, material, count);
  rocks.name = 'titan-wet-rocks';
  rocks.castShadow = false;
  rocks.receiveShadow = true;
  const transform = new THREE.Object3D();
  let accepted = 0;
  for (let attempt = 0; attempt < count * 14 && accepted < count; attempt += 1) {
    const x = THREE.MathUtils.lerp(map.bounds.minX - 12, map.bounds.maxX + 12, random());
    const bankSide = random() > 0.5 ? 1 : -1;
    const z = creekCenterZ(x) + bankSide * (4.2 + random() * 7.5);
    if (pointNearMapFeature(map, x, z, 0.5)) continue;
    const radius = 0.22 + random() * random() * 1.25;
    transform.position.set(x, visualHeightAt(x, z) + radius * 0.28, z);
    transform.rotation.set(random() * 0.45, random() * TAU, random() * 0.38);
    transform.scale.set(
      radius * (0.72 + random() * 0.58),
      radius * (0.48 + random() * 0.46),
      radius * (0.78 + random() * 0.54),
    );
    transform.updateMatrix();
    rocks.setMatrixAt(accepted, transform.matrix);
    setInstanceColor(rocks, accepted, random() > 0.68 ? 0x6d8272 : 0x465e56);
    accepted += 1;
  }
  rocks.count = accepted;
  finishInstances(rocks);
  return rocks;
};

const createCraggyMountainGeometry = (): THREE.BufferGeometry => {
  const radialSegments = 11;
  const rings = [
    { y: 0, radius: 1, offsetX: 0, offsetZ: 0 },
    { y: 0.24, radius: 0.93, offsetX: 0.025, offsetZ: -0.02 },
    { y: 0.5, radius: 0.72, offsetX: -0.055, offsetZ: 0.035 },
    { y: 0.72, radius: 0.52, offsetX: 0.035, offsetZ: 0.01 },
    { y: 0.88, radius: 0.3, offsetX: -0.02, offsetZ: -0.04 },
  ] as const;
  const positions: number[] = [];
  const indices: number[] = [];
  rings.forEach((ring, ringIndex) => {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const angle = segment / radialSegments * TAU;
      const irregularity = 1
        + Math.sin(segment * 2.41 + ringIndex * 1.37) * 0.1
        + Math.sin(segment * 4.17 - ringIndex * 0.73) * 0.045;
      const ledge = ringIndex > 1 && segment % 4 === 0 ? 0.055 : 0;
      positions.push(
        ring.offsetX + Math.cos(angle) * ring.radius * irregularity,
        ring.y + ledge,
        ring.offsetZ + Math.sin(angle) * ring.radius * irregularity,
      );
    }
  });
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    for (let segment = 0; segment < radialSegments; segment += 1) {
      const next = (segment + 1) % radialSegments;
      const a = ring * radialSegments + segment;
      const b = ring * radialSegments + next;
      const c = (ring + 1) * radialSegments + segment;
      const d = (ring + 1) * radialSegments + next;
      indices.push(a, b, d, a, d, c);
    }
  }
  const summit = positions.length / 3;
  positions.push(0.015, 0.955, -0.025);
  const summitRing = (rings.length - 1) * radialSegments;
  for (let segment = 0; segment < radialSegments; segment += 1) {
    indices.push(summitRing + segment, summitRing + (segment + 1) % radialSegments, summit);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const createPerimeterMountains = (
  map: MapDefinition,
  visualHeightAt: (x: number, z: number) => number,
  material: THREE.MeshStandardMaterial,
  seed: number,
): THREE.InstancedMesh => {
  const random = seededRandom(seed);
  const count = 34;
  const geometry = createCraggyMountainGeometry();
  const mountains = new THREE.InstancedMesh(geometry, material, count);
  mountains.name = 'titan-natural-cliff-perimeter';
  mountains.castShadow = false;
  mountains.receiveShadow = true;
  const transform = new THREE.Object3D();
  for (let index = 0; index < count; index += 1) {
    const horizontal = index < Math.ceil(count * 0.58);
    const side = index % 2 === 0 ? -1 : 1;
    const x = horizontal
      ? THREE.MathUtils.lerp(map.bounds.minX - 35, map.bounds.maxX + 35, random())
      : (side < 0 ? map.bounds.minX - 30 - random() * 14 : map.bounds.maxX + 30 + random() * 14);
    const z = horizontal
      ? (side < 0 ? map.bounds.minZ - 31 - random() * 15 : map.bounds.maxZ + 31 + random() * 15)
      : THREE.MathUtils.lerp(map.bounds.minZ - 27, map.bounds.maxZ + 27, random());
    const height = 17 + random() * 22;
    const radius = 8 + random() * 10;
    transform.position.set(x, visualHeightAt(x, z) + height * 0.42, z);
    transform.rotation.set((random() - 0.5) * 0.08, random() * TAU, (random() - 0.5) * 0.08);
    transform.scale.set(radius * (0.72 + random() * 0.48), height, radius * (0.72 + random() * 0.52));
    transform.updateMatrix();
    mountains.setMatrixAt(index, transform.matrix);
    setInstanceColor(mountains, index, index % 4 === 0 ? 0x607067 : 0x425750);
  }
  finishInstances(mountains);
  return mountains;
};

/** Creates Titan's complete deterministic natural world presentation. */
export const createTitanForestWorld = (
  options: TitanForestWorldOptions,
): TitanForestWorldBundle => {
  if (options.map.id !== 'titan-expanse') {
    throw new Error(`Titan forest renderer cannot present map ${options.map.id}.`);
  }
  if (!options.map.groundHeightAt) {
    throw new Error('Titan forest renderer requires MapDefinition.groundHeightAt.');
  }
  const quality = options.quality ?? 'high';
  const seed = Math.trunc(options.seed ?? 0x71a9e);
  const group = new THREE.Group();
  group.name = 'titan-expanse-forest-world';
  group.userData.environmentKind = 'alpine-forest';
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const windUniforms: WindUniforms[] = [];
  const vegetationTiles: VegetationTile[] = [];
  const visualHeightAt = (x: number, z: number): number =>
    sampleTitanForestVisualHeight(options.map, x, z, seed);

  const terrainMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-sculpted-terrain',
    color: 0xffffff,
    emissive: 0x294d1d,
    emissiveIntensity: 0.29,
    map: options.textures?.albedo ?? null,
    normalMap: options.textures?.normal ?? null,
    normalScale: new THREE.Vector2(0.74, 0.74),
    roughnessMap: options.textures?.roughness ?? null,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.42,
    vertexColors: true,
  });
  const cliffMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-perimeter-cliff-stone',
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.015,
    flatShading: true,
    vertexColors: true,
  });
  const trunkMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-pale-tree-bark',
    color: 0xffffff,
    emissive: 0x25322b,
    emissiveIntensity: 0.14,
    roughness: 0.94,
    metalness: 0,
    vertexColors: true,
  });
  const crownMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-umbrella-canopy',
    color: 0xffffff,
    emissive: 0x254f2b,
    emissiveIntensity: 0.46,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const grassMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-wind-grass',
    color: 0xffffff,
    emissive: 0x315f20,
    emissiveIntensity: 0.34,
    roughness: 0.91,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const fernMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-wind-ferns',
    color: 0xffffff,
    emissive: 0x2c5d31,
    emissiveIntensity: 0.34,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
    vertexColors: true,
  });
  const rockMaterial = new THREE.MeshStandardMaterial({
    name: 'titan-creek-wet-rock',
    color: 0xffffff,
    roughness: 0.46,
    metalness: 0.025,
    envMapIntensity: 0.86,
    vertexColors: true,
    flatShading: true,
  });
  for (const material of [
    terrainMaterial,
    cliffMaterial,
    trunkMaterial,
    crownMaterial,
    grassMaterial,
    fernMaterial,
    rockMaterial,
  ]) materials.add(material);
  windUniforms.push(
    addWindToMaterial(crownMaterial, 0.032, 0.7),
    addWindToMaterial(grassMaterial, 0.105, 1.15),
    addWindToMaterial(fernMaterial, 0.072, 0.82),
  );

  const terrain = new THREE.Group();
  terrain.name = 'titan-chunked-heightfield';
  const terrainMinX = options.map.bounds.minX - TERRAIN_PADDING;
  const terrainMaxX = options.map.bounds.maxX + TERRAIN_PADDING;
  const terrainMinZ = options.map.bounds.minZ - TERRAIN_PADDING;
  const terrainMaxZ = options.map.bounds.maxZ + TERRAIN_PADDING;
  let terrainChunks = 0;
  let terrainVertices = 0;
  for (let z0 = terrainMinZ; z0 < terrainMaxZ - 0.001; z0 += TERRAIN_CHUNK_SIZE) {
    const z1 = Math.min(z0 + TERRAIN_CHUNK_SIZE, terrainMaxZ);
    for (let x0 = terrainMinX; x0 < terrainMaxX - 0.001; x0 += TERRAIN_CHUNK_SIZE) {
      const x1 = Math.min(x0 + TERRAIN_CHUNK_SIZE, terrainMaxX);
      const density = quality === 'high' ? 1.45 : 2.35;
      const segmentsX = Math.max(8, Math.round((x1 - x0) / density));
      const segmentsZ = Math.max(8, Math.round((z1 - z0) / density));
      const geometry = createTerrainChunkGeometry(
        options.map,
        x0,
        x1,
        z0,
        z1,
        segmentsX,
        segmentsZ,
        visualHeightAt,
      );
      const chunk = new THREE.Mesh(geometry, terrainMaterial);
      chunk.name = `titan-terrain-chunk-${terrainChunks}`;
      chunk.castShadow = false;
      chunk.receiveShadow = true;
      terrain.add(chunk);
      geometries.add(geometry);
      terrainChunks += 1;
      terrainVertices += geometry.getAttribute('position').count;
    }
  }
  group.add(terrain);

  const mountains = createPerimeterMountains(options.map, visualHeightAt, cliffMaterial, seed ^ 0x9c31);
  group.add(mountains);
  geometries.add(mountains.geometry);

  const trunkGeometry = createSlenderTrunkGeometry();
  const crownGeometry = createUmbrellaCrownGeometry();
  const grassGeometry = createGrassTuftGeometry();
  const fernGeometry = createFernCrownGeometry();
  geometries.add(trunkGeometry);
  geometries.add(crownGeometry);
  geometries.add(grassGeometry);
  geometries.add(fernGeometry);
  let treeInstances = 0;
  let crownInstances = 0;
  let grassInstances = 0;
  let fernInstances = 0;
  const vegetationMinX = options.map.bounds.minX - VEGETATION_PADDING;
  const vegetationMaxX = options.map.bounds.maxX + VEGETATION_PADDING;
  const vegetationMinZ = options.map.bounds.minZ - VEGETATION_PADDING;
  const vegetationMaxZ = options.map.bounds.maxZ + VEGETATION_PADDING;
  let tileIndex = 0;
  for (let z0 = vegetationMinZ; z0 < vegetationMaxZ - 0.001; z0 += VEGETATION_TILE_SIZE) {
    const z1 = Math.min(z0 + VEGETATION_TILE_SIZE, vegetationMaxZ);
    for (let x0 = vegetationMinX; x0 < vegetationMaxX - 0.001; x0 += VEGETATION_TILE_SIZE) {
      const x1 = Math.min(x0 + VEGETATION_TILE_SIZE, vegetationMaxX);
      const random = seededRandom(seed + tileIndex * 0x9e37 + 17);
      const area = (x1 - x0) * (z1 - z0);
      const treeTarget = Math.max(2, Math.round(area * (quality === 'high' ? 0.005 : 0.0027)));
      const grassTarget = Math.max(24, Math.round(area * (quality === 'high' ? 0.62 : 0.12)));
      const fernTarget = Math.max(8, Math.round(area * (quality === 'high' ? 0.04 : 0.017)));
      const treeScatter = createScatterRecords({
        count: treeTarget,
        random,
        x0,
        x1,
        z0,
        z1,
        map: options.map,
        visualHeightAt,
        creekCenterZ: options.creekCenterZ,
        kind: 'tree',
      });
      const trees: TreeRecord[] = treeScatter.map((record, index) => ({
        ...record,
        height: (16 + random() * 13) * record.scale,
        radius: 0.58 + random() * 0.5,
        color: new THREE.Color(0x496f50)
          .lerp(new THREE.Color(0x82a060), 0.25 + random() * 0.55)
          .offsetHSL((index % 5) * 0.004, 0, 0)
          .getHex(),
      }));
      const grass = createScatterRecords({
        count: grassTarget,
        random,
        x0,
        x1,
        z0,
        z1,
        map: options.map,
        visualHeightAt,
        creekCenterZ: options.creekCenterZ,
        kind: 'grass',
      });
      const ferns = createScatterRecords({
        count: fernTarget,
        random,
        x0,
        x1,
        z0,
        z1,
        map: options.map,
        visualHeightAt,
        creekCenterZ: options.creekCenterZ,
        kind: 'fern',
      });
      const tileCenter = new THREE.Vector3((x0 + x1) * 0.5, 0, (z0 + z1) * 0.5);
      const shadowTile = tileCenter.length() < 76 && tileIndex % 4 === 0;
      const treeGroup = createTreeTile(
        trees,
        trunkGeometry,
        crownGeometry,
        trunkMaterial,
        crownMaterial,
        shadowTile,
      );
      const understoryGroup = createUnderstoryTile(
        grass,
        ferns,
        grassGeometry,
        fernGeometry,
        grassMaterial,
        fernMaterial,
      );
      const tile = new THREE.Group();
      tile.name = `titan-vegetation-tile-${tileIndex}`;
      tile.add(treeGroup, understoryGroup);
      group.add(tile);
      vegetationTiles.push({ center: tileCenter, trees: treeGroup, understory: understoryGroup });
      treeInstances += trees.length;
      crownInstances += trees.length * 2;
      grassInstances += grass.length;
      fernInstances += ferns.length;
      tileIndex += 1;
    }
  }

  const wetRocks = createWetRockField(
    options.map,
    options.creekCenterZ,
    visualHeightAt,
    rockMaterial,
    seed ^ 0x771c,
    quality,
  );
  group.add(wetRocks);
  geometries.add(wetRocks.geometry);

  const creekMaterial = createCreekMaterial();
  const creekGeometry = createCreekGeometry(options.map, options.creekCenterZ);
  const creek = new THREE.Mesh(creekGeometry, creekMaterial);
  creek.name = 'titan-south-creek';
  creek.castShadow = false;
  creek.receiveShadow = false;
  creek.renderOrder = 2;
  group.add(creek);
  materials.add(creekMaterial);
  geometries.add(creekGeometry);

  let renderables = 0;
  let shadowCasters = 0;
  let transparentRenderables = 0;
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    renderables += 1;
    if (object.castShadow) shadowCasters += 1;
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    if (objectMaterials.some((material) => material.transparent)) transparentRenderables += 1;
  });
  const stats = Object.freeze({
    terrainChunks,
    terrainVertices,
    vegetationTiles: vegetationTiles.length,
    treeInstances,
    crownInstances,
    grassInstances,
    fernInstances,
    rockInstances: wetRocks.count,
    renderables,
    shadowCasters,
    transparentRenderables,
  });
  group.userData.renderStats = stats;

  let disposed = false;
  return {
    group,
    stats,
    update: (time, cameraPosition) => {
      for (const uniforms of windUniforms) uniforms.uForestTime.value = time;
      creekMaterial.uniforms.uTime!.value = time;
      for (const tile of vegetationTiles) {
        const distance = Math.hypot(
          cameraPosition.x - tile.center.x,
          cameraPosition.z - tile.center.z,
        );
        tile.trees.visible = distance < 205;
        tile.understory.visible = distance < 118;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      group.clear();
    },
  };
};
