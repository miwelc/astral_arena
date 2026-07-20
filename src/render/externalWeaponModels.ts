import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinnedObject } from 'three/addons/utils/SkeletonUtils.js';

import type { WeaponId } from '../game/types';
import { WEAPONS } from '../game/weapons';
import {
  createWeaponModel,
  type WeaponAnimationRole,
} from './weaponModels';

export interface ExternalWeaponSource {
  readonly assetPath: string;
  readonly sourceModel: string;
  readonly author: string;
  readonly pack: string;
  readonly sourceUrl: string;
  readonly license: 'CC0-1.0';
}

/**
 * Runtime assets and their provenance. See public/models/weapons/README.md for
 * the human-readable attribution ledger kept alongside the binary files.
 */
export const EXTERNAL_WEAPON_SOURCES: Readonly<Record<WeaponId, ExternalWeaponSource>> = {
  'pulse-rifle': {
    assetPath: 'models/weapons/pulse-rifle.glb',
    sourceModel: 'AR',
    author: 'Quaternius',
    pack: 'Sci-Fi Modular Gun Pack',
    sourceUrl: 'https://quaternius.com/packs/scifimodularguns.html',
    license: 'CC0-1.0',
  },
  sidearm: {
    assetPath: 'models/weapons/sidearm.glb',
    sourceModel: 'PEW',
    author: 'Styloo',
    pack: 'Guns Asset Pack',
    sourceUrl: 'https://styloo.itch.io/guns-asset-pack',
    license: 'CC0-1.0',
  },
  'battle-rifle': {
    assetPath: 'models/weapons/battle-rifle.glb',
    sourceModel: 'Assault Rifle B',
    author: 'Quaternius',
    pack: 'Sci-Fi Modular Gun Pack',
    sourceUrl: 'https://quaternius.com/packs/scifimodularguns.html',
    license: 'CC0-1.0',
  },
  sniper: {
    assetPath: 'models/weapons/sniper.glb',
    sourceModel: 'AWP',
    author: 'Styloo',
    pack: 'Guns Asset Pack',
    sourceUrl: 'https://styloo.itch.io/guns-asset-pack',
    license: 'CC0-1.0',
  },
  shotgun: {
    assetPath: 'models/weapons/shotgun.glb',
    sourceModel: 'Shotgun',
    author: 'Styloo',
    pack: 'Guns Asset Pack',
    sourceUrl: 'https://styloo.itch.io/guns-asset-pack',
    license: 'CC0-1.0',
  },
  'rocket-launcher': {
    assetPath: 'models/weapons/rocket-launcher.glb',
    sourceModel: 'Quad Rocket',
    author: 'Styloo',
    pack: 'Guns Asset Pack',
    sourceUrl: 'https://styloo.itch.io/guns-asset-pack',
    license: 'CC0-1.0',
  },
};

export const EXTERNAL_WEAPON_IDS = [
  'pulse-rifle',
  'sidearm',
  'battle-rifle',
  'sniper',
  'shotgun',
  'rocket-launcher',
] as const satisfies readonly WeaponId[];

const EXPECTED_ANIMATION_ROLES: Readonly<Record<WeaponId, readonly WeaponAnimationRole[]>> = {
  'pulse-rifle': ['energy-cell'],
  sidearm: ['magazine', 'slide'],
  'battle-rifle': ['bolt', 'magazine'],
  sniper: ['bolt', 'magazine'],
  shotgun: ['magazine', 'pump'],
  'rocket-launcher': ['launcher-cassette'],
};

const ANIMATION_NODE_MATCHERS: Readonly<
  Record<WeaponId, Partial<Record<WeaponAnimationRole, RegExp>>>
