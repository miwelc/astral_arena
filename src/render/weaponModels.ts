import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import type { WeaponId } from '../game/types';
import { WEAPONS } from '../game/weapons';

type VectorTuple = readonly [x: number, y: number, z: number];

export type WeaponAnimationRole =
  | 'magazine'
  | 'energy-cell'
  | 'slide'
  | 'bolt'
  | 'pump'
  | 'launcher-cassette';

const markAnimationPart = <TObject extends THREE.Object3D>(
  object: TObject,
  role: WeaponAnimationRole,
): TObject => {
  object.name = `weapon-part-${role}`;
  object.userData.animationRole = role;
  return object;
};

export interface WeaponViewPose {
  readonly scale: number;
  readonly position: VectorTuple;
  readonly rotation: VectorTuple;
}

/**
 * The weapon origins sit at the primary hand, so these poses only have to
 * compensate for each silhouette rather than repairing arbitrary pivots.
 */
export const WEAPON_VIEW_POSES: Readonly<Record<WeaponId, WeaponViewPose>> = {
  'pulse-rifle': {
    scale: 0.58,
    position: [0.015, 0.015, -0.08],
    rotation: [-0.015, -0.015, 0],
  },
  sidearm: {
    scale: 0.7,
    position: [0.035, -0.035, -0.035],
    rotation: [-0.025, -0.025, -0.01],
  },
  'battle-rifle': {
    scale: 0.55,
    position: [0.005, 0.005, -0.045],
    rotation: [-0.01, -0.018, 0],
  },
  sniper: {
    scale: 0.48,
    position: [-0.005, -0.015, 0.025],
    rotation: [-0.012, -0.012, 0],
  },
  shotgun: {
    scale: 0.56,
    position: [0.012, -0.01, -0.04],
    rotation: [-0.018, -0.014, 0],
  },
  'rocket-launcher': {
    scale: 0.46,
    position: [-0.035, -0.055, 0.08],
    rotation: [-0.025, 0.01, -0.015],
  },
};

interface WeaponMaterials {
  paint: THREE.MeshStandardMaterial;
  polymer: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  lens: THREE.MeshPhysicalMaterial;
  bore: THREE.MeshBasicMaterial;
}

interface ModelBuilder {
  readonly group: THREE.Group;
  readonly materials: WeaponMaterials;
  rounded(
    size: VectorTuple,
    position: VectorTuple,
    material?: THREE.Material,
    radius?: number,
    rotation?: VectorTuple,
    castShadow?: boolean,
  ): THREE.Mesh;
  box(
    size: VectorTuple,
    position: VectorTuple,
    material?: THREE.Material,
    rotation?: VectorTuple,
    castShadow?: boolean,
  ): THREE.Mesh;
  cylinder(
    radiusFront: number,
    radiusRear: number,
    length: number,
    position: VectorTuple,
    material?: THREE.Material,
    radialSegments?: number,
    castShadow?: boolean,
  ): THREE.Mesh;
  ring(
    radius: number,
    tube: number,
    position: VectorTuple,
    material?: THREE.Material,
    radialSegments?: number,
  ): THREE.Mesh;
  lens(radius: number, position: VectorTuple, color?: number): THREE.Mesh;
}

const setTransform = (
  object: THREE.Object3D,
  position: VectorTuple,
  rotation?: VectorTuple,
): void => {
  object.position.set(...position);
  if (rotation) object.rotation.set(...rotation);
};

