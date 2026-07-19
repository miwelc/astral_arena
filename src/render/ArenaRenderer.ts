import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { isJumpPad, JUMP_PAD_ZONES } from '../game/map';
import { isTeamGameMode } from '../game/modeRules';
import type {
  FlagState,
  GameEvent,
  MapDefinition,
  MatchState,
  PickupState,
  PlayerState,
  ProjectileState,
  Team,
  Vec3,
  WeaponId,
} from '../game/types';
import { WEAPONS } from '../game/weapons';
import {
  advanceLocomotionPhase,
  damp,
  evaluateDirectionalGait,
  evaluateGrenade,
  evaluateLocomotionCycle,
  evaluateMelee,
  evaluateReload,
  evaluateSwap,
  evaluateWeaponBob,
  normalizedTimer,
  saturate,
  smootherstep01,
  trianglePulse,
  type ActionPoseWeights,
} from './animationMath';
import { createColdAlienPlant, createLayeredRidge } from './landscapeGeometry';
import {
  createFacilityEnvironment,
  createUnderstoryField,
  createWetRockField,
  type FacilityEnvironmentBundle,
  type ScatterExclusion,
} from './facilityEnvironment';
import { createBaseArchitecture, type BaseArchitectureBundle } from './baseArchitecture';
import { DepthFocusPass } from './DepthFocusPass';
import {
  createColdEnvironmentTexture,
  createFacilityPanelTexture,
  createForestGroundTextures,
  createRadialTexture,
  createTechnicalSurfaceTextures,
} from './visualTextures';
import {
  computeGroundTextureRepeat,
  computeSurfaceUvTransform,
  evaluateExplosionVisual,
  evaluateSurfaceTint,
  type SurfaceUvTransform,
} from './visualPresentation';
import {
  createWeaponModel,
  getWeaponAnchor,
  WEAPON_VIEW_POSES,
  type WeaponAnimationRole,
} from './weaponModels';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const ASTRONAUT_WAIST_HEIGHT = 1.05;
const GROUND_TEXTURE_TILE_SIZE = 16;
const FACILITY_PANEL_REPEAT = { x: 4, y: 1 } as const;

const TEAM_COLORS: Record<Team, { armor: number; accent: number; glow: number }> = {
  // Team modes use a readable full-suit tint, reinforced by bright IFF trim.
  // The dark undersuit keeps the astronaut silhouette grounded and avoids the
  // flat, toy-like look of a single saturated material.
  aurora: { armor: 0x739eb4, accent: 0x26cfe4, glow: 0x54edff },
  nova: { armor: 0xb95e69, accent: 0xff5068, glow: 0xff7186 },
  neutral: { armor: 0xe2e7e2, accent: 0xa9e83e, glow: 0xc7ff54 },
};

const WEAPON_AIM_FOV: Readonly<Record<WeaponId, number>> = {
  'pulse-rifle': 57,
  sidearm: 63,
  'battle-rifle': 53,
  sniper: 17.15,
  shotgun: 64,
  'rocket-launcher': 60,
};

// Optical FOVs corresponding to the classic 5x / 10x sniper steps from a
// 74-degree hip-fire view. Keeping the values explicit makes the zoom honest:
// the second level really resolves targets at twice the angular scale.
const SNIPER_ZOOM_FOV = [17.15, 8.62] as const;

const ARCHITECTURE_AUTHORED_SHELLS = new Set([
  'west-base-front-n',
  'west-base-front-s',
  'west-base-wing-n',
  'west-base-wing-s',
  'east-base-front-n',
  'east-base-front-s',
  'east-base-wing-n',
  'east-base-wing-s',
  'north-relay-front-west',
  'north-relay-front-east',
  'north-relay-wall-west',
  'north-relay-wall-east',
  'south-greenhouse-front-west',
  'south-greenhouse-front-east',
  'south-greenhouse-west',
  'south-greenhouse-east',
  'south-greenhouse-roof',
]);

interface PlayerRig {
  root: THREE.Group;
  motionRoot: THREE.Group;
  torso: THREE.Group;
  upperBodyAim: THREE.Group;
  actionPivot: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftForearm: THREE.Group;
  rightForearm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  leftKnee: THREE.Group;
  rightKnee: THREE.Group;
  leftFoot: THREE.Group;
  rightFoot: THREE.Group;
  weaponMount: THREE.Group;
  weaponModel: THREE.Group | null;
  weaponParts: AnimatedWeaponParts;
  contactShadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shield: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  juggernautRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  friendlyMarker: THREE.Sprite;
  armorMaterial: THREE.MeshPhysicalMaterial;
  accentMaterial: THREE.MeshStandardMaterial;
  visorMaterial: THREE.MeshPhysicalMaterial;
  team: Team;
  weaponId: WeaponId | null;
  previousPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  previousYaw: number;
  targetYaw: number;
  lastTick: number;
  locomotionPhase: number;
  moveBlend: number;
  groundBlend: number;
  forwardBlend: number;
  strafeBlend: number;
  previousGrounded: boolean;
  previousVerticalVelocity: number;
  previousMeleeCooldown: number;
  previousGrenadeCooldown: number;
  previousAlive: boolean;
  landingTimer: number;
  landingStrength: number;
  jumpTimer: number;
  swapTimer: number;
  meleeTimer: number;
  grenadeTimer: number;
  fireTimer: number;
  hitTimer: number;
  hitDirection: number;
  deathTimer: number;
  spawnTimer: number;
  recoil: number;
  baseLeftArmQuaternion: THREE.Quaternion;
  baseRightArmQuaternion: THREE.Quaternion;
  baseLeftForearmQuaternion: THREE.Quaternion;
  baseRightForearmQuaternion: THREE.Quaternion;
}

interface AnimatedWeaponPart {
  object: THREE.Object3D;
  basePosition: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  baseScale: THREE.Vector3;
}

type AnimatedWeaponParts = Partial<Record<WeaponAnimationRole, AnimatedWeaponPart>>;

interface PickupVisual {
  root: THREE.Group;
  display: THREE.Group;
  baseY: number;
  phase: number;
}

interface ProjectileVisual {
  root: THREE.Group;
  kind: ProjectileState['kind'];
}

interface TransientEffect {
  object: THREE.Object3D;
  age: number;
  duration: number;
  update: (progress: number) => void;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const lerpAngle = (from: number, to: number, amount: number): number => {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
};

const vectorFrom = (value: Vec3, target = new THREE.Vector3()): THREE.Vector3 =>
  target.set(value.x, value.y, value.z);

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
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

const applyGeometryUvTransform = (
  geometry: THREE.BufferGeometry,
  transform: SurfaceUvTransform,
): void => {
  const uv = geometry.getAttribute('uv');
  if (!(uv instanceof THREE.BufferAttribute)) return;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setXY(
      index,
      uv.getX(index) * transform.scaleU + transform.offsetU,
      uv.getY(index) * transform.scaleV + transform.offsetV,
    );
  }
  uv.needsUpdate = true;
};

const applyGeometrySurfaceTint = (
  geometry: THREE.BufferGeometry,
  seed: number,
  offsetX = 0,
  offsetZ = 0,
  planeAxes = false,
): void => {
  const positions = geometry.getAttribute('position');
  if (!(positions instanceof THREE.BufferAttribute)) return;
  const colors = new Float32Array(positions.count * 3);
  for (let index = 0; index < positions.count; index += 1) {
    const x = offsetX + positions.getX(index);
    const z = offsetZ + (planeAxes ? -positions.getY(index) : positions.getZ(index));
    const tint = evaluateSurfaceTint(x, z, seed);
    colors[index * 3] = tint.r;
    colors[index * 3 + 1] = tint.g;
    colors[index * 3 + 2] = tint.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
};

const createEarthworkGeometry = (
  size: THREE.Vector3,
  seed: number,
  rocky: boolean,
): THREE.BufferGeometry => {
  const bevel = Math.min(
    rocky ? 0.46 : 0.32,
    Math.max(0.08, Math.min(size.x, size.y, size.z) * (rocky ? 0.3 : 0.18)),
  );
  const geometry = new RoundedBoxGeometry(size.x, size.y, size.z, rocky ? 6 : 5, bevel);
  const positions = geometry.getAttribute('position');
  const seedPhase = (seed % 997) * 0.017;
  const halfHeight = Math.max(0.001, size.y * 0.5);
  const maximumSurfaceNoise = Math.min(rocky ? 0.16 : 0.09, size.y * (rocky ? 0.13 : 0.08));
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const upperWeight = THREE.MathUtils.smoothstep(y, -halfHeight * 0.2, halfHeight * 0.72);
    const noise = (
      Math.sin(x * 0.71 + z * 0.43 + seedPhase)
      + Math.cos(z * 0.83 - x * 0.31 + seedPhase * 1.7)
    ) * 0.5;
    const sideNoise = rocky ? upperWeight * Math.min(0.08, Math.min(size.x, size.z) * 0.012) : 0;
    positions.setXYZ(
      index,
      x + Math.sin(z * 0.92 + seedPhase) * sideNoise,
      y + noise * maximumSurfaceNoise * upperWeight,
      z + Math.cos(x * 0.79 - seedPhase) * sideNoise,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
};

const sampleGroundRelief = (map: MapDefinition, worldX: number, worldZ: number): number => {
  const depth = map.bounds.maxZ - map.bounds.minZ;
  const centerX = (map.bounds.minX + map.bounds.maxX) * 0.5;
  const centerZ = (map.bounds.minZ + map.bounds.maxZ) * 0.5;
  const localX = worldX - centerX;
  const localY = centerZ - worldZ;
  const macro = Math.sin(localX * 0.19 + Math.cos(localY * 0.11) * 1.7) * 0.5 + 0.5;
  const fine = Math.sin(localX * 0.73 - localY * 0.51) * Math.cos(localY * 0.37) * 0.5 + 0.5;
  const horizontalPath = 1 - THREE.MathUtils.smoothstep(Math.abs(worldZ - centerZ), 3.2, 5.2);
  const verticalPath = 1 - THREE.MathUtils.smoothstep(Math.abs(worldX - centerX), 3, 5);
  const northSouthPath = 1 - THREE.MathUtils.smoothstep(
    Math.abs(Math.abs(worldZ - centerZ) - depth * 0.32),
    2,
    4.2,
  );
  const basePath = Math.max(...Object.values(map.flagBases).map((base) => {
    const alongX = 1 - THREE.MathUtils.smoothstep(Math.abs(worldX - base.x), 6.5, 8.5);
    const alongZ = 1 - THREE.MathUtils.smoothstep(Math.abs(worldZ - base.z), 10, 12);
    return alongX * alongZ;
  }));
  const artificialWeight = THREE.MathUtils.clamp(
    Math.max(horizontalPath, verticalPath, northSouthPath, basePath),
    0,
    1,
  );
  const earthWeight = 1 - artificialWeight;
  const relief = (macro - 0.5) * 0.17 + (fine - 0.5) * 0.055;
  return relief * THREE.MathUtils.lerp(0.12, 1, earthWeight);
};

const disposeObject = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments || child instanceof THREE.Points || child instanceof THREE.Sprite)) return;
    if (child.userData.sharedVisualTemplate) return;
    if (!child.userData.sharedEffectGeometry) child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) material.dispose();
  });
};

/**
 * Three.js presentation layer for the authoritative arena state. It intentionally
 * owns no gameplay logic: local matches and WebRTC matches render identically.
 */
