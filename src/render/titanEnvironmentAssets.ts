import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const TITAN_ASSET_ROOT = 'assets/titan';

export const TITAN_GRASS_VARIANT_NAMES = [
  'grass_bermuda_01_dead_a',
  'grass_bermuda_01_dead_b',
  'grass_bermuda_01_flattened_a',
  'grass_bermuda_01_medium_a',
  'grass_bermuda_01_medium_b',
  'grass_bermuda_01_medium_c',
  'grass_bermuda_01_medium_d',
  'grass_bermuda_01_medium_e',
  'grass_bermuda_01_medium_f',
  'grass_bermuda_01_seedling_a',
  'grass_bermuda_01_seedling_b',
  'grass_bermuda_01_seedling_c',
  'grass_bermuda_01_seedling_d',
  'grass_bermuda_01_single_a',
  'grass_bermuda_01_single_b',
  'grass_bermuda_01_small_a',
  'grass_bermuda_01_small_b',
  'grass_bermuda_01_small_c',
  'grass_bermuda_01_small_d',
  'grass_bermuda_01_small_e',
  'grass_bermuda_01_small_f',
] as const;

export const TITAN_FERN_VARIANT_NAMES = [
  'fern_02_a',
  'fern_02_b',
  'fern_02_c',
  'fern_02_d',
] as const;

export const TITAN_ROCK_VARIANT_NAMES = [
  'rock_moss_set_02_rock07',
  'rock_moss_set_02_rock08',
  'rock_moss_set_02_rock09',
  'rock_moss_set_02_rock10',
  'rock_moss_set_02_rock11',
  'rock_moss_set_02_rock12',
  'rock_moss_set_02_rock13',
] as const;

export const TITAN_CLIFF_VARIANT_NAME = 'rock_face_01' as const;

export type TitanGrassVariantName = typeof TITAN_GRASS_VARIANT_NAMES[number];
export type TitanFernVariantName = typeof TITAN_FERN_VARIANT_NAMES[number];
export type TitanRockVariantName = typeof TITAN_ROCK_VARIANT_NAMES[number];

export const TITAN_ENVIRONMENT_ASSET_PATHS = Object.freeze({
  grass: `${TITAN_ASSET_ROOT}/grass_bermuda_01/grass_bermuda_01_1k.gltf`,
  ferns: `${TITAN_ASSET_ROOT}/fern_02/fern_02_1k.gltf`,
  fernAlpha: `${TITAN_ASSET_ROOT}/fern_02/textures/fern_02_alpha_1k.png`,
  rocks: `${TITAN_ASSET_ROOT}/rock_moss_set_02/rock_moss_set_02_1k.gltf`,
  cliff: `${TITAN_ASSET_ROOT}/rock_face_01/rock_face_01_1k.gltf`,
  environment: `${TITAN_ASSET_ROOT}/environment/schachen_forest_1k.hdr`,
  groundAlbedo: `${TITAN_ASSET_ROOT}/forest_ground/forrest_ground_01_diff_1k.jpg`,
  groundNormal: `${TITAN_ASSET_ROOT}/forest_ground/forrest_ground_01_nor_gl_1k.jpg`,
  groundRoughness: `${TITAN_ASSET_ROOT}/forest_ground/forrest_ground_01_rough_1k.jpg`,
  barkAlbedo: `${TITAN_ASSET_ROOT}/bark/Bark012_1K-JPG_Color.jpg`,
  barkNormal: `${TITAN_ASSET_ROOT}/bark/Bark012_1K-JPG_NormalGL.jpg`,
  barkRoughness: `${TITAN_ASSET_ROOT}/bark/Bark012_1K-JPG_Roughness.jpg`,
  leafAlbedo: `${TITAN_ASSET_ROOT}/foliage/LeafSet024_1K-JPG_Color.jpg`,
  leafNormal: `${TITAN_ASSET_ROOT}/foliage/LeafSet024_1K-JPG_NormalGL.jpg`,
  leafOpacity: `${TITAN_ASSET_ROOT}/foliage/LeafSet024_1K-JPG_Opacity.jpg`,
  leafRoughness: `${TITAN_ASSET_ROOT}/foliage/LeafSet024_1K-JPG_Roughness.jpg`,
});

export interface TitanEnvironmentSourceMetadata {
  readonly id: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly sourceUrl: string;
  readonly license: 'CC0-1.0';
  readonly kind: 'model' | 'texture' | 'hdri';
}

/**
 * Provenance for every third-party environment source bundled under
 * `public/assets/titan`. CC0 does not require attribution, but keeping this
 * ledger beside the runtime contract makes future asset audits deterministic.
 */