const createMaterials = (id: WeaponId): WeaponMaterials => {
  const tint = WEAPONS[id].tint;
  const paint = new THREE.MeshStandardMaterial({
    name: `${id}-ceramic-paint`,
    color: 0x263b48,
    roughness: 0.34,
    metalness: 0.58,
    envMapIntensity: 1.15,
  });
  const polymer = new THREE.MeshStandardMaterial({
    name: `${id}-dark-polymer`,
    color: 0x0d1b24,
    roughness: 0.72,
    metalness: 0.14,
    envMapIntensity: 0.72,
  });
  const metal = new THREE.MeshStandardMaterial({
    name: `${id}-exposed-metal`,
    color: 0x80949c,
    roughness: 0.24,
    metalness: 0.88,
    envMapIntensity: 1.35,
  });
  const accent = new THREE.MeshStandardMaterial({
    name: `${id}-energy-accent`,
    color: tint,
    emissive: tint,
    emissiveIntensity: 1.75,
    roughness: 0.3,
    metalness: 0.35,
    envMapIntensity: 1.1,
  });
  const lens = new THREE.MeshPhysicalMaterial({
    name: `${id}-optic-glass`,
    color: 0x132a39,
    emissive: tint,
    emissiveIntensity: 0.32,
    roughness: 0.06,
    metalness: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 1.8,
  });
  const bore = new THREE.MeshBasicMaterial({
    name: `${id}-barrel-bore`,
    color: 0x020609,
    side: THREE.DoubleSide,
  });
  return { paint, polymer, metal, accent, lens, bore };
};

const createBuilder = (id: WeaponId): ModelBuilder => {
  const group = new THREE.Group();
  group.name = `weapon-${id}`;
  const materials = createMaterials(id);

  return {
    group,
    materials,
    rounded: (
      size,
      position,
      material = materials.paint,
      radius = 0.035,
      rotation,
      castShadow = true,
    ) => {
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius),
        material,
      );
      setTransform(mesh, position, rotation);
      mesh.castShadow = castShadow;
      group.add(mesh);
      return mesh;
    },
    box: (
      size,
      position,
      material = materials.paint,
      rotation,
      castShadow = false,
    ) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      setTransform(mesh, position, rotation);
      mesh.castShadow = castShadow;
      group.add(mesh);
      return mesh;
    },
    cylinder: (
      radiusFront,
      radiusRear,
      length,
      position,
      material = materials.metal,
      radialSegments = 12,
      castShadow = true,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radiusFront, radiusRear, length, radialSegments, 1, false),
        material,
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(...position);
      mesh.castShadow = castShadow;
      group.add(mesh);
      return mesh;
    },
    ring: (
      radius,
      tube,
      position,
      material = materials.metal,
      radialSegments = 14,
    ) => {
      const mesh = new THREE.Mesh(
        new THREE.TorusGeometry(radius, tube, 6, radialSegments),
        material,
      );
      mesh.position.set(...position);
      group.add(mesh);
      return mesh;
    },
    lens: (radius, position, color = WEAPONS[id].tint) => {
      const material = color === WEAPONS[id].tint ? materials.lens : materials.lens.clone();
      if (material !== materials.lens) {
        material.color.setHex(color);
        material.emissive.setHex(color);
      }
      const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 16), material);
      mesh.position.set(...position);
      group.add(mesh);
      return mesh;
    },
  };
};

const addMuzzle = (
  builder: ModelBuilder,
  position: VectorTuple,
  radius: number,
  accent = false,
): void => {
  const { materials } = builder;
  builder.ring(radius, Math.max(0.014, radius * 0.18), position, accent ? materials.accent : materials.metal);
  const bore = new THREE.Mesh(new THREE.CircleGeometry(radius * 0.72, 14), materials.bore);
  bore.position.set(position[0], position[1], position[2] - 0.003);
  bore.rotation.y = Math.PI;
  builder.group.add(bore);
};

const addScope = (
  builder: ModelBuilder,
  position: VectorTuple,
  length: number,
  radius: number,
  largeObjective = false,
): void => {
  const { materials } = builder;
  builder.cylinder(radius, radius, length, position, materials.polymer, 14, false);
  builder.ring(radius * 1.03, radius * 0.12, [position[0], position[1], position[2] - length * 0.48], materials.metal);
  builder.ring(radius * 1.03, radius * 0.12, [position[0], position[1], position[2] + length * 0.48], materials.metal);
  if (largeObjective) {
    builder.cylinder(
      radius * 1.25,
      radius,
      length * 0.22,
      [position[0], position[1], position[2] - length * 0.53],
      materials.paint,
      14,
      false,
    );
  }
  builder.lens(
    radius * (largeObjective ? 1.04 : 0.78),
    [position[0], position[1], position[2] + length * 0.505],
  );
  builder.rounded([radius * 0.42, 0.075, 0.14], [position[0], position[1] - radius - 0.045, position[2] - length * 0.2], materials.metal, 0.018, undefined, false);
  builder.rounded([radius * 0.42, 0.075, 0.14], [position[0], position[1] - radius - 0.045, position[2] + length * 0.2], materials.metal, 0.018, undefined, false);
};