export class ArenaRenderer {
  private readonly container: HTMLElement;
  private readonly map: MapDefinition;
  private readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly depthFocusPass: DepthFocusPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gradePass: ShaderPass;
  private readonly camera = new THREE.PerspectiveCamera(74, 1, 0.035, 240);
  private readonly viewScene = new THREE.Scene();
  private readonly viewCamera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private readonly clock = new THREE.Clock();
  private readonly playerRigs = new Map<string, PlayerRig>();
  private readonly pickupVisuals = new Map<string, PickupVisual>();
  private readonly projectileVisuals = new Map<string, ProjectileVisual>();
  private readonly flagVisuals = new Map<FlagState['team'], THREE.Group>();
  private readonly effects: TransientEffect[] = [];
  private readonly shotFlashGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly muzzleConeGeometry = new THREE.ConeGeometry(1, 1, 7, 1, true);
  private readonly shotSmokeGeometry = new THREE.SphereGeometry(1, 8, 6);
  private readonly explosionShellGeometry = new THREE.IcosahedronGeometry(1, 2);
  private readonly explosionShockGeometry = new THREE.TorusGeometry(1, 0.032, 7, 40);
  private readonly explosionGroundFlashGeometry = new THREE.CircleGeometry(1, 32);
  private readonly weaponTemplates = new Map<WeaponId, THREE.Group>();
  private readonly worldDecorations: THREE.Object3D[] = [];
  private readonly ownedTextures = new Set<THREE.Texture>();
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private facilityEnvironment: FacilityEnvironmentBundle | null = null;
  private baseArchitecture: BaseArchitectureBundle | null = null;
  private groundTexture: THREE.CanvasTexture | null = null;
  private groundNormalTexture: THREE.CanvasTexture | null = null;
  private groundRoughnessTexture: THREE.CanvasTexture | null = null;
  private facilityPanelTexture: THREE.CanvasTexture | null = null;
  private technicalNormalTexture: THREE.CanvasTexture | null = null;
  private technicalRoughnessTexture: THREE.CanvasTexture | null = null;
  private contactShadowTexture: THREE.CanvasTexture | null = null;
  private readonly viewModel = new THREE.Group();
  private readonly viewActionPivot = new THREE.Group();
  private readonly viewWeaponMount = new THREE.Group();
  private readonly viewRightHandAssembly = new THREE.Group();
  private readonly viewLeftHandAssembly = new THREE.Group();
  private readonly viewRightHandBasePosition = new THREE.Vector3();
  private readonly viewLeftHandBasePosition = new THREE.Vector3();
  private viewWeaponModel: THREE.Group | null = null;
  private viewWeaponParts: AnimatedWeaponParts = {};
  private readonly viewArmMaterial = new THREE.MeshStandardMaterial({
    color: TEAM_COLORS.neutral.armor,
    roughness: 0.52,
    metalness: 0.28,
  });
  private readonly towerRingMaterial = new THREE.MeshBasicMaterial({
    color: TEAM_COLORS.neutral.glow,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  private readonly towerTurret = new THREE.Group();
  private readonly towerTurretPitch = new THREE.Group();
  private readonly towerTurretMuzzles: THREE.Object3D[] = [];
  private readonly towerTurretCameraMount = new THREE.Object3D();
  private skyDome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> | null = null;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly damageUniform = { value: 0 };
  private readonly fireUniform = { value: 0 };
  private readonly damageOverlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly resizeObserver: ResizeObserver | null;
  private localPlayerId: string | null = null;
  private viewWeaponId: WeaponId | null = null;
  private lastEventId = -1;
  private eventsInitialized = false;
  private damagePulse = 0;
  private weaponKick = 0;
  private viewSwayYaw = 0;
  private viewSwayPitch = 0;
  private viewAimBlend = 0;
  private previousViewYaw: number | null = null;
  private previousViewPitch: number | null = null;
  private localViewAim = false;
  private sniperZoomLevel: 0 | 1 = 0;
  private visualSimulationTime = 0;
  private previousStateElapsed = 0;
  private visualClockInitialized = false;
  private elapsedRenderTime = 0;
  private disposed = false;

  public constructor(container: HTMLElement, map: MapDefinition) {
    this.container = container;
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.container.append(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x9dbdb8);
    this.scene.fog = new THREE.FogExp2(0x9dbdb8, 0.0086);
    this.scene.environmentIntensity = 0.92;
    this.camera.rotation.order = 'YXZ';
    const mapWidth = this.map.bounds.maxX - this.map.bounds.minX;
    const mapDepth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const mapCenterX = (this.map.bounds.minX + this.map.bounds.maxX) * 0.5;
    const mapCenterZ = (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5;
    this.camera.position.set(
      mapCenterX + mapWidth * 0.61,
      Math.max(24, Math.max(mapWidth, mapDepth) * 0.27),
      mapCenterZ + mapDepth * 0.66,
    );
    this.camera.lookAt(mapCenterX, 4, mapCenterZ);
    this.scene.add(this.camera);

    this.createEnvironmentMap();
    this.viewScene.environment = this.scene.environment;
    this.viewScene.environmentIntensity = 1.08;
    this.viewScene.add(this.viewCamera);
    const viewHemisphere = new THREE.HemisphereLight(0xd8ebe6, 0x071011, 0.56);
    const viewKey = new THREE.DirectionalLight(0xffedcd, 3.25);
    viewKey.position.set(-2.2, 3.4, 2.6);
    const viewRim = new THREE.PointLight(0x56eddb, 5.4, 4.5, 2);
    viewRim.position.set(1.4, 0.8, -0.4);
    this.viewScene.add(viewHemisphere, viewKey, viewRim);

    const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    composerTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    composerTarget.depthTexture.format = THREE.DepthFormat;
    composerTarget.samples = 0;
    this.composer = new EffectComposer(this.renderer, composerTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.depthFocusPass = new DepthFocusPass(this.camera);
    this.composer.addPass(this.depthFocusPass);
    const viewModelPass = new RenderPass(this.viewScene, this.viewCamera);
    viewModelPass.clear = false;
    viewModelPass.clearDepth = true;
    this.composer.addPass(viewModelPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.52, 0.98);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uDamage: this.damageUniform,
        uFire: this.fireUniform,
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uDamage;
        uniform float uFire;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
          vec2 centerVector = vUv - 0.5;
          float radial = smoothstep(0.08, 0.72, length(centerVector));
          float aberrationStrength = radial * (uDamage * 0.006 + uFire * 0.0018);
          vec2 spectralOffset = normalize(centerVector + vec2(0.00001)) * aberrationStrength;
          vec4 source = texture2D(tDiffuse, vUv);
          vec3 color = source.rgb;
          if (aberrationStrength > 0.00001) {
            color = vec3(
              texture2D(tDiffuse, vUv + spectralOffset).r,
              source.g,
              texture2D(tDiffuse, vUv - spectralOffset).b
            );
          }
          float impactBlur = clamp(uDamage * 0.34 + uFire * 0.055, 0.0, 0.38);
          if (impactBlur > 0.001) {
            vec2 blurOffset = centerVector * (0.0025 + uDamage * 0.006);
            vec3 radialBlur = (
              texture2D(tDiffuse, vUv - blurOffset).rgb
              + color * 2.0
              + texture2D(tDiffuse, vUv + blurOffset).rgb
            ) * 0.25;
            color = mix(color, radialBlur, impactBlur);
          }
          float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(luminance), color, 1.075);
          color = (color - 0.5) * 1.045 + 0.5;
          float shadows = 1.0 - smoothstep(0.04, 0.42, luminance);
          float highlights = smoothstep(0.58, 1.15, luminance);
          color += shadows * vec3(-0.012, 0.006, 0.009);
          color += highlights * vec3(0.018, 0.008, -0.006);
          float edge = smoothstep(0.34, 1.02, length((vUv - 0.5) * vec2(1.15, 1.0)) * 1.42);
          color *= 1.0 - edge * (0.125 + uDamage * 0.065);
          float grain = hash(vUv * vec2(1493.0, 877.0) + floor(uTime * 24.0)) - 0.5;
          color += grain * 0.0045;
          color = mix(color, color * vec3(0.985, 1.008, 1.0), 0.18);
          gl_FragColor = vec4(color, source.a);
        }
      `,
    });
    this.composer.addPass(this.gradePass);
    this.composer.addPass(new SMAAPass());
    this.composer.addPass(new OutputPass());

    this.skyMaterial = this.createSky();
    this.createLighting();
    this.createLandscape();
    this.createMapGeometry();
    this.baseArchitecture = createBaseArchitecture(this.map, { quality: 'high' });
    this.scene.add(this.baseArchitecture.group);
    this.createEnvironmentDressing();
    this.createAtmosphereDetails();
    this.createObjectiveMarkers();
    this.createViewModel();
    this.damageOverlay = this.createDamageOverlay();

    this.resize();
    this.resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(this.container);
  }

  public get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  public setLocalPlayer(id: string | null): void {
    this.localPlayerId = id;
  }

  public getPresentedPlayerPosition(id: string): Vec3 | null {
    const rig = this.playerRigs.get(id);
    if (!rig) return null;
    return { x: rig.root.position.x, y: rig.root.position.y, z: rig.root.position.z };
  }

  /** Supplies latency-free local presentation input, including on P2P guests. */
  public setLocalViewAim(aiming: boolean, sniperZoomLevel: 0 | 1): void {
    this.localViewAim = aiming;
    this.sniperZoomLevel = sniperZoomLevel;
  }

  public pulseDamage(): void {
    this.damagePulse = 1;
  }

  public resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight || 1);
    // Bound the half-float post-processing targets on 4K/5K displays. SMAA
    // recovers the small loss in edge quality without exhausting iGPU memory.
    const renderTargetPixelBudget = 4_200_000;
    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      1.25,
      Math.sqrt(renderTargetPixelBudget / (width * height)),
    );
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = width / height;
    this.viewCamera.updateProjectionMatrix();

    const overlayHeight = 0.125;
    this.damageOverlay?.scale.set(overlayHeight * this.camera.aspect, overlayHeight, 1);
  }

  public render(state: MatchState, alpha: number, firstPerson: boolean): void {
    if (this.disposed) return;

    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsedRenderTime += delta;
    const interpolation = clamp01(alpha);
    if (
      !this.visualClockInitialized
      || state.elapsed < this.previousStateElapsed
      || state.elapsed - this.previousStateElapsed > 1
    ) {
      this.visualSimulationTime = state.elapsed;
      this.visualClockInitialized = true;
    } else {
      this.visualSimulationTime = Math.max(this.visualSimulationTime, state.elapsed);
      this.visualSimulationTime = Math.min(
        this.visualSimulationTime + delta,
        state.elapsed + 0.1,
      );
    }
    this.previousStateElapsed = state.elapsed;
    const worldTime = this.visualSimulationTime + interpolation / 60;

    this.syncPlayers(state, interpolation, worldTime, firstPerson, delta);
    this.syncPickups(state.pickups, worldTime);
    this.syncFlags(state.config.mode === 'capture-the-flag' ? state.flags : [], state, worldTime);
    this.syncProjectiles(state.projectiles, worldTime);
    this.syncTower(state, worldTime);
    this.syncObjectiveVisibility(state);
    this.consumeEvents(state);
    this.updateEffects(delta);
    this.updateDecorations(worldTime);
    this.updateCamera(state, firstPerson, worldTime, delta);
    this.skyDome?.position.copy(this.camera.position);

    this.damagePulse = Math.max(0, this.damagePulse - delta * 2.65);
    this.weaponKick = Math.max(0, this.weaponKick - delta * 7.5);
    this.damageUniform.value = this.damagePulse * this.damagePulse * 0.78;
    this.fireUniform.value = this.weaponKick * this.weaponKick;
    this.gradePass.uniforms.uDamage!.value = this.damageUniform.value;
    this.gradePass.uniforms.uFire!.value = this.fireUniform.value;
    this.depthFocusPass.focusDistance = firstPerson
      ? THREE.MathUtils.lerp(21, 34, this.viewAimBlend)
      : 42;
    this.depthFocusPass.aperture = firstPerson
      ? THREE.MathUtils.lerp(0.92, 0.58, this.viewAimBlend)
      : 1.08;
    this.depthFocusPass.maxBlurPixels = firstPerson ? 1.65 : 2.15;
    this.renderer.toneMappingExposure = 1.08 - this.damagePulse * 0.11;
    this.skyMaterial.uniforms.uTime!.value = worldTime;
    this.gradePass.uniforms.uTime!.value = worldTime;

    this.composer.render(delta);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();

    // The environment bundle owns its instanced geometry, sign textures and
    // shared material kit. Dispose it before traversing the remaining scene so
    // those resources are released exactly once.
    this.facilityEnvironment?.dispose();
    this.facilityEnvironment = null;
    this.baseArchitecture?.dispose();
    this.baseArchitecture = null;

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const collect = (object: THREE.Object3D): void => {
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments || child instanceof THREE.Points || child instanceof THREE.Sprite)) return;
        geometries.add(child.geometry);
        const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of childMaterials) materials.add(material);
      });
    };

    for (const effect of this.effects) {
      collect(effect.object);
      effect.object.removeFromParent();
    }
    this.effects.length = 0;
    collect(this.scene);
    collect(this.viewScene);
    for (const template of this.weaponTemplates.values()) collect(template);
    geometries.add(this.shotFlashGeometry);
    geometries.add(this.muzzleConeGeometry);
    geometries.add(this.shotSmokeGeometry);
    geometries.add(this.explosionShellGeometry);
    geometries.add(this.explosionShockGeometry);
    geometries.add(this.explosionGroundFlashGeometry);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of this.ownedTextures) texture.dispose();
    this.environmentTarget?.dispose();
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }

  private createEnvironmentMap(): void {
    const environment = createColdEnvironmentTexture(768, 384);
    const generator = new THREE.PMREMGenerator(this.renderer);
    generator.compileEquirectangularShader();
    this.environmentTarget = generator.fromEquirectangular(environment);
    this.scene.environment = this.environmentTarget.texture;
    generator.dispose();
    environment.dispose();
  }

  private createSky(): THREE.ShaderMaterial {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vDirection;
        void main() {
          vDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDirection;
        uniform float uTime;

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }

        float fbm(vec2 p) {
          float value = 0.0;
          float amplitude = 0.5;
          for (int i = 0; i < 4; i++) {
            value += noise(p) * amplitude;
            p = p * 2.03 + 19.1;
            amplitude *= 0.5;
          }
          return value;
        }

        void main() {
          float h = clamp(vDirection.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 horizon = vec3(0.63, 0.76, 0.72);
          vec3 middle = vec3(0.19, 0.37, 0.46);
          vec3 zenith = vec3(0.035, 0.105, 0.18);
          vec3 color = mix(horizon, middle, smoothstep(0.47, 0.74, h));
          color = mix(color, zenith, smoothstep(0.70, 1.0, h));

          vec3 sunDir = normalize(vec3(-0.52, 0.64, -0.56));
          float alignment = max(dot(vDirection, sunDir), 0.0);
          float sun = pow(alignment, 520.0);
          float innerHalo = pow(alignment, 48.0);
          float outerHalo = pow(alignment, 7.0);
          color += vec3(1.0, 0.92, 0.72) * sun * 4.6;
          color += vec3(0.78, 0.91, 0.78) * innerHalo * 0.43;
          color += vec3(0.32, 0.51, 0.48) * outerHalo * 0.25;

          vec2 cloudUv = vDirection.xz * 4.2 + vDirection.y * vec2(1.7, -1.3);
          float cloudNoise = fbm(cloudUv + vec2(uTime * 0.004, 0.0));
          float cloudBand = smoothstep(0.54, 0.72, cloudNoise);
          cloudBand *= smoothstep(0.39, 0.58, h) * (1.0 - smoothstep(0.75, 0.89, h));
          color = mix(color, vec3(0.66, 0.78, 0.74), cloudBand * 0.25);

          vec3 planetDir = normalize(vec3(0.58, 0.32, 0.72));
          float planetDot = dot(vDirection, planetDir);
          float planet = smoothstep(0.9865, 0.9892, planetDot);
          vec3 planetSurface = normalize(vDirection - planetDir * 0.9865 + vec3(0.0, 0.0001, 0.0));
          float planetShade = smoothstep(-0.08, 0.5, dot(planetSurface, sunDir));
          vec3 planetColor = mix(vec3(0.43, 0.58, 0.72), vec3(0.74, 0.53, 0.72), planetShade);
          color = mix(color, planetColor * (0.48 + planetShade * 0.52), planet * 0.54);
          float ring = 1.0 - smoothstep(0.0, 0.0048, abs(dot(vDirection - planetDir, normalize(vec3(0.18, 0.94, -0.28)))));
          ring *= smoothstep(0.91, 0.986, planetDot) * (1.0 - planet * 0.74);
          color += ring * vec3(0.61, 0.72, 0.82) * 0.25;
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    const sky = new THREE.Mesh(new THREE.SphereGeometry(185, 32, 18), material);
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    this.skyDome = sky;
    this.scene.add(sky);
    return material;
  }

  private createLighting(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    // Cover the full arena diagonal so the sun's rotated shadow camera cannot
    // clip casters in the outer corners of the expanded map.
    const shadowExtent = Math.hypot(width * 0.5, depth * 0.5) + 5;
    const hemisphere = new THREE.HemisphereLight(0xb9ded5, 0x07110e, 0.58);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xffe5b2, 4.35);
    sun.position.set(-46, 48, -52);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -shadowExtent;
    sun.shadow.camera.right = shadowExtent;
    sun.shadow.camera.top = shadowExtent;
    sun.shadow.camera.bottom = -shadowExtent;
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 180;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 0.032;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x79aebe, 0.34);
    fill.position.set(34, 22, 38);
    this.scene.add(fill);

    const towerKey = new THREE.PointLight(0x74f4df, 24, 18, 2);
    towerKey.position.set(0, 7.8, 0);
    this.scene.add(towerKey);

    const auroraBase = new THREE.PointLight(TEAM_COLORS.aurora.glow, 15, 14, 2);
    auroraBase.position.set(
      this.map.flagBases.aurora.x,
      this.map.flagBases.aurora.y + 2.25,
      this.map.flagBases.aurora.z,
    );
    this.scene.add(auroraBase);

    const novaBase = new THREE.PointLight(TEAM_COLORS.nova.glow, 15, 14, 2);
    novaBase.position.set(
      this.map.flagBases.nova.x,
      this.map.flagBases.nova.y + 2.25,
      this.map.flagBases.nova.z,
    );
    this.scene.add(novaBase);
  }

  private createLandscape(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const halfWidth = width * 0.5;
    const halfDepth = depth * 0.5;
    const arenaRadius = Math.hypot(halfWidth, halfDepth);
    const centerX = (this.map.bounds.minX + this.map.bounds.maxX) * 0.5;
    const centerZ = (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5;
    const forestGround = createForestGroundTextures(512);
    this.groundTexture = forestGround.albedo;
    this.groundNormalTexture = forestGround.normal;
    this.groundRoughnessTexture = forestGround.roughness;
    this.facilityPanelTexture = createFacilityPanelTexture(512);
    const technicalSurface = createTechnicalSurfaceTextures(256);
    this.technicalNormalTexture = technicalSurface.normal;
    this.technicalRoughnessTexture = technicalSurface.roughness;
    const groundRepeat = computeGroundTextureRepeat(width, depth, GROUND_TEXTURE_TILE_SIZE);
    this.groundTexture.repeat.set(groundRepeat.x, groundRepeat.y);
    this.groundNormalTexture.repeat.copy(this.groundTexture.repeat);
    this.groundRoughnessTexture.repeat.copy(this.groundTexture.repeat);
    this.facilityPanelTexture.repeat.set(FACILITY_PANEL_REPEAT.x, FACILITY_PANEL_REPEAT.y);
    this.technicalNormalTexture.repeat.set(3, 3);
    this.technicalRoughnessTexture.repeat.copy(this.technicalNormalTexture.repeat);
    this.groundTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.groundNormalTexture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.ownedTextures.add(this.groundTexture);
    this.ownedTextures.add(this.groundNormalTexture);
    this.ownedTextures.add(this.groundRoughnessTexture);
    this.ownedTextures.add(this.facilityPanelTexture);
    this.ownedTextures.add(this.technicalNormalTexture);
    this.ownedTextures.add(this.technicalRoughnessTexture);
    this.viewArmMaterial.normalMap = this.technicalNormalTexture;
    this.viewArmMaterial.normalScale.set(0.16, 0.16);

    const outerGroundGeometry = new THREE.CircleGeometry(Math.max(146, arenaRadius + 78), 96);
    applyGeometrySurfaceTint(outerGroundGeometry, 0x51f1e, centerX, centerZ, true);
    const outerGround = new THREE.Mesh(
      outerGroundGeometry,
      new THREE.MeshPhysicalMaterial({
        color: 0xaab69a,
        map: this.groundTexture,
        normalMap: this.groundNormalTexture,
        normalScale: new THREE.Vector2(0.72, 0.72),
        roughnessMap: this.groundRoughnessTexture,
        roughness: 0.92,
        metalness: 0,
        clearcoat: 0.08,
        clearcoatRoughness: 0.66,
        envMapIntensity: 0.32,
        vertexColors: true,
      }),
    );
    outerGround.rotation.x = -Math.PI / 2;
    outerGround.position.x = centerX;
    outerGround.position.y = this.map.bounds.floorY - 0.22;
    outerGround.position.z = centerZ;
    outerGround.receiveShadow = true;
    this.scene.add(outerGround);

    const random = seededRandom(0x51f1e);
    const ridgeMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x263d34, roughness: 0.96, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x385347, roughness: 0.98, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x597064, roughness: 1, flatShading: true }),
    ];

    const ridgeBands = [
      { count: 11, distance: arenaRadius + 14, spread: 18, radius: 9, height: 14 },
      { count: 10, distance: arenaRadius + 38, spread: 22, radius: 13, height: 22 },
      { count: 9, distance: arenaRadius + 70, spread: 25, radius: 18, height: 31 },
    ];
    let ridgeSeed = 0x7100;
    for (let band = ridgeBands.length - 1; band >= 0; band -= 1) {
      const config = ridgeBands[band]!;
      for (let index = 0; index < config.count; index += 1) {
        const angle = (index / config.count) * Math.PI * 2 + (random() - 0.5) * 0.22;
        const distance = config.distance + random() * config.spread;
        const ridge = createLayeredRidge({
          seed: ridgeSeed,
          radius: config.radius * (0.76 + random() * 0.52),
          height: config.height * (0.72 + random() * 0.62),
          material: [
            ridgeMaterials[band]!,
            ridgeMaterials[Math.min(ridgeMaterials.length - 1, band + 1)]!,
          ],
          layers: 3,
          radialSegments: 8,
          flattening: 0.52 + random() * 0.28,
          castShadow: false,
          receiveShadow: true,
        });
        ridgeSeed += 1;
        ridge.position.set(
          centerX + Math.cos(angle) * distance,
          this.map.bounds.floorY - 0.34,
          centerZ + Math.sin(angle) * distance,
        );
        ridge.rotation.y = angle + Math.PI * 0.5 + (random() - 0.5) * 0.45;
        this.scene.add(ridge);
      }
    }

    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockMaterials = [
      new THREE.MeshPhysicalMaterial({ color: 0x34493f, roughness: 0.72, clearcoat: 0.18, clearcoatRoughness: 0.7, flatShading: true }),
      new THREE.MeshPhysicalMaterial({ color: 0x4e5d51, roughness: 0.78, clearcoat: 0.14, clearcoatRoughness: 0.72, flatShading: true }),
      new THREE.MeshPhysicalMaterial({ color: 0x263d35, roughness: 0.74, clearcoat: 0.2, clearcoatRoughness: 0.68, flatShading: true }),
    ];
    const rockCounts = [22, 22, 22];
    for (let materialIndex = 0; materialIndex < rockMaterials.length; materialIndex += 1) {
      const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterials[materialIndex]!, rockCounts[materialIndex]!);
      const transform = new THREE.Object3D();
      for (let index = 0; index < rockCounts[materialIndex]!; index += 1) {
        const angle = random() * Math.PI * 2;
        const distance = arenaRadius + 4 + random() * 43;
        const scale = 0.42 + random() * 2.15;
        transform.position.set(
          centerX + Math.cos(angle) * distance,
          this.map.bounds.floorY + scale * 0.35 - 0.15,
          centerZ + Math.sin(angle) * distance,
        );
        transform.scale.set(scale * (0.72 + random() * 0.66), scale * (0.58 + random() * 0.48), scale);
        transform.rotation.set(random() * 0.5, random() * Math.PI, random() * 0.35);
        transform.updateMatrix();
        rocks.setMatrixAt(index, transform.matrix);
      }
      rocks.instanceMatrix.needsUpdate = true;
      rocks.castShadow = false;
      rocks.receiveShadow = true;
      this.scene.add(rocks);
    }

    const plantMaterials = {
      stem: new THREE.MeshStandardMaterial({ color: 0x182b20, roughness: 0.94, flatShading: true }),
      leaf: new THREE.MeshStandardMaterial({
        color: 0x547c45,
        roughness: 0.82,
        flatShading: true,
      }),
      glow: new THREE.MeshStandardMaterial({
        color: 0xb8e85e,
        emissive: 0x5da63d,
        emissiveIntensity: 0.72,
        roughness: 0.28,
      }),
    };
    for (let index = 0; index < 16; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = arenaRadius + 3 + random() * 31;
      const plant = createColdAlienPlant({
        seed: 0xa11e + index,
        materials: plantMaterials,
        height: 1.4 + random() * 1.45,
        radius: 0.48 + random() * 0.34,
        blades: 4 + Math.floor(random() * 2),
        castShadow: index < 8,
      });
      plant.position.set(
        centerX + Math.cos(angle) * distance,
        this.map.bounds.floorY,
        centerZ + Math.sin(angle) * distance,
      );
      plant.rotation.y = random() * Math.PI * 2;
      this.worldDecorations.push(plant);
      this.scene.add(plant);
    }
  }

  private createEnvironmentDressing(): void {
    const floorY = this.map.bounds.floorY;
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const halfWidth = width * 0.5;
    const halfDepth = depth * 0.5;
    const centerX = (this.map.bounds.minX + this.map.bounds.maxX) * 0.5;
    const centerZ = (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5;
    const arenaArea = width * depth;
    const towerDeck = this.map.obstacles.find((obstacle) => obstacle.id === 'tower-deck');
    const deckMinX = towerDeck?.min.x ?? centerX - 7;
    const deckMaxX = towerDeck?.max.x ?? centerX + 7;
    const deckMinZ = towerDeck?.min.z ?? centerZ - 7;
    const deckMaxZ = towerDeck?.max.z ?? centerZ + 7;
    const railY = (towerDeck?.max.y ?? 5.85) + 0.81;
    const playableBounds = {
      minX: this.map.bounds.minX,
      maxX: this.map.bounds.maxX,
      minZ: this.map.bounds.minZ,
      maxZ: this.map.bounds.maxZ,
    };

    // Trees stay outside the collision boundary, where they can form the tall
    // forest silhouette without creating invisible gameplay blockers.
    const environment = createFacilityEnvironment({
      seed: 0xa57a1,
      quality: 'low',
      bounds: {
        minX: playableBounds.minX - 20,
        maxX: playableBounds.maxX + 20,
        minZ: playableBounds.minZ - 20,
        maxZ: playableBounds.maxZ + 20,
      },
      heightAt: () => floorY - 0.08,
      exclusions: [{ ...playableBounds, padding: 1.25 }],
      densityAt: (x, z) => {
        const distanceX = Math.max(0, playableBounds.minX - x, x - playableBounds.maxX);
        const distanceZ = Math.max(0, playableBounds.minZ - z, z - playableBounds.maxZ);
        const perimeter = Math.max(distanceX, distanceZ);
        return THREE.MathUtils.clamp(0.5 + perimeter * 0.055, 0.5, 1);
      },
      blocks: [
        {
          seed: 0xb1091,
          position: [centerX, floorY, playableBounds.minZ - 8.5],
          width: Math.min(28, width * 0.27),
          height: 8.2,
          depth: 7.5,
          label: 'BIO // 91',
          secondaryLabel: 'EXOFLORA LAB',
        },
        {
          seed: 0xa0404,
          position: [playableBounds.minX - 8.5, floorY, centerZ + depth * 0.2],
          rotationY: Math.PI * 0.5,
          width: 14,
          height: 7.2,
          depth: 7,
          label: 'AUR // 04',
          secondaryLabel: 'FIELD STATION',
        },
        {
          seed: 0xc0505,
          position: [playableBounds.maxX + 8.5, floorY, centerZ - depth * 0.2],
          rotationY: -Math.PI * 0.5,
          width: 14,
          height: 7.2,
          depth: 7,
          label: 'NVA // 05',
          secondaryLabel: 'FIELD STATION',
        },
        {
          seed: 0xd2230,
          position: [centerX, floorY, playableBounds.maxZ + 8],
          rotationY: Math.PI,
          width: 18,
          height: 6.8,
          depth: 6.5,
          label: 'C20 // J44',
          secondaryLabel: 'ATMOSPHERE CTRL',
        },
      ],
      rails: [
        {
          start: [deckMinX + 0.85, railY, deckMinZ + 0.18],
          end: [deckMaxX - 0.85, railY, deckMinZ + 0.18],
          height: 0.42,
          postSpacing: 1.45,
        },
        {
          start: [deckMaxX - 0.85, railY, deckMaxZ - 0.18],
          end: [deckMinX + 0.85, railY, deckMaxZ - 0.18],
          height: 0.42,
          postSpacing: 1.45,
        },
      ],
      cables: [
        {
          start: [playableBounds.minX - 8.5, 8.2, centerZ + depth * 0.17],
          end: [deckMinX - 0.2, railY + 2.4, deckMinZ + 0.2],
          sag: 1.4,
          radius: 0.035,
        },
        {
          start: [playableBounds.maxX + 8.5, 8.2, centerZ - depth * 0.17],
          end: [deckMaxX + 0.2, railY + 2.4, deckMaxZ - 0.2],
          sag: 1.4,
          radius: 0.035,
        },
        {
          start: [centerX - 10, 9.2, playableBounds.minZ - 4.5],
          end: [centerX + 10, 9.2, playableBounds.minZ - 4.5],
          sag: 0.9,
          radius: 0.04,
        },
      ],
    });

    // Ground cover can safely enter the arena, but all navigation, spawn,
    // objective, pickup and obstacle volumes remain deliberately clear.
    const exclusions: ScatterExclusion[] = [
      {
        minX: playableBounds.minX,
        maxX: playableBounds.maxX,
        minZ: centerZ - 3.8,
        maxZ: centerZ + 3.8,
      },
      {
        minX: centerX - 3.6,
        maxX: centerX + 3.6,
        minZ: playableBounds.minZ,
        maxZ: playableBounds.maxZ,
      },
      {
        minX: this.map.flagBases.aurora.x - 7,
        maxX: this.map.flagBases.aurora.x + 7,
        minZ: this.map.flagBases.aurora.z - 10,
        maxZ: this.map.flagBases.aurora.z + 10,
        padding: 0.8,
      },
      {
        minX: this.map.flagBases.nova.x - 7,
        maxX: this.map.flagBases.nova.x + 7,
        minZ: this.map.flagBases.nova.z - 10,
        maxZ: this.map.flagBases.nova.z + 10,
        padding: 0.8,
      },
      ...this.map.obstacles
        .filter((obstacle) => obstacle.kind !== 'wall')
        .map((obstacle) => ({
          minX: obstacle.min.x,
          maxX: obstacle.max.x,
          minZ: obstacle.min.z,
          maxZ: obstacle.max.z,
          padding: 0.85,
        })),
      ...this.map.spawns.map((spawn) => ({ x: spawn.position.x, z: spawn.position.z, radius: 2.35 })),
      ...this.map.waypoints.map((waypoint) => ({ x: waypoint.x, z: waypoint.z, radius: 1.7 })),
      ...this.map.pickups.map((pickup) => ({ x: pickup.position.x, z: pickup.position.z, radius: 1.75 })),
      { x: this.map.flagBases.aurora.x, z: this.map.flagBases.aurora.z, radius: 2.5 },
      { x: this.map.flagBases.nova.x, z: this.map.flagBases.nova.z, radius: 2.5 },
    ];
    const understory = createUnderstoryField({
      seed: 0xf0e57,
      bounds: playableBounds,
      materials: environment.materials,
      fernCount: Math.min(340, Math.round(arenaArea * 0.034)),
      // One instanced draw call can afford a genuinely lawn-like density in
      // the earth pockets while paths, objectives and interiors stay clear.
      grassCount: Math.min(4800, Math.round(arenaArea * 0.52)),
      heightAt: (x, z) => floorY - 0.035 + sampleGroundRelief(this.map, x, z) + 0.006,
      exclusions,
      castShadow: false,
      densityAt: (x, z) => {
        const edge = Math.max(
          Math.abs(x - centerX) / Math.max(1, halfWidth),
          Math.abs(z - centerZ) / Math.max(1, halfDepth),
        );
        const islands = Math.sin(x * 0.43 + z * 0.17) * Math.cos(z * 0.36 - x * 0.12) * 0.5 + 0.5;
        return THREE.MathUtils.clamp(0.22 + edge * 0.5 + islands * 0.25, 0.16, 0.92);
      },
    });
    const raisedEarthworks = this.map.obstacles.filter((obstacle) =>
      !obstacle.id.includes('outcrop')
      && (
        obstacle.id.includes('earth-')
        || obstacle.id.includes('ridge')
        || obstacle.id.includes('planter')
      ));
    const raisedEarthworkAt = (x: number, z: number) => raisedEarthworks.find((obstacle) =>
      x > obstacle.min.x + 0.28
      && x < obstacle.max.x - 0.28
      && z > obstacle.min.z + 0.28
      && z < obstacle.max.z - 0.28);
    const raisedUnderstory = createUnderstoryField({
      seed: 0xe47a1,
      bounds: playableBounds,
      materials: environment.materials,
      fernCount: 64,
      grassCount: 1_400,
      heightAt: (x, z) => raisedEarthworkAt(x, z)?.max.y ?? Number.NaN,
      densityAt: (x, z) => {
        const obstacle = raisedEarthworkAt(x, z);
        if (!obstacle) return 0;
        if (obstacle.id.includes('approach') || obstacle.id.includes('step')) return 0.38;
        return obstacle.id.includes('planter') ? 0.98 : 0.78;
      },
      castShadow: false,
    });
    const groundRocks = createWetRockField({
      seed: 0x5a11d,
      bounds: playableBounds,
      materials: environment.materials,
      count: Math.min(54, Math.round(arenaArea * 0.0046)),
      radiusRange: [0.12, 0.42],
      heightAt: (x, z) => floorY - 0.035 + sampleGroundRelief(this.map, x, z) + 0.005,
      exclusions,
      castShadow: false,
      densityAt: (x, z) => {
        const edge = Math.max(
          Math.abs(x - centerX) / Math.max(1, halfWidth),
          Math.abs(z - centerZ) / Math.max(1, halfDepth),
        );
        return THREE.MathUtils.clamp(0.18 + edge * 0.68, 0.15, 0.9);
      },
    });
    environment.group.add(understory, raisedUnderstory, groundRocks);
    this.facilityEnvironment = environment;
    this.scene.add(environment.group);
  }

  private createAtmosphereDetails(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const centerX = (this.map.bounds.minX + this.map.bounds.maxX) * 0.5;
    const centerZ = (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5;
    const random = seededRandom(0xa7f05);
    const fogTexture = createRadialTexture({ size: 192, profile: 'glow' });
    fogTexture.name = 'local-ground-haze';
    this.ownedTextures.add(fogTexture);

    const hazeMaterial = new THREE.MeshBasicMaterial({
      color: 0xb4d4ca,
      map: fogTexture,
      transparent: true,
      opacity: 0.075,
      blending: THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    const hazeGroup = new THREE.Group();
    hazeGroup.name = 'low-forest-haze';
    hazeGroup.userData.mistLayer = true;
    hazeGroup.userData.baseY = this.map.bounds.floorY + 0.22;
    const hazeCount = Math.max(9, Math.round((width * depth) / 720));
    for (let index = 0; index < hazeCount; index += 1) {
      const haze = new THREE.Mesh(new THREE.PlaneGeometry(14 + random() * 14, 9 + random() * 9), hazeMaterial);
      haze.rotation.x = -Math.PI / 2;
      haze.rotation.z = random() * Math.PI;
      haze.position.set(
        centerX + (random() - 0.5) * width * 0.92,
        (random() - 0.5) * 0.16,
        centerZ + (random() - 0.5) * depth * 0.92,
      );
      haze.renderOrder = -4;
      hazeGroup.add(haze);
    }
    hazeGroup.position.y = Number(hazeGroup.userData.baseY);
    this.worldDecorations.push(hazeGroup);
    this.scene.add(hazeGroup);

    const moteCount = Math.min(560, Math.max(320, Math.round((width * depth) * 0.052)));
    const positions = new Float32Array(moteCount * 3);
    for (let index = 0; index < moteCount; index += 1) {
      positions[index * 3] = centerX + (random() - 0.5) * (width + 8);
      positions[index * 3 + 1] = 0.35 + random() * 9;
      positions[index * 3 + 2] = centerZ + (random() - 0.5) * (depth + 8);
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const motes = new THREE.Points(
      moteGeometry,
      new THREE.PointsMaterial({
        color: 0xfff2cf,
        map: fogTexture,
        size: 0.075,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.34,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: true,
      }),
    );
    const moteGroup = new THREE.Group();
    moteGroup.name = 'floating-forest-motes';
    moteGroup.userData.ambientMotes = true;
    moteGroup.add(motes);
    this.worldDecorations.push(moteGroup);
    this.scene.add(moteGroup);
  }

  private createMapGeometry(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const centerX = (this.map.bounds.minX + this.map.bounds.maxX) * 0.5;
    const centerZ = (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5;
    const floorGeometry = new THREE.PlaneGeometry(
      width,
      depth,
      Math.min(80, Math.max(48, Math.round(width / 1.35))),
      Math.min(68, Math.max(40, Math.round(depth / 1.35))),
    );
    const position = floorGeometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const worldX = centerX + x;
      const worldZ = centerZ - y;
      position.setZ(vertex, sampleGroundRelief(this.map, worldX, worldZ));
    }
    applyGeometrySurfaceTint(floorGeometry, 0x7347a, centerX, centerZ, true);
    floorGeometry.computeVertexNormals();
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshPhysicalMaterial({
        color: 0xaebc9d,
        map: this.groundTexture,
        normalMap: this.groundNormalTexture,
        normalScale: new THREE.Vector2(0.85, 0.85),
        roughnessMap: this.groundRoughnessTexture,
        roughness: 0.9,
        metalness: 0,
        clearcoat: 0.07,
        clearcoatRoughness: 0.7,
        envMapIntensity: 0.38,
        vertexColors: true,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(
      centerX,
      this.map.bounds.floorY - 0.035,
      centerZ,
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    const puddleMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x173a36,
      roughness: 0.16,
      metalness: 0.02,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.55,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const puddleCount = Math.min(42, Math.max(22, Math.round((width * depth) / 245)));
    const puddles = new THREE.InstancedMesh(
      new THREE.CircleGeometry(1, 24),
      puddleMaterial,
      puddleCount,
    );
    puddles.name = 'forest-floor-puddles';
    puddles.receiveShadow = true;
    const puddleRandom = seededRandom(0x7e771e);
    const puddleTransform = new THREE.Object3D();
    let puddleIndex = 0;
    for (let attempt = 0; attempt < puddleCount * 24 && puddleIndex < puddleCount; attempt += 1) {
      const x = THREE.MathUtils.lerp(this.map.bounds.minX + 2, this.map.bounds.maxX - 2, puddleRandom());
      const z = THREE.MathUtils.lerp(this.map.bounds.minZ + 2, this.map.bounds.maxZ - 2, puddleRandom());
      const onMainPath = Math.abs(z - centerZ) < 4.2 || Math.abs(x - centerX) < 4;
      const insideObstacle = this.map.obstacles.some((obstacle) =>
        obstacle.kind !== 'wall'
        && x > obstacle.min.x - 0.8
        && x < obstacle.max.x + 0.8
        && z > obstacle.min.z - 0.8
        && z < obstacle.max.z + 0.8);
      const nearObjective = Object.values(this.map.flagBases).some((base) =>
        Math.hypot(x - base.x, z - base.z) < 5.5);
      if (onMainPath || insideObstacle || nearObjective) continue;
      const radius = 0.55 + puddleRandom() * 1.75;
      puddleTransform.position.set(
        x,
        this.map.bounds.floorY - 0.035 + sampleGroundRelief(this.map, x, z) + 0.008,
        z,
      );
      puddleTransform.rotation.set(-Math.PI / 2, 0, puddleRandom() * Math.PI);
      puddleTransform.scale.set(radius * (0.65 + puddleRandom() * 0.75), radius, 1);
      puddleTransform.updateMatrix();
      puddles.setMatrixAt(puddleIndex, puddleTransform.matrix);
      puddleIndex += 1;
    }
    puddles.count = puddleIndex;
    puddles.instanceMatrix.needsUpdate = true;
    puddles.computeBoundingBox();
    puddles.computeBoundingSphere();
    this.scene.add(puddles);

    const facilitySurfaceTemplate = new THREE.MeshPhysicalMaterial({
      color: 0xe0e5e1,
      map: this.facilityPanelTexture,
      roughness: 0.38,
      metalness: 0.16,
      clearcoat: 0.28,
      clearcoatRoughness: 0.36,
      envMapIntensity: 0.86,
    });
    const facilityUnderlay = new THREE.MeshStandardMaterial({
      color: 0x091216,
      roughness: 0.5,
      metalness: 0.58,
      envMapIntensity: 0.82,
    });
    const addFacilityPath = (
      pathWidth: number,
      pathDepth: number,
      x: number,
      z: number,
    ): void => {
      const underlay = new THREE.Mesh(
        new THREE.PlaneGeometry(pathWidth + 0.62, pathDepth + 0.62),
        facilityUnderlay,
      );
      underlay.rotation.x = -Math.PI / 2;
      underlay.position.set(x, this.map.bounds.floorY + 0.012, z);
      underlay.receiveShadow = true;
      this.scene.add(underlay);

      const surfaceMaterial = facilitySurfaceTemplate.clone();
      if (this.facilityPanelTexture) {
        const pathTexture = this.facilityPanelTexture.clone();
        pathTexture.repeat.set(
          Math.max(1, pathWidth / 7.5),
          Math.max(1, pathDepth / 7.5),
        );
        pathTexture.needsUpdate = true;
        surfaceMaterial.map = pathTexture;
        this.ownedTextures.add(pathTexture);
      }
      const panels = new THREE.Mesh(new THREE.PlaneGeometry(pathWidth, pathDepth), surfaceMaterial);
      panels.rotation.x = -Math.PI / 2;
      panels.position.set(x, this.map.bounds.floorY + 0.022, z);
      panels.receiveShadow = true;
      this.scene.add(panels);
    };
    const horizontalPathLength = width - 4;
    addFacilityPath(horizontalPathLength, 6.2, centerX, centerZ);
    addFacilityPath(5.8, depth - 4, centerX, centerZ);
    addFacilityPath(13, 20, this.map.flagBases.aurora.x, this.map.flagBases.aurora.z);
    addFacilityPath(13, 20, this.map.flagBases.nova.x, this.map.flagBases.nova.z);
    addFacilityPath(width * 0.68, 4, centerX, centerZ - depth * 0.32);
    addFacilityPath(width * 0.68, 4, centerX, centerZ + depth * 0.32);
    facilitySurfaceTemplate.dispose();

    const routeAccentMaterial = new THREE.MeshStandardMaterial({
      color: 0xb4ef3f,
      emissive: 0x6f9e20,
      emissiveIntensity: 0.35,
      roughness: 0.42,
      metalness: 0.16,
    });
    for (const z of [centerZ - 3.24, centerZ + 3.24]) {
      const routeAccent = new THREE.Mesh(
        new THREE.PlaneGeometry(horizontalPathLength, 0.13),
        routeAccentMaterial,
      );
      routeAccent.rotation.x = -Math.PI / 2;
      routeAccent.position.set(centerX, this.map.bounds.floorY + 0.027, z);
      this.scene.add(routeAccent);
    }

    const markingMaterial = new THREE.MeshBasicMaterial({
      color: 0x94c6ca,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const radius of [5.9, 12.2, Math.min(width, depth) * 0.34]) {
      const marking = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.065, 96), markingMaterial);
      marking.rotation.x = -Math.PI / 2;
      marking.position.set(centerX, this.map.bounds.floorY + 0.018, centerZ);
      this.scene.add(marking);
    }

    for (const team of ['aurora', 'nova'] as const) {
      const base = this.map.flagBases[team];
      const laneLength = Math.max(12, Math.hypot(base.x - centerX, base.z - centerZ) * 0.64);
      const laneCenterX = THREE.MathUtils.lerp(centerX, base.x, 0.48);
      const laneCenterZ = THREE.MathUtils.lerp(centerZ, base.z, 0.48);
      const laneMaterial = new THREE.MeshBasicMaterial({
        color: TEAM_COLORS[team].glow,
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
      });
      for (const zOffset of [-4.2, 4.2]) {
        const lane = new THREE.Mesh(new THREE.PlaneGeometry(laneLength, 0.075), laneMaterial);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(laneCenterX, this.map.bounds.floorY + 0.021, laneCenterZ + zOffset);
        this.scene.add(lane);
      }
    }

    const paintMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xdce3df,
      map: this.facilityPanelTexture,
      normalMap: this.technicalNormalTexture,
      normalScale: new THREE.Vector2(0.21, 0.21),
      roughnessMap: this.technicalRoughnessTexture,
      roughness: 0.34,
      metalness: 0.06,
      clearcoat: 0.34,
      clearcoatRoughness: 0.32,
      envMapIntensity: 0.9,
      vertexColors: true,
    });
    const structureMaterial = new THREE.MeshStandardMaterial({
      color: 0x081114,
      roughness: 0.38,
      metalness: 0.72,
      envMapIntensity: 1.05,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x121b1e,
      roughness: 0.68,
      metalness: 0.22,
    });
    const boundaryFieldMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x7ad9da) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform vec3 uColor;
        void main() {
          float scan = pow(1.0 - abs(fract(vUv.y * 16.0 - uTime * 0.18) - 0.5) * 2.0, 16.0);
          float border = 1.0 - smoothstep(0.0, 0.055, min(vUv.x, 1.0 - vUv.x));
          float fade = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.86, 1.0, vUv.y));
          float alpha = (0.012 + scan * 0.035 + border * 0.018) * fade;
          gl_FragColor = vec4(uColor * (0.72 + scan * 0.48), alpha);
        }
      `,
    });
    const earthworkMaterial = new THREE.MeshPhysicalMaterial({
      name: 'playable-earthwork-soil',
      color: 0x8b9f7c,
      map: this.groundTexture,
      normalMap: this.groundNormalTexture,
      normalScale: new THREE.Vector2(0.96, 0.96),
      roughnessMap: this.groundRoughnessTexture,
      roughness: 0.94,
      metalness: 0,
      clearcoat: 0.055,
      clearcoatRoughness: 0.72,
      envMapIntensity: 0.34,
      vertexColors: true,
    });
    const outcropMaterial = new THREE.MeshPhysicalMaterial({
      name: 'playable-weathered-rock',
      color: 0x53665b,
      map: this.groundTexture,
      normalMap: this.groundNormalTexture,
      normalScale: new THREE.Vector2(1.18, 1.18),
      roughnessMap: this.groundRoughnessTexture,
      roughness: 0.76,
      metalness: 0.035,
      clearcoat: 0.24,
      clearcoatRoughness: 0.52,
      envMapIntensity: 0.48,
      vertexColors: true,
    });

    for (const obstacle of this.map.obstacles) {
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
      // These collision volumes are rendered as segmented walls/skylights by
      // baseArchitecture so their glass reveals the playable interiors.
      if (ARCHITECTURE_AUTHORED_SHELLS.has(obstacle.id)) continue;
      const isRockyOutcrop = obstacle.id.includes('outcrop') || /^(north|south)-mid-cover/.test(obstacle.id);
      const isEarthwork = isRockyOutcrop || obstacle.id.includes('earth-') || obstacle.id.includes('ridge') || obstacle.id.includes('planter');
      if (isEarthwork) {
        const geometry = createEarthworkGeometry(size, hashString(obstacle.id), isRockyOutcrop);
        applyGeometryUvTransform(
          geometry,
          computeSurfaceUvTransform(
            size.x,
            size.z,
            {
              x: this.groundTexture?.repeat.x ?? 1,
              y: this.groundTexture?.repeat.y ?? 1,
            },
            hashString(`${obstacle.id}-uv`),
          ),
        );
        applyGeometrySurfaceTint(geometry, hashString(`${obstacle.id}-tint`));
        const terrain = new THREE.Mesh(
          geometry,
          isRockyOutcrop ? outcropMaterial : earthworkMaterial,
        );
        terrain.name = `${obstacle.id}-organic-visual`;
        terrain.position.copy(center);
        terrain.castShadow = isRockyOutcrop || size.y > 0.8;
        terrain.receiveShadow = true;
        this.scene.add(terrain);
        continue;
      }
      const authoredPropDetail = /cover|crate|console|screen|slab/.test(obstacle.id);
      const isCompactDetailedProp = authoredPropDetail
        && obstacle.kind === 'cover'
        && size.x <= 8.5
        && size.y <= 4.5
        && size.z <= 8.5
        && !obstacle.id.includes('growbed');
      const baseColor = obstacle.kind === 'tower'
        ? new THREE.Color(0x172327)
        : obstacle.id.includes('base-back')
          ? new THREE.Color(0x9fbd47)
          : obstacle.id.includes('ridge')
            ? new THREE.Color(0xc7d1cc)
            : new THREE.Color(0xdce3df);
      const material = paintMaterial.clone();
      material.color.copy(baseColor);
      material.roughness = obstacle.kind === 'tower' ? 0.32 : 0.38;
      material.metalness = obstacle.kind === 'tower' ? 0.48 : 0.08;
      const minimum = Math.min(size.x, size.y, size.z);
      const bevel = Math.min(0.16, Math.max(0.035, minimum * 0.12));
      const geometry = new RoundedBoxGeometry(size.x, size.y, size.z, 3, bevel);
      applyGeometryUvTransform(
        geometry,
        computeSurfaceUvTransform(
          size.x,
          size.z,
          FACILITY_PANEL_REPEAT,
          hashString(`${obstacle.id}-panel-uv`),
          6.5,
        ),
      );
      applyGeometrySurfaceTint(geometry, hashString(`${obstacle.id}-panel-tint`));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(center);
      if (obstacle.kind === 'wall') {
        const visibleHeight = 2.3;
        mesh.scale.y = visibleHeight / size.y;
        mesh.position.y = obstacle.min.y + visibleHeight * 0.5;

        const fieldHeight = size.y - visibleHeight;
        const horizontal = size.x >= size.z;
        const field = new THREE.Mesh(
          new THREE.PlaneGeometry(horizontal ? size.x : size.z, fieldHeight, 1, 1),
          boundaryFieldMaterial,
        );
        field.position.set(center.x, obstacle.min.y + visibleHeight + fieldHeight * 0.5, center.z);
        if (!horizontal) field.rotation.y = Math.PI / 2;
        field.userData.boundaryField = true;
        this.worldDecorations.push(field as unknown as THREE.Group);
        this.scene.add(field);

        const rail = new THREE.Mesh(
          horizontal
            ? new RoundedBoxGeometry(size.x * 0.985, 0.075, 0.12, 2, 0.025)
            : new RoundedBoxGeometry(0.12, 0.075, size.z * 0.985, 2, 0.025),
          new THREE.MeshStandardMaterial({
            color: 0xc0f04d,
            emissive: 0x6f9e28,
            emissiveIntensity: 0.72,
            roughness: 0.26,
            metalness: 0.52,
          }),
        );
        rail.position.set(center.x, obstacle.min.y + visibleHeight + 0.025, center.z);
        this.scene.add(rail);
      }
      mesh.castShadow = obstacle.kind !== 'wall'
        && size.y > 0.32
        && (size.x < 18 || size.z < 18);
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      if (isCompactDetailedProp) {
        const plinthHeight = Math.min(0.16, size.y * 0.12);
        const plinth = new THREE.Mesh(
          new RoundedBoxGeometry(size.x * 0.96, plinthHeight, size.z * 0.96, 2, Math.min(0.06, plinthHeight * 0.3)),
          structureMaterial,
        );
        plinth.position.set(center.x, obstacle.min.y + plinthHeight * 0.5 + 0.012, center.z);
        plinth.castShadow = false;
        plinth.receiveShadow = true;
        this.scene.add(plinth);
      }

      if (isCompactDetailedProp && size.x > 1.4 && size.z > 1.4) {
        const topHeight = 0.075;
        const top = new THREE.Mesh(
          new RoundedBoxGeometry(size.x * 0.84, topHeight, size.z * 0.84, 2, 0.025),
          new THREE.MeshStandardMaterial({
            color: baseColor.clone().lerp(new THREE.Color(0xf2f4ef), 0.42),
            roughness: 0.3,
            metalness: 0.18,
            envMapIntensity: 0.92,
          }),
        );
        top.position.set(center.x, obstacle.max.y + topHeight * 0.42, center.z);
        top.castShadow = false;
        top.receiveShadow = true;
        this.scene.add(top);
      }

      if (isCompactDetailedProp) {
        const horizontal = size.x >= size.z;
        const panel = new THREE.Mesh(
          horizontal
            ? new RoundedBoxGeometry(Math.max(0.42, size.x * 0.42), Math.min(0.36, size.y * 0.32), 0.055, 2, 0.025)
            : new RoundedBoxGeometry(0.055, Math.min(0.36, size.y * 0.32), Math.max(0.42, size.z * 0.42), 2, 0.025),
          jointMaterial,
        );
        panel.position.copy(center);
        if (horizontal) panel.position.z -= size.z * 0.5 + 0.012;
        else panel.position.x -= size.x * 0.5 + 0.012;
        this.scene.add(panel);

        const team = center.x < -7 ? 'aurora' : center.x > 7 ? 'nova' : 'neutral';
        const strip = new THREE.Mesh(
          horizontal
            ? new RoundedBoxGeometry(Math.max(0.3, size.x * 0.28), 0.035, 0.065, 2, 0.014)
            : new RoundedBoxGeometry(0.065, 0.035, Math.max(0.3, size.z * 0.28), 2, 0.014),
          new THREE.MeshStandardMaterial({
            color: TEAM_COLORS[team].accent,
            emissive: TEAM_COLORS[team].glow,
            emissiveIntensity: 1.8,
            roughness: 0.24,
            metalness: 0.3,
          }),
        );
        strip.position.copy(panel.position);
        strip.position.y += Math.min(0.25, size.y * 0.22);
        if (horizontal) strip.position.z -= 0.035;
        else strip.position.x -= 0.035;
        this.scene.add(strip);

        const oppositePanel = panel.clone();
        const oppositeStrip = strip.clone();
        if (horizontal) {
          oppositePanel.position.z = center.z + size.z * 0.5 + 0.012;
          oppositeStrip.position.z = oppositePanel.position.z + 0.035;
        } else {
          oppositePanel.position.x = center.x + size.x * 0.5 + 0.012;
          oppositeStrip.position.x = oppositePanel.position.x + 0.035;
        }
        this.scene.add(oppositePanel, oppositeStrip);
      }

      if (obstacle.id === 'tower-core') {
        for (let index = 0; index < 8; index += 1) {
          const angle = (index / 8) * Math.PI * 2;
          const rib = new THREE.Mesh(new RoundedBoxGeometry(0.3, size.y * 0.92, 0.26, 2, 0.055), structureMaterial);
          rib.position.set(
            center.x + Math.cos(angle) * (size.x * 0.49),
            center.y,
            center.z + Math.sin(angle) * (size.z * 0.49),
          );
          rib.rotation.y = -angle;
          rib.castShadow = true;
          this.scene.add(rib);
        }
      }

      if (obstacle.id === 'tower-cap') {
        const coreGlow = new THREE.MeshStandardMaterial({
          color: 0x86e7dc,
          emissive: 0x43cfc6,
          emissiveIntensity: 2.15,
          roughness: 0.2,
          metalness: 0.32,
        });
        for (const side of [-1, 1]) {
          const xStrip = new THREE.Mesh(new RoundedBoxGeometry(0.055, size.y * 0.62, 0.18, 2, 0.02), coreGlow);
          xStrip.position.set(center.x + side * (size.x * 0.5 + 0.02), center.y, center.z);
          this.scene.add(xStrip);
          const zStrip = new THREE.Mesh(new RoundedBoxGeometry(0.18, size.y * 0.62, 0.055, 2, 0.02), coreGlow);
          zStrip.position.set(center.x, center.y, center.z + side * (size.z * 0.5 + 0.02));
          this.scene.add(zStrip);
        }
      }

      if (obstacle.id === 'west-base-back' || obstacle.id === 'east-base-back') {
        const team = obstacle.id.startsWith('west') ? 'aurora' : 'nova';
        const face = obstacle.id.startsWith('west') ? 1 : -1;
        const airlock = new THREE.Group();
        const frame = new THREE.Mesh(new RoundedBoxGeometry(0.32, 3.55, 4.2, 3, 0.12), structureMaterial);
        const door = new THREE.Mesh(
          new RoundedBoxGeometry(0.36, 2.75, 3.35, 3, 0.14),
          new THREE.MeshStandardMaterial({ color: 0x1c3543, roughness: 0.46, metalness: 0.38 }),
        );
        frame.position.x = face * 0.04;
        door.position.x = face * 0.23;
        airlock.add(frame, door);
        for (const z of [-1.18, 1.18]) {
          const lamp = new THREE.Mesh(
            new RoundedBoxGeometry(0.08, 1.45, 0.09, 2, 0.025),
            new THREE.MeshStandardMaterial({
              color: TEAM_COLORS[team].accent,
              emissive: TEAM_COLORS[team].glow,
              emissiveIntensity: 2.4,
              roughness: 0.2,
            }),
          );
          lamp.position.set(face * 0.46, 0.12, z);
          airlock.add(lamp);
        }
        airlock.position.set(center.x + face * size.x * 0.5, obstacle.min.y + 2.0, center.z);
        this.scene.add(airlock);
      }
    }

    for (const jumpPad of JUMP_PAD_ZONES) {
      const position: Vec3 = {
        x: jumpPad.center.x,
        y: this.map.bounds.floorY,
        z: jumpPad.center.z,
      };
      if (!isJumpPad(position)) continue;
      const launchDirection = new THREE.Vector3(
        this.map.towerCenter.x - position.x,
        0,
        this.map.towerCenter.z - position.z,
      ).normalize();
      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.42, 1.56, 0.2, 32),
        structureMaterial,
      );
      pedestal.position.set(position.x, this.map.bounds.floorY + 0.1, position.z);
      pedestal.receiveShadow = true;
      pedestal.castShadow = true;
      this.scene.add(pedestal);