export const TITAN_ENVIRONMENT_SOURCES = Object.freeze({
  grass: Object.freeze({
    id: 'grass_bermuda_01',
    title: 'Grass Bermuda 01',
    authors: Object.freeze(['Rico Cilliers']),
    sourceUrl: 'https://polyhaven.com/a/grass_bermuda_01',
    license: 'CC0-1.0',
    kind: 'model',
  }),
  ferns: Object.freeze({
    id: 'fern_02',
    title: 'Fern 02',
    authors: Object.freeze(['Rob Tuytel', 'Rico Cilliers']),
    sourceUrl: 'https://polyhaven.com/a/fern_02',
    license: 'CC0-1.0',
    kind: 'model',
  }),
  rocks: Object.freeze({
    id: 'rock_moss_set_02',
    title: 'Rock Moss Set 02',
    authors: Object.freeze(['Kless Gyzen']),
    sourceUrl: 'https://polyhaven.com/a/rock_moss_set_02',
    license: 'CC0-1.0',
    kind: 'model',
  }),
  cliff: Object.freeze({
    id: 'rock_face_01',
    title: 'Rock Face 01',
    authors: Object.freeze(['Dario Barresi']),
    sourceUrl: 'https://polyhaven.com/a/rock_face_01',
    license: 'CC0-1.0',
    kind: 'model',
  }),
  ground: Object.freeze({
    id: 'forrest_ground_01',
    title: 'Forest Ground 01',
    authors: Object.freeze(['Rob Tuytel']),
    sourceUrl: 'https://polyhaven.com/a/forrest_ground_01',
    license: 'CC0-1.0',
    kind: 'texture',
  }),
  bark: Object.freeze({
    id: 'Bark012',
    title: 'Bark 012',
    authors: Object.freeze(['ambientCG']),
    sourceUrl: 'https://ambientcg.com/view?id=Bark012',
    license: 'CC0-1.0',
    kind: 'texture',
  }),
  foliage: Object.freeze({
    id: 'LeafSet024',
    title: 'Leaf Set 024',
    authors: Object.freeze(['ambientCG']),
    sourceUrl: 'https://ambientcg.com/view?id=LeafSet024',
    license: 'CC0-1.0',
    kind: 'texture',
  }),
  environment: Object.freeze({
    id: 'schachen_forest',
    title: 'Schachen Forest',
    authors: Object.freeze(['Adrian Kubasa']),
    sourceUrl: 'https://polyhaven.com/a/schachen_forest',
    license: 'CC0-1.0',
    kind: 'hdri',
  }),
} satisfies Readonly<Record<string, TitanEnvironmentSourceMetadata>>);