const addSideRail = (
  builder: ModelBuilder,
  x: number,
  y: number,
  startZ: number,
  count: number,
  step: number,
): void => {
  for (let index = 0; index < count; index += 1) {
    builder.box(
      [0.028, 0.035, step * 0.55],
      [x, y, startZ - index * step],
      builder.materials.metal,
    );
  }
};

const buildSidearm = (builder: ModelBuilder): void => {
  const { materials } = builder;
  const slide = builder.rounded([0.25, 0.2, 0.72], [0, 0.14, -0.24], materials.paint, 0.035);
  markAnimationPart(slide, 'slide');
  builder.rounded([0.22, 0.14, 0.43], [0, 0.015, -0.08], materials.polymer, 0.025);
  builder.rounded([0.19, 0.43, 0.23], [0, -0.245, 0.045], materials.polymer, 0.045, [-0.2, 0, 0]);
  const magazine = builder.rounded(
    [0.145, 0.31, 0.145],
    [0, -0.285, 0.045],
    materials.metal,
    0.024,
    [-0.2, 0, 0],
    false,
  );
  markAnimationPart(magazine, 'magazine');
  builder.box([0.012, 0.085, 0.36], [-0.131, 0.14, -0.23], materials.accent);
  builder.rounded([0.15, 0.025, 0.22], [0, 0.247, -0.24], materials.metal, 0.008, undefined, false);
  builder.box([0.13, 0.025, 0.16], [0.126, 0.17, -0.12], materials.polymer);
  builder.cylinder(0.058, 0.058, 0.43, [0, 0.11, -0.36], materials.metal, 12);
  addMuzzle(builder, [0, 0.11, -0.6], 0.066);

  const triggerGuard = new THREE.Mesh(
    new THREE.TorusGeometry(0.105, 0.016, 5, 14),
    materials.metal,
  );
  triggerGuard.scale.set(1, 0.72, 1);
  triggerGuard.rotation.y = Math.PI / 2;
  triggerGuard.position.set(0, -0.09, -0.075);
  builder.group.add(triggerGuard);

  builder.box([0.045, 0.05, 0.055], [0, 0.27, -0.54], materials.metal);
  builder.box([0.09, 0.05, 0.055], [0, 0.27, 0.01], materials.metal);
  builder.box([0.21, 0.035, 0.055], [0, -0.47, 0.09], materials.metal);
  builder.group.userData.primaryGrip = new THREE.Vector3(0, -0.2, 0.04);
  builder.group.userData.supportGrip = new THREE.Vector3(0, 0, -0.2);
  builder.group.userData.muzzle = new THREE.Vector3(0, 0.11, -0.61);
};