      const material = new THREE.MeshBasicMaterial({
        color: 0x73e2de,
        transparent: true,
        opacity: 0.72,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.12, 24, 2), material);
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(position.x, this.map.bounds.floorY + 0.215, position.z);
      pad.userData.spin = position.x < this.map.towerCenter.x ? 1 : -1;
      this.worldDecorations.push(pad as unknown as THREE.Group);
      this.scene.add(pad);

      const launchGlow = new THREE.Mesh(
        new THREE.CircleGeometry(0.92, 28),
        new THREE.MeshBasicMaterial({
          color: 0x79eee2,
          transparent: true,
          opacity: 0.2,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      launchGlow.rotation.x = -Math.PI / 2;
      launchGlow.position.set(position.x, this.map.bounds.floorY + 0.222, position.z);
      this.scene.add(launchGlow);

      for (let index = 0; index < 3; index += 1) {
        const chevron = new THREE.Mesh(
          new THREE.ConeGeometry(0.18 + index * 0.025, 0.52, 3),
          new THREE.MeshStandardMaterial({
            color: 0xbaf65c,
            emissive: 0x70bd3b,
            emissiveIntensity: 1.15,
            roughness: 0.28,
            metalness: 0.18,
          }),
        );
        chevron.quaternion.setFromUnitVectors(UP, launchDirection);
        chevron.position.set(position.x, this.map.bounds.floorY + 0.27, position.z)
          .addScaledVector(launchDirection, -0.5 + index * 0.5);
        this.scene.add(chevron);
      }
    }
  }

  private createObjectiveMarkers(): void {
    for (const team of ['aurora', 'nova'] as const) {
      const palette = TEAM_COLORS[team];
      const basePosition = this.map.flagBases[team];
      const beacon = new THREE.Group();
      beacon.position.set(basePosition.x, basePosition.y - 0.34, basePosition.z);
      beacon.userData.teamBeaconStructure = team;
      const baseMaterial = new THREE.MeshStandardMaterial({
        color: 0x122734,
        roughness: 0.38,
        metalness: 0.72,
        envMapIntensity: 1.1,
      });
      const glowMaterial = new THREE.MeshStandardMaterial({
        color: palette.accent,
        emissive: palette.glow,
        emissiveIntensity: 2.25,
        roughness: 0.2,
        metalness: 0.26,
      });
      const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.96, 0.28, 24), baseMaterial);
      pedestal.position.y = 0.14;
      pedestal.castShadow = true;
      pedestal.receiveShadow = true;
      beacon.add(pedestal);
      const luminousCore = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.47, 0.12, 24), glowMaterial);
      luminousCore.position.y = 0.33;
      beacon.add(luminousCore);
      for (let index = 0; index < 3; index += 1) {
        const angle = (index / 3) * Math.PI * 2;
        const fin = new THREE.Mesh(new RoundedBoxGeometry(0.13, 0.55, 0.3, 2, 0.04), baseMaterial);
        fin.position.set(Math.cos(angle) * 0.62, 0.43, Math.sin(angle) * 0.62);
        fin.rotation.y = -angle;
        fin.rotation.z = -0.19;
        fin.castShadow = true;
        beacon.add(fin);
      }
      const hologram = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.46, 1.65, 24, 1, true),
        new THREE.MeshBasicMaterial({
          color: palette.glow,
          transparent: true,
          opacity: 0.065,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      hologram.position.y = 1.12;
      beacon.add(hologram);
      this.worldDecorations.push(beacon);
      this.scene.add(beacon);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.15, 1.72, 36),
        new THREE.MeshBasicMaterial({
          color: palette.glow,
          transparent: true,
          opacity: 0.35,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(basePosition.x, basePosition.y + 0.025, basePosition.z);
      ring.userData.teamBeacon = team;
      this.worldDecorations.push(ring as unknown as THREE.Group);
      this.scene.add(ring);
    }

    const towerRadius = 5.4;
    const towerRing = new THREE.Mesh(
      new THREE.RingGeometry(towerRadius - 0.18, towerRadius, 64),
      this.towerRingMaterial,
    );
    towerRing.rotation.x = -Math.PI / 2;
    towerRing.position.set(this.map.towerCenter.x, this.map.towerCenter.y + 0.025, this.map.towerCenter.z);
    towerRing.userData.towerRing = true;
    this.worldDecorations.push(towerRing as unknown as THREE.Group);
    this.scene.add(towerRing);

    const turretBaseMaterial = new THREE.MeshStandardMaterial({
      color: 0x152b38,
      roughness: 0.34,
      metalness: 0.72,
      envMapIntensity: 1.15,
    });
    const turretMetalMaterial = new THREE.MeshStandardMaterial({
      color: 0x6f8c94,
      roughness: 0.22,
      metalness: 0.9,
      envMapIntensity: 1.4,
    });
    const turretGlowMaterial = new THREE.MeshStandardMaterial({
      color: 0x7ee4dc,
      emissive: 0x3ccac2,
      emissiveIntensity: 2.0,
      roughness: 0.24,
      metalness: 0.35,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.84, 0.62, 12), turretBaseMaterial);
    base.position.y = 0.32;
    base.castShadow = true;
    this.towerTurret.add(base);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.54, 0.075, 8, 24), turretGlowMaterial);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.63;
    this.towerTurret.add(collar);
    const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10), turretMetalMaterial);
    gimbal.scale.set(1.25, 0.78, 1);
    gimbal.position.y = 0.84;
    gimbal.castShadow = true;
    this.towerTurret.add(gimbal);
    this.towerTurretPitch.position.y = 0.87;
    this.towerTurret.add(this.towerTurretPitch);
    const cradle = new THREE.Mesh(new RoundedBoxGeometry(1.06, 0.45, 0.78, 3, 0.12), turretBaseMaterial);
    cradle.position.set(0, 0, -0.23);
    cradle.castShadow = true;
    this.towerTurretPitch.add(cradle);
    for (const x of [-0.25, 0.25]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.09, 1.82, 12), turretMetalMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(x, 0.05, -1.05);
      barrel.castShadow = true;
      this.towerTurretPitch.add(barrel);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 12), turretGlowMaterial);
      sleeve.rotation.x = Math.PI / 2;
      sleeve.position.set(x, 0.05, -0.61);
      this.towerTurretPitch.add(sleeve);
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.028, 7, 16), turretMetalMaterial);
      muzzle.position.set(x, 0.05, -1.97);
      this.towerTurretPitch.add(muzzle);
      this.towerTurretMuzzles.push(muzzle);
    }
    const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 9), turretGlowMaterial);
    sensor.position.set(0, 0.31, -0.32);
    this.towerTurretPitch.add(sensor);
    // A sight just behind and above the cradle gives the operator a readable
    // view of both barrels without putting the camera inside turret geometry.
    this.towerTurretCameraMount.position.set(0, 0.52, 0.16);
    this.towerTurretPitch.add(this.towerTurretCameraMount);
    // The control volume lives on the main deck; the physical turret sits on
    // the raised cap (the simulation fires from towerCenter.y + 2.7).
    this.towerTurret.position.set(
      this.map.towerCenter.x,
      this.map.towerCenter.y + 1.7,
      this.map.towerCenter.z,
    );
    this.scene.add(this.towerTurret);
  }

  private createViewModel(): void {
    this.viewModel.position.set(0.31, -0.28, -0.62);
    this.viewModel.rotation.set(-0.03, -0.045, 0.012);
    this.viewCamera.add(this.viewModel);
    this.viewModel.add(this.viewActionPivot);
    this.viewActionPivot.add(
      this.viewRightHandAssembly,
      this.viewLeftHandAssembly,
      this.viewWeaponMount,
    );

    const gloveMaterial = new THREE.MeshStandardMaterial({
      color: 0x172831,
      roughness: 0.76,
      metalness: 0.08,
    });
    const cuffMaterial = new THREE.MeshStandardMaterial({
      color: 0x5f7d85,
      roughness: 0.32,
      metalness: 0.7,
      envMapIntensity: 1.2,
    });

    const rightForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.082, 0.36, 5, 12), this.viewArmMaterial);
    rightForearm.rotation.x = Math.PI * 0.47;
    rightForearm.position.set(0.2, -0.09, 0.13);
    this.viewRightHandAssembly.add(rightForearm);
    const rightBracer = new THREE.Mesh(new RoundedBoxGeometry(0.19, 0.16, 0.29, 3, 0.05), this.viewArmMaterial);
    rightBracer.position.set(0.2, -0.055, -0.015);
    rightBracer.rotation.x = -0.08;
    this.viewRightHandAssembly.add(rightBracer);
    const rightCuff = new THREE.Mesh(new THREE.TorusGeometry(0.086, 0.022, 8, 18), cuffMaterial);
    rightCuff.position.set(0.2, -0.018, -0.155);
    rightCuff.rotation.x = Math.PI / 2;
    this.viewRightHandAssembly.add(rightCuff);
    const rightGlove = new THREE.Group();
    rightGlove.position.set(0.2, -0.015, -0.24);
    const rightPalm = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.14, 0.2, 3, 0.045), gloveMaterial);
    rightGlove.add(rightPalm);
    for (let finger = -1; finger <= 1; finger += 1) {
      const digit = new THREE.Mesh(new RoundedBoxGeometry(0.043, 0.05, 0.15, 2, 0.018), cuffMaterial);
      digit.position.set(finger * 0.052, 0.02, -0.135);
      digit.rotation.x = -0.13;
      rightGlove.add(digit);
    }
    const rightThumb = new THREE.Mesh(new RoundedBoxGeometry(0.055, 0.07, 0.12, 2, 0.022), gloveMaterial);
    rightThumb.position.set(-0.105, -0.005, -0.045);
    rightThumb.rotation.z = -0.5;
    rightGlove.add(rightThumb);
    this.viewRightHandAssembly.add(rightGlove);

    const leftForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.32, 5, 12), this.viewArmMaterial);
    leftForearm.rotation.x = Math.PI * 0.43;
    leftForearm.rotation.z = -0.2;
    leftForearm.position.set(-0.18, -0.08, -0.05);
    this.viewLeftHandAssembly.add(leftForearm);
    const leftBracer = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.145, 0.27, 3, 0.045), this.viewArmMaterial);
    leftBracer.position.set(-0.15, -0.045, -0.17);
    leftBracer.rotation.set(-0.1, 0, -0.16);
    this.viewLeftHandAssembly.add(leftBracer);
    const leftCuff = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.02, 8, 18), cuffMaterial);
    leftCuff.position.set(-0.13, -0.012, -0.305);
    leftCuff.rotation.x = Math.PI / 2;
    this.viewLeftHandAssembly.add(leftCuff);
    const leftGlove = new THREE.Group();
    leftGlove.position.set(-0.115, -0.005, -0.38);
    leftGlove.rotation.z = -0.12;
    const leftPalm = new THREE.Mesh(new RoundedBoxGeometry(0.155, 0.125, 0.18, 3, 0.04), gloveMaterial);
    leftGlove.add(leftPalm);
    for (let finger = -1; finger <= 1; finger += 1) {
      const digit = new THREE.Mesh(new RoundedBoxGeometry(0.039, 0.045, 0.135, 2, 0.016), cuffMaterial);
      digit.position.set(finger * 0.047, 0.018, -0.12);
      digit.rotation.x = -0.12;
      leftGlove.add(digit);
    }
    this.viewLeftHandAssembly.add(leftGlove);

    this.viewModel.traverse((object) => {
      object.frustumCulled = false;
      object.renderOrder = 30;
    });
  }

  private createDamageOverlay(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { uStrength: this.damageUniform },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uStrength;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float edge = smoothstep(0.18, 1.08, length(p * vec2(0.72, 1.0)));
          float corners = smoothstep(0.34, 1.25, abs(p.x) + abs(p.y));
          float alpha = max(edge, corners * 0.55) * uStrength;
          gl_FragColor = vec4(0.64, 0.08, 0.24, alpha);
        }
      `,
    });
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    overlay.position.z = -0.105;
    overlay.renderOrder = 1000;
    overlay.frustumCulled = false;
    this.viewCamera.add(overlay);
    return overlay;
  }

  private syncPlayers(
    state: MatchState,
    alpha: number,
    worldTime: number,
    firstPerson: boolean,
    delta: number,
  ): void {
    const present = new Set<string>();
    const localPlayer = this.localPlayerId ? state.players[this.localPlayerId] : undefined;
    const teamMode = isTeamGameMode(state.config.mode);
    for (const player of Object.values(state.players)) {
      present.add(player.id);
      let rig = this.playerRigs.get(player.id);
      if (!rig) {
        rig = this.createAstronaut(player);
        this.playerRigs.set(player.id, rig);
        this.scene.add(rig.root);
      }

      if (rig.team !== player.team) this.updateRigTeam(rig, player.team);
      if (rig.lastTick !== state.tick) {
        const nextPosition = vectorFrom(player.position);
        if (rig.targetPosition.distanceToSquared(nextPosition) > 36) {
          rig.previousPosition.copy(nextPosition);
          rig.targetPosition.copy(nextPosition);
          rig.root.position.copy(nextPosition);
          rig.previousYaw = player.yaw;
          rig.targetYaw = player.yaw;
        } else {
          rig.previousPosition.copy(rig.targetPosition);
          rig.targetPosition.copy(nextPosition);
          rig.previousYaw = rig.targetYaw;
          rig.targetYaw = player.yaw;
        }
        rig.lastTick = state.tick;
      }
      const desiredPosition = new THREE.Vector3().lerpVectors(
        rig.previousPosition,
        rig.targetPosition,
        alpha,
      );
      const desiredYaw = lerpAngle(rig.previousYaw, rig.targetYaw, alpha);
      const presentationDamping = alpha > 0.001 ? 1 : 1 - Math.exp(-delta * 18);
      rig.root.position.lerp(desiredPosition, presentationDamping);
      rig.root.rotation.y = lerpAngle(rig.root.rotation.y, desiredYaw, presentationDamping);

      const activeWeapon = player.inventory[player.activeWeapon] ?? player.inventory[0];
      const weaponId = activeWeapon?.id ?? null;
      if (weaponId !== rig.weaponId) this.setRigWeapon(rig, weaponId);
      this.updateRigAnimation(rig, player, activeWeapon, worldTime, delta);

      const recentlyDamaged = state.elapsed - player.lastDamageAt < 0.22;
      rig.shield.visible = player.alive && player.shield > 0 && (recentlyDamaged || player.spawnProtection > 0);
      rig.shield.material.opacity = player.spawnProtection > 0
        ? 0.12 + Math.sin(worldTime * 12) * 0.035
        : 0.2;
      rig.shield.rotation.y = worldTime * 0.55;
      rig.juggernautRing.visible = player.alive && player.isJuggernaut;
      const horizontalSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      rig.contactShadow.material.opacity = (0.28 + Math.min(horizontalSpeed / 8, 1) * 0.1) * rig.groundBlend;
      rig.contactShadow.scale.setScalar(0.82 + rig.groundBlend * 0.18);
      rig.contactShadow.visible = player.grounded
        && (player.alive || rig.deathTimer > 0)
        && rig.contactShadow.material.opacity > 0.01;
      rig.juggernautRing.rotation.z = worldTime * 0.72;
      const friendly = Boolean(
        localPlayer
        && teamMode
        && player.id !== localPlayer.id
        && player.team === localPlayer.team,
      );
      rig.friendlyMarker.visible = player.alive && friendly;
      if (rig.friendlyMarker.visible) {
        const markerDistance = rig.root.position.distanceTo(this.camera.position);
        rig.friendlyMarker.material.opacity = THREE.MathUtils.clamp(
          1.08 - markerDistance / 180,
          0.62,
          0.96,
        );
      }
      rig.armorMaterial.emissiveIntensity = 0;
      rig.accentMaterial.emissiveIntensity = player.isJuggernaut ? 1.05 : 0.3;
      rig.visorMaterial.emissiveIntensity = player.isJuggernaut
        ? 0.9 + Math.sin(worldTime * 5) * 0.16
        : 0.5;
      rig.root.visible = (player.alive || rig.deathTimer > 0)
        && !(firstPerson && player.id === this.localPlayerId && player.alive);
    }

    for (const [id, rig] of this.playerRigs) {
      if (present.has(id)) continue;
      rig.weaponMount.clear();
      this.scene.remove(rig.root);
      const markerTexture = rig.friendlyMarker.material.map;
      if (markerTexture) {
        this.ownedTextures.delete(markerTexture);
        markerTexture.dispose();
      }
      disposeObject(rig.root);
      this.playerRigs.delete(id);
    }
  }

  private updateRigAnimation(
    rig: PlayerRig,
    player: PlayerState,
    activeWeapon: PlayerState['inventory'][number] | undefined,
    worldTime: number,
    delta: number,
  ): void {
    if (!rig.previousGrounded && player.grounded && rig.previousVerticalVelocity < -0.65) {
      rig.landingTimer = 0.34;
      rig.landingStrength = THREE.MathUtils.clamp(-rig.previousVerticalVelocity / 8.5, 0, 1);
    } else if (rig.previousGrounded && !player.grounded && player.velocity.y > 0.25) {
      rig.jumpTimer = 0.32;
    }
    if (player.meleeCooldown > rig.previousMeleeCooldown + 0.12) rig.meleeTimer = 0.85;
    if (player.grenadeCooldown > rig.previousGrenadeCooldown + 0.12) rig.grenadeTimer = 0.65;
    if (rig.previousAlive && !player.alive) rig.deathTimer = 1.05;
    if (!rig.previousAlive && player.alive) rig.spawnTimer = 0.62;

    rig.previousGrounded = player.grounded;
    rig.previousVerticalVelocity = player.velocity.y;
    rig.previousMeleeCooldown = player.meleeCooldown;
    rig.previousGrenadeCooldown = player.grenadeCooldown;
    rig.previousAlive = player.alive;

    const horizontalSpeed = Math.hypot(player.velocity.x, player.velocity.z);
    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    const rightX = Math.cos(player.yaw);
    const rightZ = -Math.sin(player.yaw);
    const forwardSpeed = player.velocity.x * forwardX + player.velocity.z * forwardZ;
    const strafeSpeed = player.velocity.x * rightX + player.velocity.z * rightZ;
    const locomotion = evaluateLocomotionCycle(horizontalSpeed, forwardSpeed, strafeSpeed, delta);
    rig.moveBlend = damp(rig.moveBlend, locomotion.moveBlend, 13, delta);
    rig.groundBlend = damp(rig.groundBlend, player.grounded ? 1 : 0, player.grounded ? 19 : 13, delta);
    rig.forwardBlend = damp(rig.forwardBlend, locomotion.forwardBlend, 10, delta);
    rig.strafeBlend = damp(rig.strafeBlend, locomotion.strafeBlend, 10, delta);

    const runBlend = locomotion.runBlend;
    rig.locomotionPhase = advanceLocomotionPhase(rig.locomotionPhase, locomotion.phaseDelta);
    const cycle = Math.sin(rig.locomotionPhase);
    const gait = evaluateDirectionalGait(rig.locomotionPhase, {
      moveBlend: rig.moveBlend,
      runBlend,
      forwardBlend: rig.forwardBlend,
      strafeBlend: rig.strafeBlend,
    });
    const groundedWeight = rig.groundBlend;
    const airborneWeight = 1 - groundedWeight;
    const rise = saturate(player.velocity.y / 6.3);
    const fall = saturate(-player.velocity.y / 9);
    const leftAirHip = rise * (0.28 + cycle * 0.1) - fall * 0.08;
    const rightAirHip = rise * (0.14 - cycle * 0.1) + fall * 0.08;
    const landingProgress = normalizedTimer(rig.landingTimer, 0.34);
    const landingWeight = trianglePulse(landingProgress, 0, 0.2, 1) * rig.landingStrength;
    const jumpProgress = normalizedTimer(rig.jumpTimer, 0.32);
    const jumpWeight = trianglePulse(jumpProgress, 0, 0.18, 1);
    const hitWeight = trianglePulse(normalizedTimer(rig.hitTimer, 0.24), 0, 0.18, 1);

    const leftHipX = gait.leftHipPitch * groundedWeight + leftAirHip * airborneWeight - jumpWeight * 0.08;
    const rightHipX = gait.rightHipPitch * groundedWeight + rightAirHip * airborneWeight - jumpWeight * 0.02;
    const airKnee = rise * 0.52 + fall * 0.12;
    const leftKneeX = gait.leftKnee * groundedWeight + airKnee * airborneWeight + landingWeight * 0.72;
    const rightKneeX = gait.rightKnee * groundedWeight + airKnee * airborneWeight + landingWeight * 0.72;

    rig.leftLeg.rotation.set(leftHipX, 0, gait.leftHipRoll * groundedWeight);
    rig.rightLeg.rotation.set(rightHipX, 0, gait.rightHipRoll * groundedWeight);
    rig.leftKnee.rotation.set(-leftKneeX, 0, 0);
    rig.rightKnee.rotation.set(-rightKneeX, 0, 0);
    rig.leftFoot.rotation.set(
      THREE.MathUtils.lerp(gait.leftFootPitch, -leftHipX + leftKneeX * 0.78, airborneWeight),
      0,
      -gait.leftHipRoll * 0.34 * groundedWeight,
    );
    rig.rightFoot.rotation.set(
      THREE.MathUtils.lerp(gait.rightFootPitch, -rightHipX + rightKneeX * 0.78, airborneWeight),
      0,
      -gait.rightHipRoll * 0.34 * groundedWeight,
    );

    const visualTime = this.elapsedRenderTime + (hashString(player.id) % 100) * 0.017;
    const breathing = Math.sin(visualTime * 1.75) * 0.0065 * (1 - rig.moveBlend * 0.72);
    const gaitBob = Math.abs(Math.sin(rig.locomotionPhase))
      * THREE.MathUtils.lerp(0.018, 0.052, runBlend)
      * rig.moveBlend
      * groundedWeight;
    const lateralSway = Math.cos(rig.locomotionPhase) * 0.018 * rig.moveBlend * groundedWeight;
    rig.torso.position.set(
      lateralSway,
      ASTRONAUT_WAIST_HEIGHT + breathing + gaitBob - landingWeight * 0.12,
      0,
    );
    rig.torso.rotation.set(
      player.pitch * 0.075
        + gait.torsoPitch * groundedWeight
        + landingWeight * 0.1
        + fall * airborneWeight * 0.055,
      0,
      (gait.torsoRoll + gait.pelvisRoll * 0.42) * groundedWeight
        - cycle * 0.012 * rig.moveBlend * groundedWeight
        + rig.hitDirection * hitWeight * 0.085,
    );
    rig.upperBodyAim.rotation.set(
      THREE.MathUtils.clamp(player.pitch * 0.61 - rig.torso.rotation.x * 0.18, -0.92, 0.92),
      0,
      0,
    );
    rig.head.rotation.set(
      THREE.MathUtils.clamp(player.pitch * 0.36, -0.48, 0.48),
      Math.sin(visualTime * 0.43) * 0.012 * (1 - rig.moveBlend),
      rig.strafeBlend * 0.025 * rig.moveBlend,
    );

    let actionKind: 'none' | 'reload' | 'swap' | 'melee' | 'grenade' = 'none';
    let actionPose: ActionPoseWeights = { lower: 0, twist: 0, part: 0, hand: 0 };
    let reloadProgress = 0;
    if (activeWeapon && activeWeapon.reloadTimer > 0) {
      reloadProgress = normalizedTimer(activeWeapon.reloadTimer, WEAPONS[activeWeapon.id].reloadSeconds);
      actionKind = 'reload';
      actionPose = evaluateReload(reloadProgress);
    }
    if (rig.swapTimer > 0) {
      actionKind = 'swap';
      actionPose = evaluateSwap(normalizedTimer(rig.swapTimer, 0.48));
    }
    if (rig.grenadeTimer > 0) {
      actionKind = 'grenade';
      actionPose = evaluateGrenade(normalizedTimer(rig.grenadeTimer, 0.65));
    }
    if (rig.meleeTimer > 0) {
      actionKind = 'melee';
      actionPose = evaluateMelee(normalizedTimer(rig.meleeTimer, 0.85));
    }

    const recoil = rig.recoil;
    rig.actionPivot.position.set(
      (actionKind === 'melee' ? -actionPose.part * 0.08 : 0) + rig.hitDirection * hitWeight * 0.025,
      breathing * 0.35 - actionPose.lower * (actionKind === 'swap' ? 0.38 : 0.14),
      actionKind === 'melee' ? -actionPose.part * 0.2 : recoil * 0.065,
    );
    rig.actionPivot.rotation.set(
      (actionKind === 'melee' ? -0.48 * actionPose.part : 0.15 * actionPose.lower)
        + (actionKind === 'grenade' ? -0.42 * actionPose.part : 0)
        + recoil * 0.1,
      (actionKind === 'melee' ? -0.72 : actionKind === 'grenade' ? 0.36 : -0.12) * actionPose.twist
        - recoil * 0.018,
      (actionKind === 'swap' ? 0.54 : actionKind === 'reload' ? 0.31 : 0.2) * actionPose.twist
        + recoil * 0.022,
    );
    rig.weaponMount.position.set(0.03, -0.13, -0.27);
    rig.weaponMount.rotation.set(0, 0, 0);
    this.applyRigArmAction(rig, actionKind, actionPose);

    this.resetAnimatedWeaponParts(rig.weaponParts);
    this.animateWeaponParts(
      rig.weaponParts,
      rig.weaponId,
      actionKind === 'reload' ? reloadProgress : 0,
      normalizedTimer(rig.fireTimer, 0.55),
      recoil,
    );

    rig.motionRoot.position.set(0, 0, 0);
    rig.motionRoot.rotation.set(0, 0, 0);
    rig.motionRoot.scale.set(1, 1, 1);
    if (rig.deathTimer > 0) {
      const deathProgress = smootherstep01(normalizedTimer(rig.deathTimer, 1.05));
      const fallSide = hashString(player.id) % 2 === 0 ? 1 : -1;
      rig.motionRoot.rotation.set(deathProgress * 0.2, 0, fallSide * deathProgress * 1.34);
      rig.motionRoot.position.y = -deathProgress * 0.34;
    } else if (rig.spawnTimer > 0 && player.alive) {
      const spawnProgress = smootherstep01(normalizedTimer(rig.spawnTimer, 0.62));
      rig.motionRoot.position.y = (1 - spawnProgress) * 0.18;
      rig.motionRoot.scale.set(0.88 + spawnProgress * 0.12, 0.76 + spawnProgress * 0.24, 0.88 + spawnProgress * 0.12);
    }

    rig.landingTimer = Math.max(0, rig.landingTimer - delta);
    rig.jumpTimer = Math.max(0, rig.jumpTimer - delta);
    rig.swapTimer = Math.max(0, rig.swapTimer - delta);
    rig.meleeTimer = Math.max(0, rig.meleeTimer - delta);
    rig.grenadeTimer = Math.max(0, rig.grenadeTimer - delta);
    rig.fireTimer = Math.max(0, rig.fireTimer - delta);
    rig.hitTimer = Math.max(0, rig.hitTimer - delta);
    rig.deathTimer = Math.max(0, rig.deathTimer - delta);
    rig.spawnTimer = Math.max(0, rig.spawnTimer - delta);
    rig.recoil = damp(rig.recoil, 0, 17, delta);
  }

  private applyRigArmAction(
    rig: PlayerRig,
    kind: 'none' | 'reload' | 'swap' | 'melee' | 'grenade',
    pose: ActionPoseWeights,
  ): void {
    rig.leftArm.quaternion.copy(rig.baseLeftArmQuaternion);
    rig.rightArm.quaternion.copy(rig.baseRightArmQuaternion);
    rig.leftForearm.quaternion.copy(rig.baseLeftForearmQuaternion);
    rig.rightForearm.quaternion.copy(rig.baseRightForearmQuaternion);
    const leftOffset = new THREE.Quaternion();
    const forearmOffset = new THREE.Quaternion();
    if (kind === 'reload') {
      leftOffset.setFromEuler(new THREE.Euler(0.16 * pose.hand, -0.34 * pose.hand, -0.48 * pose.hand));
      forearmOffset.setFromEuler(new THREE.Euler(0.24 * pose.hand, 0, 0.25 * pose.hand));
    } else if (kind === 'grenade') {
      leftOffset.setFromEuler(new THREE.Euler(-0.9 * pose.hand, -0.2 * pose.hand, -0.62 * pose.hand));
      forearmOffset.setFromEuler(new THREE.Euler(-0.55 * pose.hand, 0, 0.28 * pose.hand));
    } else if (kind === 'swap') {
      leftOffset.setFromEuler(new THREE.Euler(0.08 * pose.hand, 0, -0.16 * pose.hand));
    }
    rig.leftArm.quaternion.multiply(leftOffset);
    rig.leftForearm.quaternion.multiply(forearmOffset);
  }

  private animateWeaponParts(
    parts: AnimatedWeaponParts,
    weaponId: WeaponId | null,
    reloadProgress: number,
    fireProgress: number,
    recoil: number,
  ): void {
    const reloadPose = evaluateReload(reloadProgress);
    const magazine = parts.magazine;
    if (magazine) {
      magazine.object.position.y -= reloadPose.part * 0.38;
      magazine.object.position.x -= reloadPose.part * 0.06;
      magazine.object.quaternion.multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, reloadPose.part * 0.18)),
      );
    }
    const energyCell = parts['energy-cell'];
    if (energyCell) {
      energyCell.object.position.x += reloadPose.part * 0.22;
      energyCell.object.position.y -= reloadPose.part * 0.08;
      const pulse = 1 + recoil * 0.08;
      energyCell.object.scale.copy(energyCell.baseScale).multiplyScalar(pulse);
    }
    const cassette = parts['launcher-cassette'];
    if (cassette) {
      cassette.object.position.z += reloadPose.part * 0.42;
      cassette.object.rotation.x += reloadPose.part * 0.16;
    }

    if (!weaponId || fireProgress <= 0 || fireProgress >= 1) return;
    const slide = parts.slide;
    if (slide) slide.object.position.z += trianglePulse(fireProgress, 0, 0.1, 0.34) * 0.17;
    const bolt = parts.bolt;
    if (bolt) {
      const boltCycle = trianglePulse(
        fireProgress,
        weaponId === 'sniper' ? 0.16 : 0.02,
        weaponId === 'sniper' ? 0.44 : 0.13,
        weaponId === 'sniper' ? 0.9 : 0.38,
      );
      bolt.object.position.z += boltCycle * 0.24;
      bolt.object.rotation.x += boltCycle * 0.24;
    }
    const pump = parts.pump;
    if (pump) pump.object.position.z += trianglePulse(fireProgress, 0.12, 0.48, 0.92) * 0.34;
  }

  private syncObjectiveVisibility(state: MatchState): void {
    for (const decoration of this.worldDecorations) {
      if (typeof decoration.userData.teamBeacon === 'string') decoration.visible = state.config.mode === 'capture-the-flag';
      if (typeof decoration.userData.teamBeaconStructure === 'string') decoration.visible = state.config.mode === 'capture-the-flag';
      if (decoration.userData.towerRing) decoration.visible = state.config.mode === 'towah-of-powah';
    }
    this.towerTurret.visible = state.config.mode === 'towah-of-powah';
  }

  private createFriendlyMarker(name: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.shadowColor = 'rgba(0, 0, 0, 0.9)';
      context.shadowBlur = 8;
      context.fillStyle = '#e8f18b';
      context.beginPath();
      context.moveTo(128, 9);
      context.lineTo(154, 34);
      context.lineTo(141, 34);
      context.lineTo(128, 23);
      context.lineTo(115, 34);
      context.lineTo(102, 34);
      context.closePath();
      context.fill();
      context.shadowBlur = 5;
      context.font = '700 22px Rajdhani, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(name.toUpperCase().slice(0, 16), 128, 63, 224);
      context.fillStyle = 'rgba(232, 241, 139, 0.72)';
      context.fillRect(82, 82, 92, 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.ownedTextures.add(texture);
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0.96,
      toneMapped: false,
    }));
    marker.name = 'friendly-iff-marker';
    marker.userData.sharedEffectGeometry = true;
    marker.position.y = 2.55;
    marker.scale.set(2.25, 0.84, 1);
    marker.renderOrder = 900;
    marker.visible = false;
    return marker;
  }

  private createAstronaut(player: PlayerState): PlayerRig {
    const palette = TEAM_COLORS[player.team];
    const root = new THREE.Group();
    root.name = `astronaut-${player.id}`;
    root.position.set(player.position.x, player.position.y, player.position.z);
    root.rotation.y = player.yaw;
    const motionRoot = new THREE.Group();
    motionRoot.name = 'astronaut-motion-root';
    root.add(motionRoot);

    const armorMaterial = new THREE.MeshPhysicalMaterial({
      color: palette.armor,
      emissive: 0x000000,
      emissiveIntensity: 0,
      roughness: 0.32,
      metalness: 0.025,
      clearcoat: 0.56,
      clearcoatRoughness: 0.28,
      envMapIntensity: 1.18,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      emissive: palette.glow,
      emissiveIntensity: 0.3,
      roughness: 0.34,
      metalness: 0.16,
      envMapIntensity: 1.05,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x080d11,
      roughness: 0.8,
      metalness: 0.025,
      envMapIntensity: 0.45,
    });
    const technicalMaterial = new THREE.MeshStandardMaterial({
      color: 0x52636a,
      roughness: 0.27,
      metalness: 0.84,
      envMapIntensity: 1.25,
    });
    const visorMaterial = new THREE.MeshPhysicalMaterial({
      color: palette.accent,
      emissive: palette.glow,
      emissiveIntensity: 0.5,
      roughness: 0.07,
      metalness: 0.2,
      clearcoat: 1,
      clearcoatRoughness: 0.045,
      envMapIntensity: 2.1,
    });
    if (this.technicalNormalTexture) {
      armorMaterial.normalMap = this.technicalNormalTexture;
      armorMaterial.normalScale.set(0.13, 0.13);
      accentMaterial.normalMap = this.technicalNormalTexture;
      accentMaterial.normalScale.set(0.1, 0.1);
      jointMaterial.normalMap = this.technicalNormalTexture;
      jointMaterial.normalScale.set(0.07, 0.07);
      technicalMaterial.normalMap = this.technicalNormalTexture;
      technicalMaterial.normalScale.set(0.15, 0.15);
    }
    if (this.technicalRoughnessTexture) {
      armorMaterial.roughness = 0.58;
      armorMaterial.roughnessMap = this.technicalRoughnessTexture;
      accentMaterial.roughness = 0.62;
      accentMaterial.roughnessMap = this.technicalRoughnessTexture;
      technicalMaterial.roughness = 0.5;
      technicalMaterial.roughnessMap = this.technicalRoughnessTexture;
    }

    if (!this.contactShadowTexture) {
      this.contactShadowTexture = createRadialTexture({ size: 128, profile: 'shadow' });
      this.ownedTextures.add(this.contactShadowTexture);
    }
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.78),
      new THREE.MeshBasicMaterial({
        color: 0x061016,
        map: this.contactShadowTexture,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.set(0, 0.014, 0.04);
    root.add(contactShadow);

    const torso = new THREE.Group();
    torso.position.y = 0;
    motionRoot.add(torso);

    const pelvis = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.25, 0.38, 3, 0.075), armorMaterial);
    pelvis.position.y = 0.88;
    pelvis.castShadow = true;
    torso.add(pelvis);
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.245, 0.11, 10), technicalMaterial);
    belt.scale.z = 0.72;
    belt.position.y = 1.01;
    belt.castShadow = true;
    torso.add(belt);
    const abdomen = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.22, 4, 10), jointMaterial);
    abdomen.scale.z = 0.78;
    abdomen.position.y = 1.08;
    abdomen.castShadow = true;
    torso.add(abdomen);
    for (let band = 0; band < 3; band += 1) {
      const abdomenBand = new THREE.Mesh(
        new RoundedBoxGeometry(0.43 - band * 0.025, 0.055, 0.31, 2, 0.018),
        band === 1 ? technicalMaterial : armorMaterial,
      );
      abdomenBand.position.set(0, 1.035 + band * 0.075, -0.015 - band * 0.012);
      abdomenBand.castShadow = band !== 1;
      torso.add(abdomenBand);
    }

    const chest = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.46, 0.39, 3, 0.085), jointMaterial);
    chest.position.y = 1.3;
    chest.scale.set(1, 1, 0.96);
    chest.castShadow = true;
    torso.add(chest);

    for (const side of [-1, 1] as const) {
      const chestPlate = new THREE.Mesh(
        new RoundedBoxGeometry(0.3, 0.34, 0.105, 3, 0.032),
        armorMaterial,
      );
      chestPlate.position.set(side * 0.165, 1.33, -0.214);
      chestPlate.rotation.set(-0.06, side * 0.09, side * -0.045);
      chestPlate.castShadow = true;
      torso.add(chestPlate);

      const collarPlate = new THREE.Mesh(
        new RoundedBoxGeometry(0.22, 0.095, 0.115, 2, 0.025),
        armorMaterial,
      );
      collarPlate.position.set(side * 0.19, 1.515, -0.13);
      collarPlate.rotation.z = side * 0.14;
      collarPlate.castShadow = true;
      torso.add(collarPlate);
    }
    const sternum = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.28, 0.075, 2, 0.02), accentMaterial);
    sternum.position.set(0, 1.33, -0.276);
    torso.add(sternum);
    const chestInset = new THREE.Mesh(new RoundedBoxGeometry(0.23, 0.07, 0.045, 2, 0.016), jointMaterial);
    chestInset.position.set(0, 1.235, -0.292);
    torso.add(chestInset);
    for (const x of [-0.135, 0.135]) {
      const status = new THREE.Mesh(new RoundedBoxGeometry(0.065, 0.018, 0.018, 2, 0.006), accentMaterial);
      status.position.set(x, 1.225, -0.321);
      torso.add(status);
    }

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.055, 8, 20), technicalMaterial);
    collar.rotation.x = Math.PI / 2;
    collar.scale.z = 0.82;
    collar.position.y = 1.54;
    collar.castShadow = true;
    torso.add(collar);

    const backpack = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.58, 0.25, 3, 0.055), jointMaterial);
    backpack.position.set(0, 1.29, 0.32);
    backpack.castShadow = true;
    torso.add(backpack);
    for (const x of [-0.18, 0.18]) {
      const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.086, 0.39, 10), technicalMaterial);
      canister.position.set(x, 1.3, 0.46);
      canister.castShadow = true;
      torso.add(canister);
      const packShell = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.36, 0.12, 2, 0.028), armorMaterial);
      packShell.position.set(x, 1.36, 0.49);
      packShell.castShadow = true;
      torso.add(packShell);
      const packVent = new THREE.Mesh(new RoundedBoxGeometry(0.085, 0.13, 0.02, 2, 0.006), jointMaterial);
      packVent.position.set(x, 1.36, 0.558);
      torso.add(packVent);
      const thruster = new THREE.Mesh(new THREE.ConeGeometry(0.078, 0.14, 10, 1, true), accentMaterial);
      thruster.position.set(x, 1.06, 0.46);
      torso.add(thruster);
    }
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.015, 0.34, 6), technicalMaterial);
    antenna.position.set(0.19, 1.69, 0.38);
    antenna.rotation.z = -0.08;
    torso.add(antenna);
    const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 6), accentMaterial);
    antennaTip.position.set(0.205, 1.86, 0.38);
    torso.add(antennaTip);

    const head = new THREE.Group();
    // Match the simulation's head hit-volume (height * 0.86) closely.
    head.position.y = 1.63;
    torso.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.312, 20, 14), armorMaterial);
    helmet.scale.set(1.02, 1.03, 1.0);
    helmet.castShadow = true;
    head.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.268, 20, 12), visorMaterial);
    visor.scale.set(1.04, 0.62, 0.43);
    visor.position.set(0, 0.015, -0.277);
    head.add(visor);
    const crownShell = new THREE.Mesh(new RoundedBoxGeometry(0.46, 0.13, 0.35, 3, 0.04), armorMaterial);
    crownShell.position.set(0, 0.255, -0.01);
    crownShell.rotation.x = -0.04;
    crownShell.castShadow = true;
    head.add(crownShell);
    const brow = new THREE.Mesh(new RoundedBoxGeometry(0.49, 0.065, 0.08, 2, 0.02), technicalMaterial);
    brow.position.set(0, 0.205, -0.205);
    brow.rotation.x = -0.16;
    brow.castShadow = true;
    head.add(brow);
    const chin = new THREE.Mesh(new RoundedBoxGeometry(0.39, 0.12, 0.12, 3, 0.03), armorMaterial);
    chin.position.set(0, -0.225, -0.16);
    chin.rotation.x = 0.17;
    chin.castShadow = true;
    head.add(chin);
    for (const x of [-0.3, 0.3]) {
      const ear = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.22, 0.2, 2, 0.025), armorMaterial);
      ear.position.set(x, 0.005, 0.012);
      head.add(ear);
      const faceFrame = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.31, 0.07, 2, 0.018), technicalMaterial);
      faceFrame.position.set(x * 0.84, -0.005, -0.235);
      faceFrame.rotation.z = x < 0 ? -0.12 : 0.12;
      head.add(faceFrame);
    }
    const helmetLamp = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.075, 0.045, 2, 0.016), accentMaterial);
    helmetLamp.position.set(0.245, 0.205, -0.205);
    head.add(helmetLamp);
    const visorReflection = new THREE.Mesh(
      new RoundedBoxGeometry(0.08, 0.13, 0.008, 2, 0.004),
      new THREE.MeshBasicMaterial({ color: 0xc9f4ef, transparent: true, opacity: 0.24, depthWrite: false }),
    );
    visorReflection.position.set(-0.105, 0.065, -0.393);
    visorReflection.rotation.z = -0.22;
    head.add(visorReflection);

    const createArm = (side: number): THREE.Group => {
      const arm = new THREE.Group();
      arm.position.set(side * 0.42, 0.13, -0.01);
      const shoulder = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.24, 0.31, 3, 0.065), armorMaterial);
      shoulder.position.y = -0.04;
      shoulder.castShadow = true;
      arm.add(shoulder);
      const shoulderMark = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.035, 0.055, 2, 0.012), accentMaterial);
      shoulderMark.position.set(side * 0.09, -0.035, -0.168);
      arm.add(shoulderMark);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.23, 4, 9), jointMaterial);
      upper.position.y = -0.24;
      upper.castShadow = true;
      arm.add(upper);
      const bicepPlate = new THREE.Mesh(new RoundedBoxGeometry(0.18, 0.22, 0.11, 2, 0.025), armorMaterial);
      bicepPlate.position.set(side * 0.012, -0.245, -0.09);
      bicepPlate.castShadow = true;
      arm.add(bicepPlate);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), technicalMaterial);
      elbow.position.y = -0.43;
      elbow.castShadow = true;
      arm.add(elbow);
      const forearm = new THREE.Group();
      forearm.position.y = -0.43;
      arm.userData.forearm = forearm;
      arm.add(forearm);
      const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.2, 4, 9), jointMaterial);
      lower.position.y = -0.18;
      lower.castShadow = true;
      forearm.add(lower);
      const forearmPlate = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.27, 0.12, 2, 0.028), armorMaterial);
      forearmPlate.position.set(0, -0.18, -0.085);
      forearmPlate.castShadow = true;
      forearm.add(forearmPlate);
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.028, 7, 14), technicalMaterial);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = -0.33;
      forearm.add(cuff);
      const glove = new THREE.Mesh(new RoundedBoxGeometry(0.19, 0.17, 0.23, 3, 0.052), jointMaterial);
      glove.position.set(side * -0.015, -0.4, -0.035);
      glove.castShadow = true;
      forearm.add(glove);
      const knuckles = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.06, 0.15, 2, 0.02), technicalMaterial);
      knuckles.position.set(0, -0.43, -0.11);
      forearm.add(knuckles);
      return arm;
    };
    const leftArm = createArm(-1);
    const rightArm = createArm(1);
    const upperBodyAim = new THREE.Group();
    upperBodyAim.position.y = 1.3;
    torso.add(upperBodyAim);
    const actionPivot = new THREE.Group();
    actionPivot.name = 'astronaut-action-pivot';
    upperBodyAim.add(actionPivot);
    actionPivot.add(leftArm, rightArm);

    const createLeg = (side: number): { hip: THREE.Group; knee: THREE.Group; foot: THREE.Group } => {
      const hip = new THREE.Group();
      hip.position.set(side * 0.19, 1.075, 0);
      const hipPlate = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.22, 0.33, 3, 0.055), armorMaterial);
      hipPlate.position.set(side * 0.015, -0.06, 0);
      hipPlate.castShadow = true;
      hip.add(hipPlate);
      const hipMark = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.035, 0.11, 2, 0.01), accentMaterial);
      hipMark.position.set(side * 0.11, -0.04, -0.17);
      hip.add(hipMark);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.28, 4, 9), jointMaterial);
      thigh.position.y = -0.29;
      thigh.castShadow = true;
      hip.add(thigh);
      const thighPlate = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.3, 0.12, 2, 0.03), armorMaterial);
      thighPlate.position.set(side * 0.018, -0.28, -0.1);
      thighPlate.rotation.z = side * 0.035;
      thighPlate.castShadow = true;
      hip.add(thighPlate);

      const knee = new THREE.Group();
      knee.position.y = -0.52;
      hip.add(knee);
      const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 7), jointMaterial);
      kneeJoint.castShadow = true;
      knee.add(kneeJoint);
      const kneePlate = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.18, 0.13, 3, 0.042), armorMaterial);
      kneePlate.position.set(0, 0, -0.105);
      kneePlate.rotation.x = 0.18;
      kneePlate.castShadow = true;
      knee.add(kneePlate);
      const kneeMark = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.025, 0.025, 2, 0.007), accentMaterial);
      kneeMark.position.set(0, 0.02, -0.177);
      knee.add(kneeMark);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.26, 4, 9), jointMaterial);
      shin.position.y = -0.2;
      shin.castShadow = true;
      knee.add(shin);
      const shinPlate = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.27, 0.1, 3, 0.032), armorMaterial);
      shinPlate.position.set(0, -0.18, -0.105);
      knee.add(shinPlate);

      const foot = new THREE.Group();
      foot.position.y = -0.42;
      knee.add(foot);
      const boot = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.19, 0.42, 3, 0.055), jointMaterial);
      boot.position.set(0, 0, -0.075);
      boot.castShadow = true;
      foot.add(boot);
      const sole = new THREE.Mesh(new RoundedBoxGeometry(0.285, 0.06, 0.44, 2, 0.022), technicalMaterial);
      sole.position.set(0, -0.105, -0.075);
      foot.add(sole);
      return { hip, knee, foot };
    };
    const leftLegRig = createLeg(-1);
    const rightLegRig = createLeg(1);
    const leftLeg = leftLegRig.hip;
    const rightLeg = rightLegRig.hip;
    motionRoot.add(leftLeg, rightLeg);

    const weaponMount = new THREE.Group();
    weaponMount.position.set(0.03, -0.13, -0.27);
    actionPivot.add(weaponMount);

    const shieldMaterial = new THREE.MeshBasicMaterial({
      color: palette.glow,
      transparent: true,
      opacity: 0.18,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const shield = new THREE.Mesh(new THREE.SphereGeometry(0.78, 12, 8), shieldMaterial);
    shield.scale.set(0.82, 1.35, 0.82);
    shield.position.y = 0.92;
    shield.visible = false;
    motionRoot.add(shield);

    const juggernautRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.43, 0.045, 6, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffd47c,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    juggernautRing.position.y = 2.18;
    juggernautRing.rotation.x = Math.PI / 2;
    juggernautRing.visible = false;
    motionRoot.add(juggernautRing);

    const friendlyMarker = this.createFriendlyMarker(player.name);
    motionRoot.add(friendlyMarker);

    // Author body meshes in world-like coordinates for readability, then
    // shift the direct torso children once so all lean/breathing rotates from
    // the waist instead of from the astronaut's feet.
    for (const child of torso.children) child.position.y -= ASTRONAUT_WAIST_HEIGHT;
    torso.position.y = ASTRONAUT_WAIST_HEIGHT;

    const initial = vectorFrom(player.position);
    const leftForearm = leftArm.userData.forearm as THREE.Group;
    const rightForearm = rightArm.userData.forearm as THREE.Group;
    return {
      root,
      motionRoot,
      torso,
      upperBodyAim,
      actionPivot,
      head,
      leftArm,
      rightArm,
      leftForearm,
      rightForearm,
      leftLeg,
      rightLeg,
      leftKnee: leftLegRig.knee,
      rightKnee: rightLegRig.knee,
      leftFoot: leftLegRig.foot,
      rightFoot: rightLegRig.foot,
      weaponMount,
      weaponModel: null,
      weaponParts: {},
      contactShadow,
      shield,
      juggernautRing,
      friendlyMarker,
      armorMaterial,
      accentMaterial,
      visorMaterial,
      team: player.team,
      weaponId: null,
      previousPosition: initial.clone(),
      targetPosition: initial.clone(),
      previousYaw: player.yaw,
      targetYaw: player.yaw,
      lastTick: -1,
      locomotionPhase: (hashString(player.id) % 628) * 0.01,
      moveBlend: 0,
      groundBlend: player.grounded ? 1 : 0,
      forwardBlend: 0,
      strafeBlend: 0,
      previousGrounded: player.grounded,
      previousVerticalVelocity: player.velocity.y,
      previousMeleeCooldown: player.meleeCooldown,
      previousGrenadeCooldown: player.grenadeCooldown,
      previousAlive: player.alive,
      landingTimer: 0,
      landingStrength: 0,
      jumpTimer: 0,
      swapTimer: 0,
      meleeTimer: 0,
      grenadeTimer: 0,
      fireTimer: 0,
      hitTimer: 0,
      hitDirection: hashString(player.id) % 2 === 0 ? 1 : -1,
      deathTimer: 0,
      spawnTimer: player.alive ? 0.6 : 0,
      recoil: 0,
      baseLeftArmQuaternion: leftArm.quaternion.clone(),
      baseRightArmQuaternion: rightArm.quaternion.clone(),
      baseLeftForearmQuaternion: leftForearm.quaternion.clone(),
      baseRightForearmQuaternion: rightForearm.quaternion.clone(),
    };
  }

  private updateRigTeam(rig: PlayerRig, team: Team): void {
    const palette = TEAM_COLORS[team];
    rig.team = team;
    rig.armorMaterial.color.setHex(palette.armor);
    rig.accentMaterial.color.setHex(palette.accent);
    rig.accentMaterial.emissive.setHex(palette.glow);
    rig.visorMaterial.color.setHex(palette.accent);
    rig.visorMaterial.emissive.setHex(palette.glow);
    rig.shield.material.color.setHex(palette.glow);
  }

  private setRigWeapon(rig: PlayerRig, id: WeaponId | null): void {
    const hadWeapon = rig.weaponId !== null;
    rig.weaponMount.clear();
    rig.weaponMount.position.set(0.03, -0.13, -0.27);
    rig.weaponMount.rotation.set(0, 0, 0);
    rig.weaponId = id;
    rig.weaponModel = null;
    rig.weaponParts = {};
    rig.swapTimer = hadWeapon ? 0.48 : 0;
    if (!id) return;
    const model = this.getWeaponTemplate(id).clone(true);
    const worldScale = id === 'sidearm' ? 0.63 : id === 'rocket-launcher' ? 0.46 : id === 'sniper' ? 0.44 : 0.53;
    model.scale.setScalar(worldScale);
    model.rotation.set(-0.04, 0, 0);
    rig.weaponMount.add(model);
    rig.weaponModel = model;
    rig.weaponParts = this.collectAnimatedWeaponParts(model);
    this.poseRigHands(rig, model);
    rig.baseLeftArmQuaternion.copy(rig.leftArm.quaternion);
    rig.baseRightArmQuaternion.copy(rig.rightArm.quaternion);
    rig.baseLeftForearmQuaternion.copy(rig.leftForearm.quaternion);
    rig.baseRightForearmQuaternion.copy(rig.rightForearm.quaternion);
  }

  private collectAnimatedWeaponParts(model: THREE.Group): AnimatedWeaponParts {
    const parts: AnimatedWeaponParts = {};
    model.traverse((object) => {
      const role = object.userData.animationRole as WeaponAnimationRole | undefined;
      if (!role) return;
      parts[role] = {
        object,
        basePosition: object.position.clone(),
        baseQuaternion: object.quaternion.clone(),
        baseScale: object.scale.clone(),
      };
    });
    return parts;
  }

  private resetAnimatedWeaponParts(parts: AnimatedWeaponParts): void {
    for (const part of Object.values(parts)) {
      if (!part) continue;
      part.object.position.copy(part.basePosition);
      part.object.quaternion.copy(part.baseQuaternion);
      part.object.scale.copy(part.baseScale);
    }
  }

  private poseRigHands(rig: PlayerRig, weapon: THREE.Group): void {
    const primaryGrip = getWeaponAnchor(weapon, 'primaryGrip');
    const supportGrip = getWeaponAnchor(weapon, 'supportGrip');
    if (!primaryGrip) return;

    rig.root.updateMatrixWorld(true);
    const primaryWorld = weapon.localToWorld(vectorFrom(primaryGrip));
    const primaryTarget = rig.actionPivot.worldToLocal(primaryWorld.clone());
    const supportWorld = supportGrip
      ? weapon.localToWorld(vectorFrom(supportGrip))
      : primaryWorld.clone().add(new THREE.Vector3(-0.12, 0.04, -0.28));
    const supportTarget = rig.actionPivot.worldToLocal(supportWorld);
    this.solveArmPose(rig.rightArm, primaryTarget, 1);
    this.solveArmPose(rig.leftArm, supportTarget, -1);
    rig.root.updateMatrixWorld(true);
  }

  private solveArmPose(arm: THREE.Group, target: THREE.Vector3, side: -1 | 1): void {
    const forearm = arm.userData.forearm;
    if (!(forearm instanceof THREE.Group)) return;

    const shoulder = arm.position.clone();
    const toTarget = target.clone().sub(shoulder);
    const upperLength = 0.43;
    const lowerLength = 0.41;
    const distance = THREE.MathUtils.clamp(toTarget.length(), 0.12, upperLength + lowerLength - 0.008);
    const direction = toTarget.normalize();
    const reachableTarget = shoulder.clone().addScaledVector(direction, distance);
    const preferredBend = new THREE.Vector3(side * 0.82, -0.38, 0.2);
    preferredBend.addScaledVector(direction, -preferredBend.dot(direction));
    if (preferredBend.lengthSq() < 0.0001) preferredBend.set(side, 0, 0.2);
    preferredBend.normalize();

    const along = (upperLength * upperLength + distance * distance - lowerLength * lowerLength) / (2 * distance);
    const bendHeight = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    const elbow = shoulder.clone()
      .addScaledVector(direction, along)
      .addScaledVector(preferredBend, bendHeight);
    const upperDirection = elbow.clone().sub(shoulder).normalize();
    arm.quaternion.setFromUnitVectors(DOWN, upperDirection);

    const lowerDirection = reachableTarget.sub(elbow).normalize();
    const localLowerDirection = lowerDirection.applyQuaternion(arm.quaternion.clone().invert());
    forearm.quaternion.setFromUnitVectors(DOWN, localLowerDirection);
  }

  private getWeaponTemplate(id: WeaponId): THREE.Group {
    const cached = this.weaponTemplates.get(id);
    if (cached) return cached;
    const group = createWeaponModel(id);
    group.traverse((object) => {
      object.userData.sharedVisualTemplate = true;
      if (!(object instanceof THREE.Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial) || material.transparent) continue;
        if (!material.normalMap && this.technicalNormalTexture) {
          material.normalMap = this.technicalNormalTexture;
          material.normalScale.set(0.11, 0.11);
          material.needsUpdate = true;
        }
      }
    });
    this.weaponTemplates.set(id, group);
    return group;
  }

  private syncPickups(pickups: PickupState[], worldTime: number): void {
    const present = new Set<string>();
    for (const pickup of pickups) {
      present.add(pickup.id);
      let visual = this.pickupVisuals.get(pickup.id);
      if (!visual) {
        visual = this.createPickup(pickup);
        this.pickupVisuals.set(pickup.id, visual);
        this.scene.add(visual.root);
      }
      visual.root.visible = pickup.available;
      visual.root.position.set(
        pickup.position.x,
        visual.baseY,
        pickup.position.z,
      );
      visual.display.position.y = Math.sin(worldTime * 2.15 + visual.phase) * 0.13;
      visual.display.rotation.y = worldTime * 0.72 + visual.phase;
    }
    for (const [id, visual] of this.pickupVisuals) {
      if (!present.has(id)) visual.root.visible = false;
    }
  }

  private createPickup(pickup: PickupState): PickupVisual {
    const root = new THREE.Group();
    const display = new THREE.Group();
    root.add(display);
    const glowColor = pickup.weaponId ? WEAPONS[pickup.weaponId].tint : pickup.kind === 'overshield' ? 0x65f1e5 : 0x9ebfd2;
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.62, 0.16, 20),
      new THREE.MeshStandardMaterial({
        color: 0x102531,
        roughness: 0.38,
        metalness: 0.68,
        envMapIntensity: 1.05,
      }),
    );
    pedestal.position.y = -0.36;
    pedestal.castShadow = true;
    pedestal.receiveShadow = true;
    root.add(pedestal);
    const pedestalLight = new THREE.Mesh(
      new THREE.CylinderGeometry(0.37, 0.44, 0.055, 20),
      new THREE.MeshStandardMaterial({
        color: glowColor,
        emissive: glowColor,
        emissiveIntensity: 1.8,
        roughness: 0.22,
        metalness: 0.24,
      }),
    );
    pedestalLight.position.y = -0.25;
    root.add(pedestalLight);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.46, 0.025, 6, 20),
      new THREE.MeshBasicMaterial({
        color: glowColor,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = Math.PI / 2;
    display.add(ring);

    if (pickup.kind === 'weapon' && pickup.weaponId) {
      const weapon = this.getWeaponTemplate(pickup.weaponId).clone(true);
      const pickupScale = pickup.weaponId === 'sidearm' ? 0.44 : pickup.weaponId === 'rocket-launcher' ? 0.3 : 0.34;
      weapon.scale.setScalar(pickupScale);
      weapon.rotation.z = 0.18;
      weapon.position.y = 0.17;
      display.add(weapon);
    } else if (pickup.kind === 'overshield') {
      const core = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.29, 1),
        new THREE.MeshStandardMaterial({
          color: 0x70efe4,
          emissive: 0x36dccc,
          emissiveIntensity: 1.8,
          roughness: 0.18,
          metalness: 0.22,
        }),
      );
      core.position.y = 0.18;
      display.add(core);
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.42, 1),
        new THREE.MeshBasicMaterial({ color: 0x9ffff3, wireframe: true, transparent: true, opacity: 0.4 }),
      );
      shell.position.y = 0.18;
      display.add(shell);
    } else if (pickup.kind === 'grenade') {
      const grenade = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.25, 1),
        new THREE.MeshStandardMaterial({ color: 0x466d6f, roughness: 0.54, metalness: 0.42 }),
      );
      grenade.position.y = 0.16;
      display.add(grenade);
      const cap = new THREE.Mesh(
        new THREE.TorusGeometry(0.1, 0.025, 5, 10),
        new THREE.MeshStandardMaterial({ color: 0xb3ded5, metalness: 0.6, roughness: 0.3 }),
      );
      cap.position.y = 0.43;
      cap.rotation.x = Math.PI / 2;
      display.add(cap);
    } else {
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.34, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x395461, roughness: 0.58, metalness: 0.38 }),
      );
      crate.position.y = 0.12;
      display.add(crate);
      for (const x of [-0.18, 0, 0.18]) {
        const cell = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.19, 0.45),
          new THREE.MeshStandardMaterial({ color: 0x8dc5c7, emissive: 0x416c76, emissiveIntensity: 0.6 }),
        );
        cell.position.set(x, 0.14, -0.02);
        display.add(cell);
      }
    }

    root.traverse((object) => {
      if (object instanceof THREE.Mesh && !(object.material instanceof THREE.MeshBasicMaterial)) object.castShadow = true;
    });
    root.position.set(pickup.position.x, pickup.position.y, pickup.position.z);
    return { root, display, baseY: pickup.position.y, phase: (hashString(pickup.id) % 628) / 100 };
  }

  private syncFlags(flags: FlagState[], state: MatchState, worldTime: number): void {
    const present = new Set<FlagState['team']>();
    for (const flag of flags) {
      present.add(flag.team);
      let visual = this.flagVisuals.get(flag.team);
      if (!visual) {
        visual = this.createFlag(flag.team);
        this.flagVisuals.set(flag.team, visual);
        this.scene.add(visual);
      }
      const carrier = flag.carrierId ? state.players[flag.carrierId] : undefined;
      const position = carrier?.position ?? flag.position;
      visual.position.set(position.x, position.y + (carrier ? 0.72 : 0.02), position.z);
      visual.rotation.y = carrier ? carrier.yaw + Math.PI : Math.sin(worldTime * 0.45) * 0.14;
      visual.scale.setScalar(carrier ? 0.72 : 1);
      visual.visible = true;
      const cloth = visual.userData.cloth as THREE.Mesh | undefined;
      if (cloth) cloth.rotation.y = Math.sin(worldTime * 3.1 + (flag.team === 'aurora' ? 0 : 1.7)) * 0.08;
    }
    for (const [team, visual] of this.flagVisuals) {
      if (!present.has(team)) visual.visible = false;
    }
  }

  private createFlag(team: FlagState['team']): THREE.Group {
    const palette = TEAM_COLORS[team];
    const root = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.05, 2.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xb3cad0, roughness: 0.35, metalness: 0.72 }),
    );
    pole.position.y = 1.1;
    pole.castShadow = true;
    root.add(pole);

    const clothGeometry = new THREE.BufferGeometry();
    clothGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 2.04, 0, 1.15, 1.9, 0, 0, 1.28, 0, 1.15, 1.9, 0, 1.02, 1.36, 0, 0, 1.28, 0], 3),
    );
    clothGeometry.computeVertexNormals();
    const cloth = new THREE.Mesh(
      clothGeometry,
      new THREE.MeshStandardMaterial({
        color: palette.armor,
        emissive: palette.glow,
        emissiveIntensity: 0.34,
        roughness: 0.62,
        side: THREE.DoubleSide,
      }),
    );
    cloth.castShadow = true;
    root.userData.cloth = cloth;
    root.add(cloth);
    const finial = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.12),
      new THREE.MeshStandardMaterial({ color: palette.accent, emissive: palette.glow, emissiveIntensity: 0.9 }),
    );
    finial.position.y = 2.18;
    root.add(finial);
    return root;
  }

  private syncProjectiles(projectiles: ProjectileState[], worldTime: number): void {
    const active = new Set<string>();
    for (const projectile of projectiles) {
      if (!projectile.alive) continue;
      active.add(projectile.id);
      let visual = this.projectileVisuals.get(projectile.id);
      if (!visual) {
        visual = this.createProjectile(projectile);
        this.projectileVisuals.set(projectile.id, visual);
        this.scene.add(visual.root);
      }
      visual.root.position.set(projectile.position.x, projectile.position.y, projectile.position.z);
      if (projectile.kind === 'rocket') {
        const velocity = vectorFrom(projectile.velocity);
        if (velocity.lengthSq() > 0.001) visual.root.quaternion.setFromUnitVectors(UP, velocity.normalize());
        const flame = visual.root.userData.flame as THREE.Mesh | undefined;
        if (flame) flame.scale.y = 0.72 + Math.sin(worldTime * 45) * 0.18;
      } else {
        visual.root.rotation.x += 0.08;
        visual.root.rotation.z += 0.11;
      }
    }

    for (const [id, visual] of this.projectileVisuals) {
      if (active.has(id)) continue;
      this.scene.remove(visual.root);
      disposeObject(visual.root);
      this.projectileVisuals.delete(id);
    }
  }

  private createProjectile(projectile: ProjectileState): ProjectileVisual {
    const root = new THREE.Group();
    if (projectile.kind === 'rocket') {
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.14, 0.65, 9),
        new THREE.MeshStandardMaterial({ color: 0x304550, roughness: 0.4, metalness: 0.62 }),
      );
      root.add(body);
      const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.11, 0.25, 9),
        new THREE.MeshStandardMaterial({ color: TEAM_COLORS[projectile.team].accent, roughness: 0.42, metalness: 0.4 }),
      );
      nose.position.y = 0.44;
      root.add(nose);
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.1, 0.52, 7),
        new THREE.MeshBasicMaterial({
          color: 0xff8c72,
          transparent: true,
          opacity: 0.82,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      flame.rotation.z = Math.PI;
      flame.position.y = -0.56;
      root.userData.flame = flame;
      root.add(flame);
    } else {
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(projectile.radius, 1),
        new THREE.MeshStandardMaterial({
          color: 0x3d686a,
          emissive: TEAM_COLORS[projectile.team].glow,
          emissiveIntensity: 0.55,
          roughness: 0.48,
          metalness: 0.48,
        }),
      );
      root.add(shell);
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(projectile.radius * 0.76, projectile.radius * 0.12, 5, 12),
        new THREE.MeshBasicMaterial({ color: TEAM_COLORS[projectile.team].glow }),
      );
      root.add(band);
    }
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });
    return { root, kind: projectile.kind };
  }

  private syncTower(state: MatchState, worldTime: number): void {
    const palette = TEAM_COLORS[state.tower.controllingTeam];
    this.towerRingMaterial.color.setHex(palette.glow);
    this.towerRingMaterial.opacity = state.tower.controllingTeam === 'neutral'
      ? 0.32 + Math.sin(worldTime * 2) * 0.06
      : 0.58 + Math.sin(worldTime * 4) * 0.1;
    this.towerTurret.rotation.y = state.tower.turretYaw;
    this.towerTurretPitch.rotation.x = state.tower.turretPitch;
  }

  private consumeEvents(state: MatchState): void {
    if (!this.eventsInitialized) {
      this.lastEventId = state.eventSequence;
      this.eventsInitialized = true;
      return;
    }

    for (const event of state.events) {
      if (event.id <= this.lastEventId) continue;
      this.createEventEffect(event, state);
      this.lastEventId = Math.max(this.lastEventId, event.id);
    }
    this.lastEventId = Math.max(this.lastEventId, state.eventSequence);
  }

  private createEventEffect(event: GameEvent, state: MatchState): void {
    if (
      event.targetId
      && (event.type === 'hit' || event.type === 'shield-break' || event.type === 'melee')
    ) {
      const targetRig = this.playerRigs.get(event.targetId);
      const target = state.players[event.targetId];
      const actor = event.actorId ? state.players[event.actorId] : undefined;
      if (targetRig) {
        targetRig.hitTimer = 0.24;
        if (target && actor) {
          const toActorX = actor.position.x - target.position.x;
          const toActorZ = actor.position.z - target.position.z;
          const rightX = Math.cos(target.yaw);
          const rightZ = -Math.sin(target.yaw);
          targetRig.hitDirection = toActorX * rightX + toActorZ * rightZ >= 0 ? 1 : -1;
        }
      }
    }

    if (
      event.targetId === this.localPlayerId
      && (event.type === 'hit' || event.type === 'shield-break' || event.type === 'melee')
    ) {
      this.damagePulse = 1;
    }

    if (event.type === 'shot' && event.actorId) {
      const actor = state.players[event.actorId];
      if (!actor) return;
      const turretShot = event.message === 'Torreta';
      const origin = new THREE.Vector3(actor.position.x, actor.position.y + actor.height * 0.76, actor.position.z);
      const actorRig = this.playerRigs.get(event.actorId);
      const modelMuzzle = actorRig?.weaponModel
        ? getWeaponAnchor(actorRig.weaponModel, 'muzzle')
        : null;
      if (turretShot) {
        this.towerTurret.updateWorldMatrix(true, false);
        const muzzle = this.towerTurretMuzzles[event.id % this.towerTurretMuzzles.length];
        if (muzzle) muzzle.getWorldPosition(origin);
      } else if (actorRig?.weaponModel && modelMuzzle) {
        actorRig.weaponModel.updateWorldMatrix(true, false);
        origin.copy(actorRig.weaponModel.localToWorld(modelMuzzle));
      }
      const actorDirection = new THREE.Vector3(
        -Math.sin(actor.yaw) * Math.cos(actor.pitch),
        Math.sin(actor.pitch),
        -Math.cos(actor.yaw) * Math.cos(actor.pitch),
      );
      const candidateEnds = event.traces?.map((trace) => vectorFrom(trace))
        ?? [event.position ? vectorFrom(event.position) : origin.clone().addScaledVector(actorDirection, 18)];
      const ends = candidateEnds.map((candidate) => candidate.distanceToSquared(origin) < 0.8
        ? origin.clone().addScaledVector(actorDirection, 18)
        : candidate);
      const end = ends[0] ?? origin.clone().addScaledVector(actorDirection, 18);
      const direction = turretShot
        ? end.clone().sub(origin).normalize()
        : actorDirection;
      const tracePoints = ends.flatMap((endpoint) => [origin, endpoint]);
      const geometry = new THREE.BufferGeometry().setFromPoints(tracePoints);
      const tint = event.weaponId ? WEAPONS[event.weaponId].tint : TEAM_COLORS[actor.team].glow;
      const material = new THREE.LineBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0.32,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.LineSegments(geometry, material);
      const effect = new THREE.Group();
      effect.add(line);
      const coreMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 0.64),
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const coreLine = new THREE.LineSegments(geometry.clone(), coreMaterial);
      coreLine.scale.set(1, 1, 1);
      effect.add(coreLine);
      const flashMaterial = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const flash = new THREE.Mesh(this.shotFlashGeometry, flashMaterial);
      flash.userData.sharedEffectGeometry = true;
      flash.position.copy(origin).addScaledVector(direction, 0.48);
      flash.scale.set(0.115 * 0.72, 0.115 * 0.72, 0.115 * 1.9);
      flash.quaternion.setFromUnitVectors(FORWARD, direction);
      effect.add(flash);
      const heavyShot = event.weaponId === 'shotgun'
        || event.weaponId === 'sniper'
        || event.weaponId === 'rocket-launcher';
      const flameLength = heavyShot ? 0.92 : event.weaponId === 'sidearm' ? 0.48 : 0.62;
      const outerFlameMaterial = new THREE.MeshBasicMaterial({
        color: 0xff793d,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const outerFlame = new THREE.Mesh(
        this.muzzleConeGeometry,
        outerFlameMaterial,
      );
      outerFlame.userData.sharedEffectGeometry = true;
      const outerFlameRadius = heavyShot ? 0.19 : 0.13;
      outerFlame.scale.set(outerFlameRadius, flameLength, outerFlameRadius);
      outerFlame.quaternion.setFromUnitVectors(UP, direction);
      outerFlame.position.copy(origin).addScaledVector(direction, flameLength * 0.52 + 0.14);
      effect.add(outerFlame);
      const innerFlameMaterial = new THREE.MeshBasicMaterial({
        color: 0xfff2c4,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const innerFlame = new THREE.Mesh(
        this.muzzleConeGeometry,
        innerFlameMaterial,
      );
      innerFlame.userData.sharedEffectGeometry = true;
      const innerFlameRadius = heavyShot ? 0.09 : 0.065;
      const innerFlameLength = flameLength * 0.68;
      innerFlame.scale.set(innerFlameRadius, innerFlameLength, innerFlameRadius);
      innerFlame.quaternion.copy(outerFlame.quaternion);
      innerFlame.position.copy(origin).addScaledVector(direction, flameLength * 0.37 + 0.1);
      effect.add(innerFlame);
      const smokeMaterial = new THREE.MeshBasicMaterial({
        color: 0x8ea1a0,
        transparent: true,
        opacity: heavyShot ? 0.2 : 0.11,
        depthWrite: false,
      });
      const muzzleSmoke = new THREE.Mesh(this.shotSmokeGeometry, smokeMaterial);
      muzzleSmoke.userData.sharedEffectGeometry = true;
      muzzleSmoke.scale.setScalar(0.1);
      muzzleSmoke.position.copy(origin).addScaledVector(direction, 0.34);
      effect.add(muzzleSmoke);

      const reachedSurface = event.impact === true;
      let impactMaterial: THREE.PointsMaterial | null = null;
      let impactPositions: THREE.BufferAttribute | null = null;
      let impactVelocities: THREE.Vector3[] = [];
      let impactGlowMaterial: THREE.MeshBasicMaterial | null = null;
      if (reachedSurface && event.weaponId !== 'rocket-launcher') {
        const sparkRandom = seededRandom(event.id * 0x9e3779b1);
        const sparkCount = event.weaponId === 'shotgun' ? 15 : 9;
        const sparkValues = new Float32Array(sparkCount * 3);
        impactVelocities = [];
        for (let index = 0; index < sparkCount; index += 1) {
          sparkValues[index * 3] = end.x;
          sparkValues[index * 3 + 1] = end.y;
          sparkValues[index * 3 + 2] = end.z;
          impactVelocities.push(new THREE.Vector3(
            (sparkRandom() - 0.5) * 4.2 - direction.x * 1.6,
            0.8 + sparkRandom() * 3.2 - direction.y,
            (sparkRandom() - 0.5) * 4.2 - direction.z * 1.6,
          ));
        }
        const sparkGeometry = new THREE.BufferGeometry();
        impactPositions = new THREE.BufferAttribute(sparkValues, 3);
        sparkGeometry.setAttribute('position', impactPositions);
        impactMaterial = new THREE.PointsMaterial({
          color: 0xffd08a,
          size: event.weaponId === 'shotgun' ? 0.075 : 0.055,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        });
        effect.add(new THREE.Points(sparkGeometry, impactMaterial));
        impactGlowMaterial = new THREE.MeshBasicMaterial({
          color: 0xffb56d,
          transparent: true,
          opacity: 0.76,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        });
        const impactGlow = new THREE.Mesh(this.shotSmokeGeometry, impactGlowMaterial);
        impactGlow.userData.sharedEffectGeometry = true;
        impactGlow.scale.setScalar(0.08);
        impactGlow.position.copy(end);
        effect.add(impactGlow);
      }
      this.scene.add(effect);
      this.effects.push({
        object: effect,
        age: 0,
        duration: heavyShot ? 0.16 : 0.115,
        update: (progress) => {
          material.opacity = (1 - progress) * 0.32;
          coreMaterial.opacity = (1 - progress) * 0.96;
          flashMaterial.opacity = (1 - progress) * 0.95;
          outerFlameMaterial.opacity = (1 - progress) * 0.82;
          innerFlameMaterial.opacity = (1 - progress) * (1 - progress);
          smokeMaterial.opacity = (1 - progress) * (heavyShot ? 0.2 : 0.11);
          flash.scale.multiplyScalar(0.93);
          outerFlame.scale.set(
            outerFlameRadius * (1 - progress * 0.42),
            flameLength * (1 - progress * 0.72),
            outerFlameRadius * (1 - progress * 0.42),
          );
          innerFlame.scale.set(
            innerFlameRadius * (1 - progress * 0.58),
            innerFlameLength * (1 - progress * 0.58),
            innerFlameRadius * (1 - progress * 0.58),
          );
          muzzleSmoke.scale.setScalar(0.1 * (0.7 + progress * (heavyShot ? 5.2 : 3.2)));
          muzzleSmoke.position.y += 0.0035;
          if (impactMaterial && impactPositions) {
            impactMaterial.opacity = (1 - progress) * 0.95;
            for (let index = 0; index < impactVelocities.length; index += 1) {
              const velocity = impactVelocities[index]!;
              impactPositions.setXYZ(
                index,
                end.x + velocity.x * progress * 0.18,
                end.y + velocity.y * progress * 0.18 - progress * progress * 0.22,
                end.z + velocity.z * progress * 0.18,
              );
            }
            impactPositions.needsUpdate = true;
          }
          if (impactGlowMaterial) impactGlowMaterial.opacity = (1 - progress) * 0.76;
        },
      });
      if (event.message !== 'Torreta') {
        const rig = this.playerRigs.get(event.actorId);
        if (rig) {
          const recoilStrength = event.weaponId === 'rocket-launcher'
            ? 1.35
            : event.weaponId === 'sniper' || event.weaponId === 'shotgun'
              ? 1.15
              : event.weaponId === 'sidearm'
                ? 0.82
                : 0.68;
          rig.recoil = Math.min(1.5, rig.recoil + recoilStrength);
          rig.fireTimer = 0.55;
        }
        if (event.actorId === this.localPlayerId) {
          this.weaponKick = 1;
          const viewMuzzle = this.viewWeaponModel
            ? getWeaponAnchor(this.viewWeaponModel, 'muzzle')
            : null;
          if (this.viewWeaponModel && viewMuzzle) {
            const localFlash = new THREE.Group();
            localFlash.position.copy(viewMuzzle);
            const localFlashMaterial = new THREE.MeshBasicMaterial({
              color: new THREE.Color(tint).lerp(new THREE.Color(0xffffff), 0.42),
              transparent: true,
              opacity: 1,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            });
            const localCore = new THREE.Mesh(this.shotFlashGeometry, localFlashMaterial);
            localCore.userData.sharedEffectGeometry = true;
            localCore.scale.set(0.13 * 0.9, 0.13 * 0.9, 0.13 * 2.3);
            localFlash.add(localCore);
            const localFlameMaterial = new THREE.MeshBasicMaterial({
              color: 0xff8a45,
              transparent: true,
              opacity: 0.95,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
              side: THREE.DoubleSide,
            });
            const localFlame = new THREE.Mesh(
              this.muzzleConeGeometry,
              localFlameMaterial,
            );
            localFlame.userData.sharedEffectGeometry = true;
            const localFlameRadius = heavyShot ? 0.12 : 0.085;
            const localFlameLength = flameLength * 0.82;
            localFlame.scale.set(localFlameRadius, localFlameLength, localFlameRadius);
            localFlame.quaternion.setFromUnitVectors(UP, FORWARD);
            localFlame.position.z = -flameLength * 0.38;
            localFlash.add(localFlame);
            const localSmokeMaterial = new THREE.MeshBasicMaterial({
              color: 0xa7b3af,
              transparent: true,
              opacity: heavyShot ? 0.18 : 0.08,
              depthWrite: false,
            });
            const localSmoke = new THREE.Mesh(this.shotSmokeGeometry, localSmokeMaterial);
            localSmoke.userData.sharedEffectGeometry = true;
            localSmoke.scale.setScalar(0.07);
            localSmoke.position.z = -0.16;
            localFlash.add(localSmoke);
            this.viewWeaponModel.add(localFlash);
            this.effects.push({
              object: localFlash,
              age: 0,
              duration: 0.072,
              update: (progress) => {
                localFlashMaterial.opacity = 1 - progress;
                localFlameMaterial.opacity = (1 - progress) * 0.95;
                localSmokeMaterial.opacity = (1 - progress) * (heavyShot ? 0.18 : 0.08);
                localCore.scale.multiplyScalar(0.92);
                localFlame.scale.set(
                  localFlameRadius * (1 - progress * 0.45),
                  localFlameLength * (1 - progress * 0.7),
                  localFlameRadius * (1 - progress * 0.45),
                );
                localSmoke.scale.setScalar(0.07 * (0.75 + progress * (heavyShot ? 4.8 : 2.8)));
                localSmoke.position.y += 0.0025;
              },
            });
          }
        }
      }
      return;
    }

    if (event.type === 'explosion') {
      const position = event.position ?? (event.targetId ? state.players[event.targetId]?.position : undefined);
      if (!position) return;
      const blast = new THREE.Group();
      blast.name = `explosion-${event.id}`;
      blast.position.set(position.x, position.y, position.z);
      const random = seededRandom(event.id * 0x85ebca6b);
      const coreMaterial = new THREE.MeshBasicMaterial({
        color: 0xfff5d4,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const core = new THREE.Mesh(this.shotFlashGeometry, coreMaterial);
      core.userData.sharedEffectGeometry = true;
      blast.add(core);
      const fireballMaterial = new THREE.MeshBasicMaterial({
        color: 0xff7538,
        transparent: true,
        opacity: 0.68,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const fireball = new THREE.Mesh(this.explosionShellGeometry, fireballMaterial);
      fireball.userData.sharedEffectGeometry = true;
      fireball.scale.set(1.08, 0.86, 0.94);
      blast.add(fireball);
      const shockMaterial = new THREE.MeshBasicMaterial({
        color: 0xffbd87,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shock = new THREE.Mesh(this.explosionShockGeometry, shockMaterial);
      shock.userData.sharedEffectGeometry = true;
      shock.rotation.x = Math.PI / 2;
      shock.position.y = 0.045;
      blast.add(shock);

      const groundFlashMaterial = new THREE.MeshBasicMaterial({
        color: 0xff9b5d,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const groundFlash = new THREE.Mesh(this.explosionGroundFlashGeometry, groundFlashMaterial);
      groundFlash.userData.sharedEffectGeometry = true;
      groundFlash.rotation.x = -Math.PI / 2;
      groundFlash.position.y = 0.025;
      blast.add(groundFlash);

      const smokeMaterial = new THREE.MeshStandardMaterial({
        color: 0x30383a,
        emissive: 0x7a3721,
        emissiveIntensity: 0.18,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const smokeCount = 7;
      const smoke = new THREE.InstancedMesh(this.shotSmokeGeometry, smokeMaterial, smokeCount);
      smoke.name = 'explosion-smoke';
      smoke.userData.sharedEffectGeometry = true;
      smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      const smokePuffs = Array.from({ length: smokeCount }, (_, index) => ({
        x: (random() - 0.5) * 0.78,
        y: 0.08 + random() * 0.65,
        z: (random() - 0.5) * 0.78,
        size: 0.72 + random() * 0.62,
        rise: 0.72 + random() * 1.18,
        phase: random() * Math.PI * 2 + index,
      }));
      const smokeTransform = new THREE.Object3D();
      blast.add(smoke);

      const sparkCount = 34;
      const sparkValues = new Float32Array(sparkCount * 3);
      const sparkVelocities = Array.from({ length: sparkCount }, () => {
        const azimuth = random() * Math.PI * 2;
        const elevation = 0.18 + random() * 0.76;
        const speed = 5.2 + random() * 8.5;
        return new THREE.Vector3(
          Math.cos(azimuth) * Math.cos(elevation) * speed,
          Math.sin(elevation) * speed,
          Math.sin(azimuth) * Math.cos(elevation) * speed,
        );
      });
      const sparkGeometry = new THREE.BufferGeometry();
      const sparkPositions = new THREE.BufferAttribute(sparkValues, 3);
      sparkGeometry.setAttribute('position', sparkPositions);
      const sparkMaterial = new THREE.PointsMaterial({
        color: 0xffc36b,
        size: 0.095,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.96,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      blast.add(new THREE.Points(sparkGeometry, sparkMaterial));

      // Dynamic point lights are deliberately budgeted: simultaneous grenade
      // spam still produces fireballs and particles without multiplying the
      // forward-rendering cost on integrated GPUs.
      const activeExplosionLights = this.effects.reduce(
        (count, effect) => count + (effect.object.userData.explosionLight ? 1 : 0),
        0,
      );
      const light = activeExplosionLights < 3
        ? new THREE.PointLight(0xffa05f, 0, 15, 2)
        : null;
      if (light) {
        light.position.y = 0.45;
        blast.add(light);
        blast.userData.explosionLight = true;
      }

      const localPlayer = this.localPlayerId ? state.players[this.localPlayerId] : undefined;
      if (localPlayer) {
        const distance = Math.hypot(
          localPlayer.position.x - position.x,
          localPlayer.position.y - position.y,
          localPlayer.position.z - position.z,
        );
        this.weaponKick = Math.max(this.weaponKick, clamp01(1 - distance / 15) * 0.9);
      }
      this.scene.add(blast);
      this.effects.push({
        object: blast,
        age: 0,
        duration: 1.08,
        update: (progress) => {
          const profile = evaluateExplosionVisual(progress);
          core.scale.setScalar(profile.coreScale);
          coreMaterial.opacity = profile.coreOpacity;
          fireball.scale.set(
            profile.fireballScale * 1.08,
            profile.fireballScale * 0.86,
            profile.fireballScale * 0.94,
          );
          fireball.rotation.set(progress * 0.72, progress * 1.18, progress * -0.48);
          fireballMaterial.opacity = profile.fireballOpacity;
          shock.scale.setScalar(profile.shockScale);
          shockMaterial.opacity = profile.shockOpacity;
          groundFlash.scale.setScalar(profile.shockScale * 0.78);
          groundFlashMaterial.opacity = profile.shockOpacity * 0.64;
          smokeMaterial.opacity = profile.smokeOpacity;
          smokeMaterial.emissiveIntensity = Math.max(0, 0.22 - progress * 0.32);
          smokePuffs.forEach((puff, index) => {
            const spread = 1 + progress * 2.15;
            const size = profile.smokeScale * puff.size * (0.62 + index * 0.035);
            smokeTransform.position.set(
              puff.x * spread + Math.sin(puff.phase + progress * 2.4) * progress * 0.16,
              puff.y + progress * puff.rise,
              puff.z * spread + Math.cos(puff.phase + progress * 2.1) * progress * 0.16,
            );
            smokeTransform.rotation.set(progress * 0.7 + puff.phase, puff.phase, -progress * 0.46);
            smokeTransform.scale.set(size * 1.08, size * 0.84, size);
            smokeTransform.updateMatrix();
            smoke.setMatrixAt(index, smokeTransform.matrix);
          });
          smoke.instanceMatrix.needsUpdate = true;

          const elapsed = progress * 1.08;
          for (let index = 0; index < sparkVelocities.length; index += 1) {
            const velocity = sparkVelocities[index]!;
            sparkPositions.setXYZ(
              index,
              velocity.x * elapsed,
              velocity.y * elapsed - 4.9 * elapsed * elapsed,
              velocity.z * elapsed,
            );
          }
          sparkPositions.needsUpdate = true;
          sparkMaterial.opacity = profile.sparkOpacity;
          if (light) light.intensity = profile.lightIntensity;
        },
      });
      return;
    }

    if (event.type === 'hit' || event.type === 'shield-break' || event.type === 'melee') {
      const position = event.position ?? (event.targetId ? state.players[event.targetId]?.position : undefined);
      if (!position) return;
      const opacity = { value: 0.68 };
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(event.type === 'shield-break' ? 0x73f4ee : 0xe4b3d8) },
          uOpacity: opacity,
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vView;
          void main() {
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vView = normalize(-viewPosition.xyz);
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vNormal;
          varying vec3 vView;
          uniform vec3 uColor;
          uniform float uOpacity;
          void main() {
            float fresnel = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.35);
            float alpha = (0.08 + fresnel * 0.92) * uOpacity;
            gl_FragColor = vec4(uColor * (0.58 + fresnel * 0.72), alpha);
          }
        `,
      });
      const ripple = new THREE.Mesh(new THREE.SphereGeometry(0.48, 18, 12), material);
      const verticalOffset = event.type === 'hit' ? 0 : 0.9;
      ripple.position.set(position.x, position.y + verticalOffset, position.z);
      this.scene.add(ripple);
      this.effects.push({
        object: ripple,
        age: 0,
        duration: 0.24,
        update: (progress) => {
          ripple.scale.setScalar(0.6 + progress * 1.8);
          opacity.value = (1 - progress) * 0.68;
        },
      });
    }
  }

  private updateEffects(delta: number): void {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      if (!effect) continue;
      effect.age += delta;
      const progress = clamp01(effect.age / effect.duration);
      effect.update(progress);
      if (progress < 1) continue;
      effect.object.removeFromParent();
      disposeObject(effect.object);
      this.effects.splice(index, 1);
    }
  }

  private updateDecorations(worldTime: number): void {
    for (const decoration of this.worldDecorations) {
      if (typeof decoration.userData.swayPhase === 'number') {
        const strength = Number(decoration.userData.swayStrength ?? (decoration.userData.energyBeam ? 0 : 0.018));
        decoration.rotation.z = Math.sin(worldTime * 0.7 + decoration.userData.swayPhase) * strength;
      }
      if (typeof decoration.userData.spin === 'number') {
        decoration.rotation.z = worldTime * decoration.userData.spin * 0.36;
        const material = (decoration as unknown as THREE.Mesh).material;
        if (material instanceof THREE.MeshBasicMaterial) material.opacity = 0.58 + Math.sin(worldTime * 4) * 0.12;
      }
      if (typeof decoration.userData.teamBeacon === 'string') {
        decoration.rotation.z = worldTime * (decoration.userData.teamBeacon === 'aurora' ? 0.08 : -0.08);
      }
      if (decoration.userData.towerRing) decoration.rotation.z = worldTime * 0.035;
      if (decoration.userData.energyBeam) {
        const material = (decoration as unknown as THREE.Mesh).material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.opacity = 0.045 + Math.sin(worldTime * 2.8 + decoration.userData.swayPhase) * 0.014;
        }
        decoration.scale.setScalar(0.96 + Math.sin(worldTime * 1.8 + decoration.userData.swayPhase) * 0.035);
      }
      if (decoration.userData.mistLayer) {
        decoration.position.y = Number(decoration.userData.baseY) + Math.sin(worldTime * 0.18) * 0.035;
        decoration.position.x = Math.sin(worldTime * 0.055) * 0.5;
      }
      if (decoration.userData.ambientMotes) {
        decoration.rotation.y = worldTime * 0.006;
        decoration.position.y = Math.sin(worldTime * 0.16) * 0.08;
      }
      if (decoration.userData.boundaryField) {
        const material = (decoration as unknown as THREE.Mesh).material;
        if (material instanceof THREE.ShaderMaterial) material.uniforms.uTime!.value = worldTime;
      }
    }
  }

  private updateCamera(
    state: MatchState,
    firstPerson: boolean,
    worldTime: number,
    delta: number,
  ): void {
    const localPlayer = this.localPlayerId ? state.players[this.localPlayerId] : undefined;
    const localRig = localPlayer ? this.playerRigs.get(localPlayer.id) : undefined;
    const alive = Boolean(localPlayer?.alive && localRig);
    const operatingTurret = Boolean(
      alive
      && localPlayer
      && state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === localPlayer.id,
    );

    if (firstPerson && operatingTurret) {
      this.towerTurret.updateWorldMatrix(true, true);
      this.towerTurretCameraMount.getWorldPosition(this.camera.position);
      const damageShake = this.damagePulse * 0.012;
      this.camera.rotation.set(
        state.tower.turretPitch + Math.sin(worldTime * 58) * damageShake,
        state.tower.turretYaw + Math.cos(worldTime * 47) * damageShake,
        Math.sin(worldTime * 69) * damageShake * 0.24,
        'YXZ',
      );
      const turretFov = 68;
      if (Math.abs(this.camera.fov - turretFov) > 0.01) {
        this.camera.fov = damp(this.camera.fov, turretFov, 18, delta);
        this.camera.updateProjectionMatrix();
      }
      this.viewModel.visible = false;
      this.viewAimBlend = damp(this.viewAimBlend, 0, 20, delta);
      this.previousViewYaw = null;
      this.previousViewPitch = null;
      return;
    }

    if (firstPerson && localPlayer && localRig && alive) {
      const speed = Math.hypot(localPlayer.velocity.x, localPlayer.velocity.z);
      const bobAmount = localRig.moveBlend * localRig.groundBlend;
      const bobPhase = localRig.locomotionPhase;
      const viewLocomotion = {
        moveBlend: localRig.moveBlend,
        runBlend: smootherstep01((speed - 2.35) / 3.05),
        forwardBlend: localRig.forwardBlend,
        strafeBlend: localRig.strafeBlend,
      };
      const weaponBob = evaluateWeaponBob(
        bobPhase,
        viewLocomotion,
        localRig.groundBlend,
        this.viewAimBlend,
      );
      const landingWeight = trianglePulse(
        normalizedTimer(localRig.landingTimer, 0.34),
        0,
        0.2,
        1,
      ) * localRig.landingStrength;
      const jumpWeight = trianglePulse(normalizedTimer(localRig.jumpTimer, 0.32), 0, 0.18, 1);
      const damageShake = this.damagePulse * 0.018;
      const eyeHeight = localPlayer.height * 0.86;
      this.camera.position.copy(localRig.root.position);
      this.camera.position.y += eyeHeight
        + weaponBob.y * 0.62
        - landingWeight * 0.085
        + jumpWeight * 0.024;
      this.camera.position.x += Math.cos(localPlayer.yaw) * weaponBob.x * 0.5;
      this.camera.position.z -= Math.sin(localPlayer.yaw) * weaponBob.x * 0.5;
      this.camera.rotation.set(
        localPlayer.pitch + Math.sin(worldTime * 58) * damageShake,
        localPlayer.yaw + Math.cos(worldTime * 47) * damageShake,
        weaponBob.roll * 0.45
          - localRig.strafeBlend * 0.0035 * bobAmount
          + Math.sin(worldTime * 69) * damageShake * 0.35,
        'YXZ',
      );

      const activeWeapon = localPlayer.inventory[localPlayer.activeWeapon] ?? localPlayer.inventory[0];
      this.setViewWeapon(activeWeapon?.id ?? null);
      const aiming = Boolean(activeWeapon && this.localViewAim);
      this.viewAimBlend = damp(this.viewAimBlend, aiming ? 1 : 0, aiming ? 17 : 21, delta);
      const aimedFov = activeWeapon?.id === 'sniper'
        ? SNIPER_ZOOM_FOV[this.sniperZoomLevel]
        : activeWeapon
          ? WEAPON_AIM_FOV[activeWeapon.id]
          : 74;
      const targetFov = THREE.MathUtils.lerp(
        74,
        aimedFov,
        this.viewAimBlend,
      );
      if (Math.abs(this.camera.fov - targetFov) > 0.01) {
        this.camera.fov = targetFov;
        this.camera.updateProjectionMatrix();
      }
      const palette = TEAM_COLORS[localPlayer.team];
      this.viewArmMaterial.color.setHex(palette.armor);
      this.viewModel.visible = !(activeWeapon?.id === 'sniper' && this.viewAimBlend > 0.72);

      if (this.previousViewYaw === null || this.previousViewPitch === null) {
        this.previousViewYaw = localPlayer.yaw;
        this.previousViewPitch = localPlayer.pitch;
      }
      const yawDelta = Math.atan2(
        Math.sin(localPlayer.yaw - this.previousViewYaw),
        Math.cos(localPlayer.yaw - this.previousViewYaw),
      );
      const pitchDelta = localPlayer.pitch - this.previousViewPitch;
      const targetSwayYaw = THREE.MathUtils.clamp(-yawDelta / Math.max(delta, 1 / 240) * 0.014, -0.12, 0.12);
      const targetSwayPitch = THREE.MathUtils.clamp(-pitchDelta / Math.max(delta, 1 / 240) * 0.012, -0.09, 0.09);
      this.viewSwayYaw = damp(this.viewSwayYaw, targetSwayYaw, 14, delta);
      this.viewSwayPitch = damp(this.viewSwayPitch, targetSwayPitch, 14, delta);
      this.previousViewYaw = localPlayer.yaw;
      this.previousViewPitch = localPlayer.pitch;

      let actionKind: 'none' | 'reload' | 'swap' | 'melee' | 'grenade' = 'none';
      let actionPose: ActionPoseWeights = { lower: 0, twist: 0, part: 0, hand: 0 };
      let reloadProgress = 0;
      if (activeWeapon && activeWeapon.reloadTimer > 0) {
        reloadProgress = normalizedTimer(activeWeapon.reloadTimer, WEAPONS[activeWeapon.id].reloadSeconds);
        actionKind = 'reload';
        actionPose = evaluateReload(reloadProgress);
      }
      if (localRig.swapTimer > 0) {
        actionKind = 'swap';
        actionPose = evaluateSwap(normalizedTimer(localRig.swapTimer, 0.48));
      }
      if (localRig.grenadeTimer > 0) {
        actionKind = 'grenade';
        actionPose = evaluateGrenade(normalizedTimer(localRig.grenadeTimer, 0.65));
      }
      if (localRig.meleeTimer > 0) {
        actionKind = 'melee';
        actionPose = evaluateMelee(normalizedTimer(localRig.meleeTimer, 0.85));
      }

      const recoil = Math.max(localRig.recoil, this.weaponKick);
      const steadying = 1 - this.viewAimBlend * 0.88;
      const bobX = weaponBob.x;
      const bobY = weaponBob.y;
      const airDrift = (1 - localRig.groundBlend) * THREE.MathUtils.clamp(localPlayer.velocity.y / 8, -1, 1);
      const aimedX = activeWeapon?.id === 'rocket-launcher' ? 0.13 : activeWeapon?.id === 'sidearm' ? 0.075 : 0.035;
      const aimedY = activeWeapon?.id === 'sniper' ? -0.2 : -0.225;
      const aimedZ = activeWeapon?.id === 'sniper' ? -0.5 : -0.55;
      this.viewModel.position.set(
        THREE.MathUtils.lerp(0.31, aimedX, this.viewAimBlend) + bobX,
        THREE.MathUtils.lerp(-0.28, aimedY, this.viewAimBlend)
          - bobY
          - landingWeight * 0.06 * steadying
          + airDrift * 0.025 * steadying,
        THREE.MathUtils.lerp(-0.62, aimedZ, this.viewAimBlend),
      );
      this.viewModel.rotation.set(
        THREE.MathUtils.lerp(-0.03, 0, this.viewAimBlend)
          + landingWeight * 0.045 * steadying
          + weaponBob.pitch,
        THREE.MathUtils.lerp(-0.045, 0, this.viewAimBlend),
        THREE.MathUtils.lerp(0.012, 0, this.viewAimBlend)
          + weaponBob.roll
          - localRig.strafeBlend * 0.012 * bobAmount * steadying,
      );

      this.viewActionPivot.position.set(
        this.viewSwayYaw * 0.14 * steadying + (actionKind === 'melee' ? -actionPose.part * 0.08 : 0),
        this.viewSwayPitch * 0.1 * steadying - actionPose.lower * (actionKind === 'swap' ? 0.48 : 0.2) - recoil * 0.012,
        recoil * 0.07 + (actionKind === 'melee' ? -actionPose.part * 0.25 : 0),
      );
      this.viewActionPivot.rotation.set(
        this.viewSwayPitch * steadying
          + recoil * 0.11
          + (actionKind === 'melee' ? -0.58 * actionPose.part : 0.18 * actionPose.lower)
          + (actionKind === 'grenade' ? -0.34 * actionPose.part : 0),
        this.viewSwayYaw * steadying
          + (actionKind === 'melee' ? -0.82 : actionKind === 'grenade' ? 0.28 : -0.12) * actionPose.twist
          - recoil * 0.022,
        (actionKind === 'swap' ? 0.68 : actionKind === 'reload' ? 0.52 : 0.24) * actionPose.twist
          + recoil * 0.018,
      );

      this.viewRightHandAssembly.position.copy(this.viewRightHandBasePosition);
      this.viewLeftHandAssembly.position.copy(this.viewLeftHandBasePosition);
      this.viewRightHandAssembly.rotation.set(0, 0, 0);
      this.viewLeftHandAssembly.rotation.set(0, 0, 0);
      if (actionKind === 'reload') {
        this.viewLeftHandAssembly.position.add(new THREE.Vector3(-0.09, -0.18, 0.11).multiplyScalar(actionPose.hand));
        this.viewLeftHandAssembly.rotation.set(0.22 * actionPose.hand, -0.18 * actionPose.hand, -0.46 * actionPose.hand);
      } else if (actionKind === 'grenade') {
        this.viewLeftHandAssembly.position.add(new THREE.Vector3(-0.34, 0.2, -0.16).multiplyScalar(actionPose.hand));
        this.viewLeftHandAssembly.rotation.set(-0.72 * actionPose.hand, 0.24 * actionPose.hand, -0.5 * actionPose.hand);
      } else if (actionKind === 'swap') {
        this.viewLeftHandAssembly.position.y -= actionPose.hand * 0.07;
        this.viewLeftHandAssembly.rotation.z = -actionPose.hand * 0.18;
      }

      this.resetAnimatedWeaponParts(this.viewWeaponParts);
      this.animateWeaponParts(
        this.viewWeaponParts,
        this.viewWeaponId,
        actionKind === 'reload' ? reloadProgress : 0,
        normalizedTimer(localRig.fireTimer, 0.55),
        recoil,
      );
      return;
    }

    this.viewModel.visible = false;
    this.viewAimBlend = damp(this.viewAimBlend, 0, 18, delta);
    if (Math.abs(this.camera.fov - 74) > 0.01) {
      this.camera.fov = damp(this.camera.fov, 74, 16, delta);
      this.camera.updateProjectionMatrix();
    }
    this.previousViewYaw = null;
    this.previousViewPitch = null;
    if (localPlayer && localRig) {
      const target = localRig.root.position.clone().add(new THREE.Vector3(0, localPlayer.height * 0.7, 0));
      const forward = FORWARD.clone().applyAxisAngle(UP, localPlayer.yaw);
      const desired = target.clone().addScaledVector(forward, -6.6).add(new THREE.Vector3(0, 2.65, 0));
      const damping = 1 - Math.exp(-delta * 7.5);
      this.camera.position.lerp(desired, damping);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(target);
      return;
    }

    const center = new THREE.Vector3(
      (this.map.bounds.minX + this.map.bounds.maxX) * 0.5,
      this.map.bounds.floorY + 4.3,
      (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5,
    );
    const mapSpan = Math.max(
      this.map.bounds.maxX - this.map.bounds.minX,
      this.map.bounds.maxZ - this.map.bounds.minZ,
    );
    const radius = mapSpan * 0.68;
    const angle = this.elapsedRenderTime * 0.045 + 0.7;
    const desired = new THREE.Vector3(
      center.x + Math.cos(angle) * radius,
      Math.max(24, mapSpan * 0.28),
      center.z + Math.sin(angle) * radius,
    );
    this.camera.position.lerp(desired, 1 - Math.exp(-delta * 2.4));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(center);
  }

  private setViewWeapon(id: WeaponId | null): void {
    if (id === this.viewWeaponId) return;
    this.viewWeaponMount.clear();
    this.viewWeaponId = id;
    this.viewWeaponModel = null;
    this.viewWeaponParts = {};
    if (!id) return;
    const weapon = this.getWeaponTemplate(id).clone(true);
    const pose = WEAPON_VIEW_POSES[id];
    weapon.scale.setScalar(pose.scale);
    weapon.position.set(...pose.position);
    weapon.rotation.set(...pose.rotation);
    weapon.traverse((object) => {
      object.frustumCulled = false;
      object.renderOrder = 31;
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.receiveShadow = false;
      }
    });
    this.viewWeaponMount.add(weapon);
    this.viewWeaponModel = weapon;
    this.viewWeaponParts = this.collectAnimatedWeaponParts(weapon);

    const primaryGrip = getWeaponAnchor(weapon, 'primaryGrip');
    const supportGrip = getWeaponAnchor(weapon, 'supportGrip');
    if (primaryGrip) {
      this.viewCamera.updateMatrixWorld(true);
      const primaryTarget = this.viewActionPivot.worldToLocal(weapon.localToWorld(vectorFrom(primaryGrip)));
      this.viewRightHandAssembly.position.copy(primaryTarget).sub(new THREE.Vector3(0.2, -0.015, -0.24));
      const supportTarget = supportGrip
        ? this.viewActionPivot.worldToLocal(weapon.localToWorld(vectorFrom(supportGrip)))
        : primaryTarget.clone().add(new THREE.Vector3(-0.12, 0.02, -0.24));
      this.viewLeftHandAssembly.position.copy(supportTarget).sub(new THREE.Vector3(-0.115, -0.005, -0.38));
    } else {
      this.viewRightHandAssembly.position.set(0, 0, 0);
      this.viewLeftHandAssembly.position.set(0, 0, 0);
    }
    this.viewRightHandBasePosition.copy(this.viewRightHandAssembly.position);
    this.viewLeftHandBasePosition.copy(this.viewLeftHandAssembly.position);
  }
}