> = {
  'pulse-rifle': {
    'energy-cell': /magazine|energy.?cell|battery/i,
  },
  sidearm: {
    magazine: /magazine/i,
    slide: /pewhaut|slide|upper/i,
  },
  'battle-rifle': {
    magazine: /magazine/i,
    bolt: /bolt|charging/i,
  },
  sniper: {
    magazine: /magazine/i,
    bolt: /bolt|charging/i,
  },
  shotgun: {
    magazine: /magazine|shell.?carrier/i,
    pump: /pomp|pump|fore.?end/i,
  },
  'rocket-launcher': {
    'launcher-cassette': /devant|front|cassette|pod/i,
  },
};

export interface ExternalWeaponAssetLoader {
  loadAsync(url: string): Promise<Pick<GLTF, 'scene'>>;
}

export interface ExternalWeaponLoadFailure {
  readonly id: WeaponId;
  readonly error: unknown;
}

export interface ExternalWeaponLoadReport {
  readonly loaded: readonly WeaponId[];
  readonly failed: readonly ExternalWeaponLoadFailure[];
}

export type ExternalWeaponReadyListener = (id: WeaponId) => void;

const resolvedAssetUrl = (assetPath: string): string => {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${assetPath.replace(/^\//, '')}`;
};

export const externalWeaponAssetUrl = (id: WeaponId): string =>
  resolvedAssetUrl(EXTERNAL_WEAPON_SOURCES[id].assetPath);

const disposeTemporaryModel = (root: THREE.Object3D): void => {
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of meshMaterials) materials.add(material);
  });
  for (const material of materials) material.dispose();
};

const copyProceduralContract = (
  target: THREE.Group,
  procedural: THREE.Group,
  id: WeaponId,
): void => {
  target.name = `weapon-${id}`;
  target.userData = {
    ...procedural.userData,
    externalModel: true,
    externalModelAuthor: EXTERNAL_WEAPON_SOURCES[id].author,
    externalModelLicense: EXTERNAL_WEAPON_SOURCES[id].license,
    externalModelPack: EXTERNAL_WEAPON_SOURCES[id].pack,
    externalModelSource: EXTERNAL_WEAPON_SOURCES[id].sourceUrl,
  };
};

type ExternalWeaponSurface = 'ceramic' | 'functional-dark';

const externalSurfaceFor = (
  object: THREE.Object3D,
  source: THREE.Material,
): ExternalWeaponSurface => {
  const semanticName = `${object.name} ${source.name}`;
  // Keep moving/mechanical parts legible against the pale ceramic body. The
  // imported packs use Spanish, English and abbreviated Blender node names.
  return /black|grey|magazine|trigger|scope|tendon|pump|pomp|bolt|charging|cassette|devant|derierre|barrel|grip/i
    .test(semanticName)
    ? 'functional-dark'
    : 'ceramic';
};

/**
 * Preserve the source texture's wear/value information while discarding its
 * hue. This lets normal maps and authored scratches survive while moving the
 * imported paint into a dark graphite/ceramic sci-fi palette.
 */