const buildPulseRifle = (builder: ModelBuilder): void => {
  const { materials } = builder;
  builder.rounded([0.36, 0.34, 0.92], [0, 0.08, -0.39], materials.paint, 0.06);
  builder.rounded([0.38, 0.39, 0.48], [0, 0.015, 0.3], materials.polymer, 0.07, [-0.06, 0, 0]);
  builder.rounded([0.29, 0.17, 0.78], [0, 0.29, -0.36], materials.polymer, 0.035);
  builder.rounded([0.2, 0.4, 0.2], [0, -0.255, 0.035], materials.polymer, 0.04, [-0.16, 0, 0]);
  builder.rounded([0.3, 0.23, 0.42], [0, -0.025, -0.79], materials.polymer, 0.04);
  builder.cylinder(0.058, 0.07, 0.58, [0, 0.105, -1.01], materials.metal, 12);
  addMuzzle(builder, [0, 0.105, -1.32], 0.078, true);

  const energyCell = builder.rounded(
    [0.1, 0.29, 0.34],
    [0.205, -0.045, 0.24],
    materials.metal,
    0.03,
    [0.1, 0, -0.08],
    false,
  );
  markAnimationPart(energyCell, 'energy-cell');
  builder.rounded([0.018, 0.085, 0.48], [-0.189, 0.075, -0.38], materials.accent, 0.006, undefined, false);
  for (const z of [-0.2, -0.39, -0.58]) {
    builder.box([0.025, 0.075, 0.1], [0.19, 0.105, z], materials.accent);
  }
  builder.rounded([0.12, 0.1, 0.24], [0, 0.43, -0.42], materials.paint, 0.025, undefined, false);
  builder.lens(0.043, [0, 0.43, -0.545]);
  addSideRail(builder, -0.19, 0.31, -0.18, 5, 0.12);
  builder.group.userData.primaryGrip = new THREE.Vector3(0, -0.2, 0.03);
  builder.group.userData.supportGrip = new THREE.Vector3(0, -0.05, -0.66);
  builder.group.userData.muzzle = new THREE.Vector3(0, 0.105, -1.33);
};

const buildBattleRifle = (builder: ModelBuilder): void => {
  const { materials } = builder;
  builder.rounded([0.31, 0.29, 0.9], [0, 0.08, -0.37], materials.paint, 0.045);
  builder.rounded([0.3, 0.29, 0.58], [0, 0.035, 0.36], materials.polymer, 0.055, [0.04, 0, 0]);
  builder.rounded([0.19, 0.42, 0.2], [0, -0.25, 0.055], materials.polymer, 0.035, [-0.18, 0, 0]);
  const magazine = builder.rounded(
    [0.19, 0.4, 0.2],
    [0, -0.21, -0.28],
    materials.metal,
    0.025,
    [0.13, 0, 0],
    false,
  );
  markAnimationPart(magazine, 'magazine');
  builder.rounded([0.27, 0.2, 0.38], [0, 0.045, -0.92], materials.polymer, 0.04);
  builder.cylinder(0.045, 0.055, 0.84, [0, 0.11, -1.33], materials.metal, 12);
  builder.cylinder(0.075, 0.075, 0.18, [0, 0.11, -1.76], materials.paint, 10);
  addMuzzle(builder, [0, 0.11, -1.86], 0.072);

  addScope(builder, [0, 0.36, -0.38], 0.52, 0.09);
  builder.box([0.018, 0.075, 0.46], [-0.162, 0.095, -0.4], materials.accent);
  builder.rounded([0.23, 0.08, 0.42], [0, 0.29, 0.27], materials.paint, 0.02, undefined, false);
  builder.box([0.2, 0.045, 0.18], [0, -0.07, 0.66], materials.metal);
  const bolt = builder.rounded(
    [0.055, 0.075, 0.28],
    [0.175, 0.135, -0.18],
    materials.metal,
    0.014,
    undefined,
    false,
  );
  markAnimationPart(bolt, 'bolt');
  addSideRail(builder, 0.165, 0.23, -0.69, 4, 0.12);
  builder.group.userData.primaryGrip = new THREE.Vector3(0, -0.2, 0.05);
  builder.group.userData.supportGrip = new THREE.Vector3(0, -0.02, -0.73);
  builder.group.userData.muzzle = new THREE.Vector3(0, 0.11, -1.87);
};