export interface TitanNamedMeshAsset<Name extends string = string> {
  readonly name: Name;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

export interface TitanGroundTextureAssets {
  readonly albedo: THREE.Texture;
  readonly normal: THREE.Texture;
  readonly roughness: THREE.Texture;
}

/** PBR maps used by the procedural tree trunk and canopy materials. */
export interface TitanTreeTextureAssets {
  readonly barkAlbedo: THREE.Texture;
  readonly barkNormal: THREE.Texture;
  readonly barkRoughness: THREE.Texture;
  readonly leafAlbedo: THREE.Texture;
  readonly leafNormal: THREE.Texture;
  readonly leafOpacity: THREE.Texture;
  readonly leafRoughness: THREE.Texture;
}

export interface TitanEnvironmentAssets {
  readonly environmentEquirect: THREE.DataTexture;
  readonly ground: Readonly<TitanGroundTextureAssets>;
  readonly textures: Readonly<TitanTreeTextureAssets>;
  readonly grass: ReadonlyMap<TitanGrassVariantName, TitanNamedMeshAsset<TitanGrassVariantName>>;
  readonly ferns: ReadonlyMap<TitanFernVariantName, TitanNamedMeshAsset<TitanFernVariantName>>;
  readonly rocks: ReadonlyMap<TitanRockVariantName, TitanNamedMeshAsset<TitanRockVariantName>>;
  readonly cliff: TitanNamedMeshAsset<typeof TITAN_CLIFF_VARIANT_NAME>;
}

export interface TitanEnvironmentAssetLoaders {
  readonly gltf: { loadAsync(url: string): Promise<Pick<GLTF, 'scene'>> };
  readonly hdri: { loadAsync(url: string): Promise<THREE.DataTexture> };
  readonly texture: { loadAsync(url: string): Promise<THREE.Texture> };
}

export const titanEnvironmentAssetUrl = (assetPath: string): string => {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${assetPath.replace(/^\//, '')}`;
};

const normalizedGroundTexture = (
  texture: THREE.Texture,
  name: string,
  colorSpace: THREE.ColorSpace,
): THREE.Texture => {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
};

const normalizedTexture = (
  texture: THREE.Texture,
  name: string,
  colorSpace: THREE.ColorSpace,
  wrapping: THREE.Wrapping = THREE.ClampToEdgeWrapping,
): THREE.Texture => {
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = wrapping;
  texture.wrapT = wrapping;
  texture.needsUpdate = true;
  return texture;
};

const namedMesh = <Name extends string>(
  root: THREE.Object3D,
  name: Name,
  assetLabel: string,
  normalization: { readonly dimension: 'height' | 'max'; readonly size: number },
): TitanNamedMeshAsset<Name> => {
  const object = root.getObjectByName(name);
  if (!(object instanceof THREE.Mesh)) {
    throw new Error(`${assetLabel} is missing required mesh ${name}.`);
  }
  if (Array.isArray(object.material)) {
    throw new Error(`${assetLabel} mesh ${name} must use one batched material.`);
  }

  // Poly Haven collections arrange variants side by side in their source
  // scenes, and some nodes also carry authoring scale. Bake that transform
  // into a private geometry before centring it so consumers can instance every
  // variant at an ordinary terrain-space transform.
  const geometry = object.geometry.clone();
  geometry.applyMatrix4(object.matrixWorld);
  geometry.computeBoundingBox();
  const sourceBounds = geometry.boundingBox;
  if (!sourceBounds || sourceBounds.isEmpty()) {
    throw new Error(`${assetLabel} mesh ${name} has no usable bounds.`);
  }

  const size = sourceBounds.getSize(new THREE.Vector3());
  const sourceDimension = normalization.dimension === 'height'
    ? size.y
    : Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(sourceDimension) || sourceDimension <= 0) {
    throw new Error(`${assetLabel} mesh ${name} has a degenerate ${normalization.dimension}.`);
  }

  const center = sourceBounds.getCenter(new THREE.Vector3());
  geometry.translate(-center.x, -sourceBounds.min.y, -center.z);
  const normalizedScale = normalization.size / sourceDimension;
  geometry.scale(normalizedScale, normalizedScale, normalizedScale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.name = `${name}-normalized`;
  return Object.freeze({ name, geometry, material: object.material });
};

const namedMeshMap = <Name extends string>(
  root: THREE.Object3D,
  names: readonly Name[],
  assetLabel: string,
  normalization: { readonly dimension: 'height' | 'max'; readonly size: number },
): ReadonlyMap<Name, TitanNamedMeshAsset<Name>> => new Map(
  names.map((name) => [name, namedMesh(root, name, assetLabel, normalization)] as const),
);

const defaultLoaders = (): TitanEnvironmentAssetLoaders => ({
  gltf: new GLTFLoader(),
  hdri: new RGBELoader(),
  texture: new THREE.TextureLoader(),
});

/**
 * Loads immutable, process-wide Titan source resources once. Renderers may
 * instance the exposed geometries and share the materials/textures, but must
 * never dispose them; their lifetime is the lifetime of the application.
 */
export class TitanEnvironmentAssetLibrary {
  private assets: TitanEnvironmentAssets | null = null;
  private inFlight: Promise<TitanEnvironmentAssets> | null = null;

  public constructor(
    private readonly loaders: TitanEnvironmentAssetLoaders = defaultLoaders(),
  ) {}

  public get(): TitanEnvironmentAssets | null {
    return this.assets;
  }

  public preload(): Promise<TitanEnvironmentAssets> {
    if (this.assets) return Promise.resolve(this.assets);
    if (this.inFlight) return this.inFlight;

    const url = (path: string): string => titanEnvironmentAssetUrl(path);
    const request = Promise.all([
      this.loaders.gltf.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.grass)),
      this.loaders.gltf.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.ferns)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.fernAlpha)),
      this.loaders.gltf.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.rocks)),
      this.loaders.gltf.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.cliff)),
      this.loaders.hdri.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.environment)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.groundAlbedo)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.groundNormal)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.groundRoughness)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.barkAlbedo)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.barkNormal)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.barkRoughness)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.leafAlbedo)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.leafNormal)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.leafOpacity)),
      this.loaders.texture.loadAsync(url(TITAN_ENVIRONMENT_ASSET_PATHS.leafRoughness)),
    ]).then(([
      grassGltf,
      fernGltf,
      fernAlpha,
      rockGltf,
      cliffGltf,
      environmentEquirect,
      groundAlbedo,
      groundNormal,
      groundRoughness,
      barkAlbedo,
      barkNormal,
      barkRoughness,
      leafAlbedo,
      leafNormal,
      leafOpacity,
      leafRoughness,
    ]) => {
      grassGltf.scene.updateMatrixWorld(true);
      fernGltf.scene.updateMatrixWorld(true);
      rockGltf.scene.updateMatrixWorld(true);
      cliffGltf.scene.updateMatrixWorld(true);

      environmentEquirect.name = 'titan-schachen-forest-environment';
      environmentEquirect.mapping = THREE.EquirectangularReflectionMapping;
      environmentEquirect.needsUpdate = true;

      const fernAlphaMask = normalizedTexture(
        fernAlpha,
        'titan-fern-alpha-mask',
        THREE.NoColorSpace,
      );
      fernGltf.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of sourceMaterials) {
          if (!(material instanceof THREE.MeshStandardMaterial)) continue;
          material.alphaMap = fernAlphaMask;
          material.alphaTest = 0.44;
          material.transparent = false;
          material.depthWrite = true;
          material.side = THREE.DoubleSide;
          material.needsUpdate = true;
        }
      });

      const assets: TitanEnvironmentAssets = Object.freeze({
        environmentEquirect,
        ground: Object.freeze({
          albedo: normalizedGroundTexture(
            groundAlbedo,
            'titan-forest-ground-albedo',
            THREE.SRGBColorSpace,
          ),
          normal: normalizedGroundTexture(
            groundNormal,
            'titan-forest-ground-normal-gl',
            THREE.NoColorSpace,
          ),
          roughness: normalizedGroundTexture(
            groundRoughness,
            'titan-forest-ground-roughness',
            THREE.NoColorSpace,
          ),
        }),
        textures: Object.freeze({
          barkAlbedo: normalizedTexture(
            barkAlbedo,
            'titan-bark-albedo',
            THREE.SRGBColorSpace,
            THREE.RepeatWrapping,
          ),
          barkNormal: normalizedTexture(
            barkNormal,
            'titan-bark-normal-gl',
            THREE.NoColorSpace,
            THREE.RepeatWrapping,
          ),
          barkRoughness: normalizedTexture(
            barkRoughness,
            'titan-bark-roughness',
            THREE.NoColorSpace,
            THREE.RepeatWrapping,
          ),
          leafAlbedo: normalizedTexture(
            leafAlbedo,
            'titan-leaf-albedo',
            THREE.SRGBColorSpace,
          ),
          leafNormal: normalizedTexture(
            leafNormal,
            'titan-leaf-normal-gl',
            THREE.NoColorSpace,
          ),
          leafOpacity: normalizedTexture(
            leafOpacity,
            'titan-leaf-opacity',
            THREE.NoColorSpace,
          ),
          leafRoughness: normalizedTexture(
            leafRoughness,
            'titan-leaf-roughness',
            THREE.NoColorSpace,
          ),
        }),
        grass: namedMeshMap(
          grassGltf.scene,
          TITAN_GRASS_VARIANT_NAMES,
          'Grass Bermuda 01',
          { dimension: 'height', size: 1 },
        ),
        ferns: namedMeshMap(
          fernGltf.scene,
          TITAN_FERN_VARIANT_NAMES,
          'Fern 02',
          { dimension: 'height', size: 1 },
        ),
        rocks: namedMeshMap(
          rockGltf.scene,
          TITAN_ROCK_VARIANT_NAMES,
          'Rock Moss Set 02',
          { dimension: 'max', size: 2 },
        ),
        cliff: namedMesh(
          cliffGltf.scene,
          TITAN_CLIFF_VARIANT_NAME,
          'Rock Face 01',
          { dimension: 'height', size: 1 },
        ),
      });
      this.assets = assets;
      this.inFlight = null;
      return assets;
    }).catch((error: unknown) => {
      this.inFlight = null;
      throw error;
    });

    this.inFlight = request;
    return request;
  }
}

const sharedTitanEnvironmentAssets = new TitanEnvironmentAssetLibrary();

export const preloadTitanEnvironmentAssets = (): Promise<TitanEnvironmentAssets> =>
  sharedTitanEnvironmentAssets.preload();

/** Returns the shared assets synchronously, or `null` until preload succeeds. */
export const getTitanEnvironmentAssets = (): TitanEnvironmentAssets | null =>
  sharedTitanEnvironmentAssets.get();