const installCeramicAlbedoRemap = (
  material: THREE.MeshPhysicalMaterial,
  surface: ExternalWeaponSurface,
): void => {
  if (!material.map) return;
  const dark = surface === 'functional-dark';
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D(map, vMapUv);
          #ifdef DECODE_VIDEO_TEXTURE
            sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
          #endif
          float ceramicValue = dot(sampledDiffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          ceramicValue = ${dark ? 'mix(0.38, 0.94, smoothstep(0.02, 0.96, ceramicValue))' : 'mix(0.62, 1.06, smoothstep(0.02, 0.96, ceramicValue))'};
          diffuseColor *= vec4(vec3(ceramicValue), sampledDiffuseColor.a);
        #endif
      `,
    );
  };
  material.customProgramCacheKey = () => `astral-ceramic-albedo-${surface}-v1`;
};

const tuneExternalMaterials = (root: THREE.Object3D, id: WeaponId): void => {
  const replacements = new Map<string, THREE.Material>();

  const tuneMaterial = (object: THREE.Object3D, source: THREE.Material): THREE.Material => {
    if (!(source instanceof THREE.MeshStandardMaterial)) {
      return source.clone();
    }
    const surface = externalSurfaceFor(object, source);
    const cacheKey = `${source.uuid}:${surface}`;
    const cached = replacements.get(cacheKey);
    if (cached) return cached;

    const material = new THREE.MeshPhysicalMaterial({
      name: `${id}-external-${surface}-${source.name || 'surface'}`,
      color: surface === 'ceramic' ? 0x34464b : 0x101a20,
      map: source.map,
      normalMap: source.normalMap,
      normalScale: source.normalScale.clone().multiplyScalar(1.08),
      roughnessMap: source.roughnessMap,
      metalnessMap: source.metalnessMap,
      aoMap: source.aoMap,
      aoMapIntensity: source.aoMapIntensity,
      alphaMap: source.alphaMap,
      transparent: source.transparent,
      opacity: source.opacity,
      alphaTest: source.alphaTest,
      side: source.side,
      depthWrite: source.depthWrite,
      depthTest: source.depthTest,
      roughness: surface === 'ceramic' ? 0.34 : 0.48,
      metalness: surface === 'ceramic' ? 0.26 : 0.44,
      clearcoat: surface === 'ceramic' ? 0.34 : 0.14,
      clearcoatRoughness: surface === 'ceramic' ? 0.2 : 0.4,
      envMapIntensity: surface === 'ceramic' ? 1.36 : 1.12,
    });
    material.userData.externalWeaponSurface = surface;
    material.userData.ceramicAlbedoRemap = Boolean(material.map);
    installCeramicAlbedoRemap(material, surface);
    replacements.set(cacheKey, material);
    return material;
  };

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = false;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => tuneMaterial(object, material))
      : tuneMaterial(object, object.material);
  });
};

const addIdentificationAccents = (
  root: THREE.Group,
  targetBounds: THREE.Box3,
  id: WeaponId,
): void => {
  const size = targetBounds.getSize(new THREE.Vector3());
  const center = targetBounds.getCenter(new THREE.Vector3());
  const panelLength = Math.max(0.09, size.z * 0.16);
  const panelHeight = Math.max(0.018, size.y * 0.055);
  const panelDepth = Math.max(0.008, size.x * 0.025);
  const material = new THREE.MeshStandardMaterial({
    name: `${id}-external-identification-light`,
    color: WEAPONS[id].tint,
    emissive: WEAPONS[id].tint,
    emissiveIntensity: 3.2,
    roughness: 0.24,
    metalness: 0.18,
  });

  for (const side of [-1, 1] as const) {
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(panelDepth, panelHeight, panelLength),
      material,
    );
    panel.name = 'weapon-external-identification-panel';
    panel.position.set(
      side < 0 ? targetBounds.min.x - panelDepth * 0.45 : targetBounds.max.x + panelDepth * 0.45,
      center.y + size.y * 0.16,
      center.z - size.z * 0.12,
    );
    panel.castShadow = false;
    panel.receiveShadow = false;
    root.add(panel);
  }
};

const cloneProceduralAnimationPart = (
  procedural: THREE.Group,
  role: WeaponAnimationRole,
): THREE.Object3D | null => {
  const source = procedural.getObjectByName(`weapon-part-${role}`);
  if (!source) return null;

  const clone = source.clone(true);
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry = object.geometry.clone();
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
  });
  return clone;
};

const installAnimationContract = (
  root: THREE.Group,
  procedural: THREE.Group,
  id: WeaponId,
): void => {
  const objects: THREE.Object3D[] = [];
  root.traverse((object) => objects.push(object));
  const used = new Set<THREE.Object3D>();

  for (const role of EXPECTED_ANIMATION_ROLES[id]) {
    const matcher = ANIMATION_NODE_MATCHERS[id][role];
    const part = matcher
      ? objects.find((object) => !used.has(object) && matcher.test(object.name))
      : undefined;
    const target = part ?? cloneProceduralAnimationPart(procedural, role) ?? new THREE.Group();
    if (!part) {
      target.userData.externalAnimationProxy = true;
      root.add(target);
    } else {
      target.userData.sourceNodeName = target.name;
      used.add(target);
    }
    // Imported nodes live below a normalization group that carries the
    // source-to-game rotation and, often, a large scale factor. Animation
    // offsets are authored in the weapon's normalized coordinate contract;
    // leaving a part below that group both rotates and multiplies them (the
    // sidearm magazine used to jump longitudinally for exactly this reason).
    // Reparent while preserving its current transform so later offsets are
    // applied directly in stable weapon-root space.
    if (target.parent !== root) {
      root.updateMatrixWorld(true);
      root.attach(target);
    }
    target.name = `weapon-part-${role}`;
    target.userData.animationRole = role;
    target.userData.animationSpace = 'weapon-root';
  }
};

const normalizeExternalScene = (
  loadedScene: THREE.Group,
  id: WeaponId,
): THREE.Group => {
  const procedural = createWeaponModel(id);
  const proceduralBounds = new THREE.Box3().setFromObject(procedural);
  const proceduralSize = proceduralBounds.getSize(new THREE.Vector3());
  const proceduralCenter = proceduralBounds.getCenter(new THREE.Vector3());

  const root = new THREE.Group();
  copyProceduralContract(root, procedural, id);

  const visual = new THREE.Group();
  visual.name = 'weapon-external-visual';
  visual.userData.sourceModel = EXTERNAL_WEAPON_SOURCES[id].sourceModel;
  visual.rotation.y = Math.PI / 2;
  visual.add(cloneSkinnedObject(loadedScene));
  root.add(visual);

  root.updateMatrixWorld(true);
  let visualBounds = new THREE.Box3().setFromObject(visual);
  if (visualBounds.isEmpty()) {
    disposeTemporaryModel(procedural);
    throw new Error(`External weapon model '${id}' contains no renderable bounds.`);
  }

  const visualSize = visualBounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(visualSize.z) || visualSize.z < 0.0001) {
    disposeTemporaryModel(procedural);
    throw new Error(`External weapon model '${id}' has an invalid longitudinal size.`);
  }

  visual.scale.setScalar(proceduralSize.z / visualSize.z);
  root.updateMatrixWorld(true);
  visualBounds = new THREE.Box3().setFromObject(visual);
  const visualCenter = visualBounds.getCenter(new THREE.Vector3());
  visual.position.x += proceduralCenter.x - visualCenter.x;
  visual.position.y += proceduralCenter.y - visualCenter.y;
  visual.position.z += proceduralBounds.min.z - visualBounds.min.z;
  root.updateMatrixWorld(true);

  tuneExternalMaterials(visual, id);
  installAnimationContract(root, procedural, id);
  addIdentificationAccents(root, proceduralBounds, id);
  disposeTemporaryModel(procedural);

  root.traverse((object) => {
    object.userData.sharedVisualTemplate = true;
  });
  return root;
};

/**
 * The shared library keeps decoded GLTF templates alive across renderer
 * instances. A renderer owns and disposes its local weapon template, so clone
 * GPU resources once here; closing one match must not invalidate the cached
 * asset used by the next match.
 */
const cloneTemplateForRenderer = (template: THREE.Group): THREE.Group => {
  const clone = cloneSkinnedObject(template) as THREE.Group;
  const geometries = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
  const materials = new Map<THREE.Material, THREE.Material>();
  const cloneMaterial = (material: THREE.Material): THREE.Material => {
    const existing = materials.get(material);
    if (existing) return existing;
    const owned = material.clone();
    // Three.js intentionally does not copy shader callbacks in Material.copy.
    // Preserve our achromatic ceramic remap on independently disposable
    // renderer clones or the imported green/wood albedo would reappear.
    owned.onBeforeCompile = material.onBeforeCompile;
    owned.customProgramCacheKey = material.customProgramCacheKey;
    materials.set(material, owned);
    return owned;
  };
  clone.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceGeometry = object.geometry;
    const cachedGeometry = geometries.get(sourceGeometry);
    const ownedGeometry = cachedGeometry ?? sourceGeometry.clone();
    if (!cachedGeometry) geometries.set(sourceGeometry, ownedGeometry);
    object.geometry = ownedGeometry;
    object.material = Array.isArray(object.material)
      ? object.material.map(cloneMaterial)
      : cloneMaterial(object.material);
  });
  return clone;
};

/**
 * Owns asynchronously loaded immutable templates. The application preloads
 * and awaits all local GLBs before constructing a match renderer. `create()`
 * still has a synchronous procedural resilience path so one corrupt file or a
 * platform-specific GLTF decode failure cannot prevent the match from opening.
 */
export class ExternalWeaponModelLibrary {
  private readonly templates = new Map<WeaponId, THREE.Group>();
  private readonly inFlight = new Map<WeaponId, Promise<THREE.Group>>();
  private readonly listeners = new Set<ExternalWeaponReadyListener>();

  constructor(
    private readonly loader: ExternalWeaponAssetLoader = new GLTFLoader(),
  ) {}

  has(id: WeaponId): boolean {
    return this.templates.has(id);
  }

  getTemplate(id: WeaponId): THREE.Group | null {
    return this.templates.get(id) ?? null;
  }

  create(id: WeaponId): THREE.Group {
    const template = this.templates.get(id);
    return template
      ? cloneTemplateForRenderer(template)
      : createWeaponModel(id);
  }

  subscribe(listener: ExternalWeaponReadyListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(id: WeaponId): Promise<THREE.Group> {
    const ready = this.templates.get(id);
    if (ready) return Promise.resolve(ready);

    const pending = this.inFlight.get(id);
    if (pending) return pending;

    const request = this.loader
      .loadAsync(externalWeaponAssetUrl(id))
      .then(({ scene }) => {
        const template = normalizeExternalScene(scene, id);
        this.templates.set(id, template);
        this.inFlight.delete(id);
        for (const listener of this.listeners) {
          try {
            listener(id);
          } catch {
            // A renderer refresh callback must not turn a successfully loaded
            // template into a failed request for every other subscriber.
          }
        }
        return template;
      })
      .catch((error: unknown) => {
        this.inFlight.delete(id);
        throw error;
      });
    this.inFlight.set(id, request);
    return request;
  }

  async preload(
    ids: readonly WeaponId[] = EXTERNAL_WEAPON_IDS,
  ): Promise<ExternalWeaponLoadReport> {
    const results = await Promise.allSettled(ids.map((id) => this.load(id)));
    const loaded: WeaponId[] = [];
    const failed: ExternalWeaponLoadFailure[] = [];
    results.forEach((result, index) => {
      const id = ids[index];
      if (!id) return;
      if (result.status === 'fulfilled') loaded.push(id);
      else failed.push({ id, error: result.reason as unknown });
    });
    return { loaded, failed };
  }
}

const sharedExternalWeaponModels = new ExternalWeaponModelLibrary();

export const preloadExternalWeaponModels = (
  ids?: readonly WeaponId[],
): Promise<ExternalWeaponLoadReport> => sharedExternalWeaponModels.preload(ids);

export const createPreferredWeaponModel = (id: WeaponId): THREE.Group =>
  // The authored pulse rifle has a substantially richer first-person
  // silhouette (optic, vent banks, rails and articulated energy cell) than
  // the low-poly source AR. Keep the imported library for the other weapons,
  // but use the detailed native hero model for the weapon seen most often.
  id === 'pulse-rifle' ? createWeaponModel(id) : sharedExternalWeaponModels.create(id);

export const hasExternalWeaponModel = (id: WeaponId): boolean =>
  sharedExternalWeaponModels.has(id);

export const onExternalWeaponModelReady = (
  listener: ExternalWeaponReadyListener,
): (() => void) => sharedExternalWeaponModels.subscribe(listener);