const buildSniper = (builder: ModelBuilder): void => {
  const { materials } = builder;
  builder.rounded([0.29, 0.3, 0.96], [0, 0.07, -0.38], materials.paint, 0.045);
  builder.rounded([0.28, 0.24, 0.66], [0, 0.02, 0.45], materials.polymer, 0.055, [0.05, 0, 0]);
  builder.rounded([0.18, 0.43, 0.2], [0, -0.25, 0.08], materials.polymer, 0.035, [-0.2, 0, 0]);
  const magazine = builder.rounded(
    [0.16, 0.4, 0.18],
    [0, -0.2, -0.31],
    materials.metal,
    0.025,
    [0.12, 0, 0],
    false,
  );
  markAnimationPart(magazine, 'magazine');
  builder.rounded([0.24, 0.17, 0.42], [0, 0.08, -0.98], materials.polymer, 0.03);
  builder.cylinder(0.038, 0.05, 1.2, [0, 0.13, -1.5], materials.metal, 12);

  builder.cylinder(0.082, 0.082, 0.25, [0, 0.13, -2.14], materials.paint, 10);
  builder.ring(0.087, 0.018, [0, 0.13, -2.02], materials.metal);
  builder.ring(0.087, 0.018, [0, 0.13, -2.14], materials.metal);
  addMuzzle(builder, [0, 0.13, -2.275], 0.074, true);

  addScope(builder, [0, 0.39, -0.45], 0.82, 0.115, true);
  builder.rounded([0.25, 0.08, 0.44], [0, 0.27, 0.37], materials.paint, 0.025, undefined, false);
  builder.box([0.016, 0.08, 0.5], [-0.151, 0.075, -0.4], materials.accent);

  const boltAssembly = markAnimationPart(new THREE.Group(), 'bolt');
  builder.group.add(boltAssembly);
  const bolt = builder.cylinder(0.025, 0.025, 0.18, [0.23, 0.13, -0.16], materials.metal, 8, false);
  bolt.rotation.set(0, 0, Math.PI / 2);
  builder.group.remove(bolt);
  boltAssembly.add(bolt);
  const boltKnob = builder.cylinder(0.055, 0.055, 0.06, [0.32, 0.13, -0.16], materials.metal, 10, false);
  boltKnob.rotation.set(0, 0, Math.PI / 2);
  builder.group.remove(boltKnob);
  boltAssembly.add(boltKnob);

  for (const side of [-1, 1]) {
    const foldedLeg = builder.cylinder(0.018, 0.022, 0.56, [side * 0.11, -0.115, -1.04], materials.metal, 7, false);
    foldedLeg.rotation.set(Math.PI / 2 + 0.13, 0, side * 0.11);
  }
  builder.group.userData.primaryGrip = new THREE.Vector3(0, -0.2, 0.08);
  builder.group.userData.supportGrip = new THREE.Vector3(0, -0.02, -0.83);
  builder.group.userData.muzzle = new THREE.Vector3(0, 0.13, -2.285);
};

const buildShotgun = (builder: ModelBuilder): void => {
  const { materials } = builder;
  builder.rounded([0.35, 0.34, 0.58], [0, 0.045, -0.25], materials.paint, 0.055);
  builder.rounded([0.32, 0.31, 0.7], [0, 0.015, 0.39], materials.polymer, 0.065, [0.06, 0, 0]);
  builder.rounded([0.2, 0.42, 0.21], [0, -0.245, 0.075], materials.polymer, 0.04, [-0.2, 0, 0]);

  builder.cylinder(0.09, 0.105, 1.08, [0, 0.13, -0.9], materials.metal, 14);
  builder.cylinder(0.065, 0.072, 0.94, [0, -0.04, -0.82], materials.metal, 12);
  addMuzzle(builder, [0, 0.13, -1.465], 0.105);
  builder.ring(0.073, 0.014, [0, -0.04, -1.31], materials.paint);

  const pumpAssembly = markAnimationPart(new THREE.Group(), 'pump');
  builder.group.add(pumpAssembly);
  const pump = builder.rounded([0.39, 0.29, 0.45], [0, 0.0, -0.72], materials.polymer, 0.055);
  builder.group.remove(pump);
  pumpAssembly.add(pump);
  for (const z of [-0.56, -0.65, -0.74, -0.83, -0.92]) {
    const rib = builder.box([0.405, 0.025, 0.025], [0, -0.015, z], materials.metal);
    builder.group.remove(rib);
    pumpAssembly.add(rib);
  }
  const shellCarrier = builder.rounded(
    [0.16, 0.095, 0.34],
    [0, -0.135, -0.2],
    materials.metal,
    0.025,
    [0.08, 0, 0],
    false,
  );
  markAnimationPart(shellCarrier, 'magazine');
  for (let index = 0; index < 6; index += 1) {
    const active = index < 2;
    builder.box(
      [0.018, 0.035, 0.07],
      [-0.184, 0.12, -0.1 - index * 0.075],
      active ? materials.accent : materials.metal,
    );
  }
  builder.rounded([0.11, 0.09, 0.22], [0, 0.285, -0.18], materials.polymer, 0.02, undefined, false);
  builder.box([0.06, 0.055, 0.04], [0, 0.36, -0.37], materials.accent);
  builder.group.userData.primaryGrip = new THREE.Vector3(0, -0.2, 0.07);
  builder.group.userData.supportGrip = new THREE.Vector3(0, -0.03, -0.72);
  builder.group.userData.muzzle = new THREE.Vector3(0, 0.13, -1.475);
};

const buildRocketLauncher = (builder: ModelBuilder): void => {
  const { materials } = builder;
  for (const x of [-0.19, 0.19]) {
    builder.cylinder(0.155, 0.17, 1.48, [x, 0.08, -0.42], materials.paint, 14);
    builder.ring(0.166, 0.026, [x, 0.08, -1.17], materials.accent);
    builder.ring(0.176, 0.028, [x, 0.08, 0.34], materials.metal);

    const frontBore = new THREE.Mesh(new THREE.CircleGeometry(0.13, 16), materials.bore);
    frontBore.position.set(x, 0.08, -1.182);
    frontBore.rotation.y = Math.PI;
    builder.group.add(frontBore);

    builder.cylinder(0.22, 0.16, 0.3, [x, 0.08, 0.48], materials.metal, 14);
    builder.ring(0.218, 0.023, [x, 0.08, 0.64], materials.polymer);
  }

  builder.rounded([0.67, 0.26, 0.48], [0, -0.02, -0.1], materials.polymer, 0.055);
  builder.rounded([0.18, 0.43, 0.22], [0.12, -0.3, 0.04], materials.polymer, 0.04, [-0.16, 0, 0]);
  builder.rounded([0.48, 0.22, 0.27], [0, 0.3, -0.24], materials.paint, 0.045, undefined, false);
  builder.rounded([0.15, 0.13, 0.44], [-0.13, 0.41, -0.25], materials.polymer, 0.03, undefined, false);
  builder.lens(0.058, [-0.13, 0.41, -0.48]);
  builder.box([0.38, 0.026, 0.12], [0, 0.43, 0.08], materials.accent);
  builder.box([0.03, 0.11, 0.52], [-0.35, 0.08, -0.34], materials.accent);
  const cassette = builder.rounded(
    [0.58, 0.24, 0.16],
    [0, 0.04, 0.76],
    materials.polymer,
    0.05,
  );
  markAnimationPart(cassette, 'launcher-cassette');
  builder.group.userData.primaryGrip = new THREE.Vector3(0.12, -0.25, 0.04);
  builder.group.userData.supportGrip = new THREE.Vector3(-0.17, -0.03, -0.38);
  builder.group.userData.muzzle = new THREE.Vector3(-0.19, 0.08, -1.19);
  builder.group.userData.secondaryMuzzle = new THREE.Vector3(0.19, 0.08, -1.19);
};

/**
 * Builds a cached-ready weapon template. The renderer can clone this group;
 * geometries and materials remain shared between clones.
 */
export const createWeaponModel = (id: WeaponId): THREE.Group => {
  const builder = createBuilder(id);

  switch (id) {
    case 'sidearm':
      buildSidearm(builder);
      break;
    case 'pulse-rifle':
      buildPulseRifle(builder);
      break;
    case 'battle-rifle':
      buildBattleRifle(builder);
      break;
    case 'sniper':
      buildSniper(builder);
      break;
    case 'shotgun':
      buildShotgun(builder);
      break;
    case 'rocket-launcher':
      buildRocketLauncher(builder);
      break;
  }

  builder.group.userData.weaponId = id;
  builder.group.userData.viewPose = WEAPON_VIEW_POSES[id];
  builder.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.receiveShadow = false;
  });
  return builder.group;
};
