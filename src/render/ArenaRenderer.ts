import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { isJumpPad } from '../game/map';
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
  damp,
  evaluateGrenade,
  evaluateMelee,
  evaluateReload,
  evaluateSwap,
  normalizedTimer,
  saturate,
  smootherstep01,
  trianglePulse,
  type ActionPoseWeights,
} from './animationMath';
import { createColdAlienPlant, createLayeredRidge } from './landscapeGeometry';
import {
  createColdEnvironmentTexture,
  createRadialTexture,
  createStylizedGroundTexture,
} from './visualTextures';
import {
  createWeaponModel,
  WEAPON_VIEW_POSES,
  type WeaponAnimationRole,
} from './weaponModels';

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);
const ASTRONAUT_WAIST_HEIGHT = 1.05;

const TEAM_COLORS: Record<Team, { armor: number; accent: number; glow: number }> = {
  aurora: { armor: 0x8db8b2, accent: 0x43e2d0, glow: 0x35f0d5 },
  nova: { armor: 0xa69fba, accent: 0xb98ae2, glow: 0xd58df0 },
  neutral: { armor: 0x9eafb3, accent: 0xb9d5d9, glow: 0x75cbd3 },
};

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
  armorMaterial: THREE.MeshStandardMaterial;
  accentMaterial: THREE.MeshStandardMaterial;
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

const disposeObject = (object: THREE.Object3D): void => {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments)) return;
    if (child.userData.sharedVisualTemplate) return;
    child.geometry.dispose();
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
  private readonly weaponTemplates = new Map<WeaponId, THREE.Group>();
  private readonly worldDecorations: THREE.Group[] = [];
  private readonly ownedTextures = new Set<THREE.Texture>();
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private groundTexture: THREE.CanvasTexture | null = null;
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
  private skyDome: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> | null = null;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly damageUniform = { value: 0 };
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
  private previousViewYaw: number | null = null;
  private previousViewPitch: number | null = null;
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
    this.renderer.toneMappingExposure = 1.14;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.container.append(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xb8d6da);
    this.scene.fog = new THREE.FogExp2(0xb8d6da, 0.0066);
    this.scene.environmentIntensity = 0.72;
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(44, 24, 42);
    this.camera.lookAt(0, 4, 0);
    this.scene.add(this.camera);

    this.createEnvironmentMap();
    this.viewScene.environment = this.scene.environment;
    this.viewScene.environmentIntensity = 0.9;
    this.viewScene.add(this.viewCamera);
    const viewHemisphere = new THREE.HemisphereLight(0xc9e7ef, 0x101923, 0.78);
    const viewKey = new THREE.DirectionalLight(0xffead0, 2.6);
    viewKey.position.set(-2.2, 3.4, 2.6);
    const viewRim = new THREE.PointLight(0x7ce6de, 4.2, 4, 2);
    viewRim.position.set(1.4, 0.8, -0.4);
    this.viewScene.add(viewHemisphere, viewKey, viewRim);

    const composerTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    composerTarget.samples = 0;
    this.composer = new EffectComposer(this.renderer, composerTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const viewModelPass = new RenderPass(this.viewScene, this.viewCamera);
    viewModelPass.clear = false;
    viewModelPass.clearDepth = true;
    this.composer.addPass(viewModelPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.42, 1.05);
    this.composer.addPass(this.bloomPass);
    this.gradePass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uDamage: this.damageUniform,
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

        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }

        void main() {
          vec4 source = texture2D(tDiffuse, vUv);
          vec3 color = source.rgb;
          float edge = smoothstep(0.34, 1.02, length((vUv - 0.5) * vec2(1.15, 1.0)) * 1.42);
          color *= 1.0 - edge * (0.105 + uDamage * 0.065);
          float grain = hash(vUv * vec2(1493.0, 877.0) + floor(uTime * 24.0)) - 0.5;
          color += grain * 0.006;
          color = mix(color, color * vec3(0.96, 1.015, 1.035), 0.22);
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

  public pulseDamage(): void {
    this.damagePulse = 1;
  }

  public resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth || window.innerWidth || 1);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight || 1);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.4);
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
    this.gradePass.uniforms.uDamage!.value = this.damageUniform.value;
    this.renderer.toneMappingExposure = 1.14 - this.damagePulse * 0.12;
    this.skyMaterial.uniforms.uTime!.value = worldTime;
    this.gradePass.uniforms.uTime!.value = worldTime;

    this.composer.render(delta);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const collect = (object: THREE.Object3D): void => {
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh || child instanceof THREE.Line || child instanceof THREE.LineSegments)) return;
        geometries.add(child.geometry);
        const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of childMaterials) materials.add(material);
      });
    };

    collect(this.scene);
    collect(this.viewScene);
    for (const template of this.weaponTemplates.values()) collect(template);
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
          vec3 horizon = vec3(0.49, 0.69, 0.73);
          vec3 middle = vec3(0.11, 0.25, 0.38);
          vec3 zenith = vec3(0.025, 0.075, 0.16);
          vec3 color = mix(horizon, middle, smoothstep(0.47, 0.74, h));
          color = mix(color, zenith, smoothstep(0.70, 1.0, h));

          vec3 sunDir = normalize(vec3(-0.52, 0.64, -0.56));
          float alignment = max(dot(vDirection, sunDir), 0.0);
          float sun = pow(alignment, 520.0);
          float innerHalo = pow(alignment, 48.0);
          float outerHalo = pow(alignment, 7.0);
          color += vec3(1.0, 0.91, 0.74) * sun * 3.8;
          color += vec3(0.55, 0.82, 0.82) * innerHalo * 0.34;
          color += vec3(0.19, 0.38, 0.46) * outerHalo * 0.22;

          vec2 cloudUv = vDirection.xz * 4.2 + vDirection.y * vec2(1.7, -1.3);
          float cloudNoise = fbm(cloudUv + vec2(uTime * 0.004, 0.0));
          float cloudBand = smoothstep(0.54, 0.72, cloudNoise);
          cloudBand *= smoothstep(0.39, 0.58, h) * (1.0 - smoothstep(0.75, 0.89, h));
          color = mix(color, vec3(0.54, 0.72, 0.76), cloudBand * 0.19);

          vec3 planetDir = normalize(vec3(0.58, 0.38, 0.72));
          float planetDot = dot(vDirection, planetDir);
          float planet = smoothstep(0.9973, 0.9981, planetDot);
          vec3 planetSurface = normalize(vDirection - planetDir * 0.9973 + vec3(0.0, 0.0001, 0.0));
          float planetShade = smoothstep(-0.08, 0.5, dot(planetSurface, sunDir));
          color = mix(color, vec3(0.46, 0.56, 0.74) * (0.55 + planetShade * 0.45), planet * 0.34);
          float ring = 1.0 - smoothstep(0.0, 0.0028, abs(dot(vDirection - planetDir, normalize(vec3(0.18, 0.94, -0.28)))));
          ring *= smoothstep(0.96, 0.995, planetDot) * (1.0 - planet * 0.7);
          color += ring * vec3(0.44, 0.69, 0.79) * 0.16;
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
    const hemisphere = new THREE.HemisphereLight(0xa9d6e7, 0x08131c, 0.72);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xffe8c4, 3.65);
    sun.position.set(-42, 54, -45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -48;
    sun.shadow.camera.right = 48;
    sun.shadow.camera.top = 42;
    sun.shadow.camera.bottom = -42;
    sun.shadow.camera.near = 4;
    sun.shadow.camera.far = 132;
    sun.shadow.bias = -0.00045;
    sun.shadow.normalBias = 0.025;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8f9bff, 0.24);
    fill.position.set(34, 22, 38);
    this.scene.add(fill);

    const towerKey = new THREE.PointLight(0x83f3e4, 22, 17, 2);
    towerKey.position.set(0, 7.8, 0);
    this.scene.add(towerKey);

    const auroraBase = new THREE.PointLight(0x43e2d0, 14, 13, 2);
    auroraBase.position.set(-29, 3.4, 0);
    this.scene.add(auroraBase);

    const novaBase = new THREE.PointLight(0xb98ae2, 14, 13, 2);
    novaBase.position.set(29, 3.4, 0);
    this.scene.add(novaBase);
  }

  private createLandscape(): void {
    this.groundTexture = createStylizedGroundTexture(512);
    this.groundTexture.repeat.set(6, 6);
    this.groundTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.ownedTextures.add(this.groundTexture);

    const outerGround = new THREE.Mesh(
      new THREE.CircleGeometry(146, 96),
      new THREE.MeshStandardMaterial({
        color: 0xd2e1dc,
        map: this.groundTexture,
        roughness: 0.94,
        metalness: 0,
        envMapIntensity: 0.12,
      }),
    );
    outerGround.rotation.x = -Math.PI / 2;
    outerGround.position.y = this.map.bounds.floorY - 0.22;
    outerGround.receiveShadow = true;
    this.scene.add(outerGround);

    const random = seededRandom(0x51f1e);
    const ridgeMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x294954, roughness: 0.96, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x365866, roughness: 0.98, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x4c7180, roughness: 1, flatShading: true }),
    ];

    const ridgeBands = [
      { count: 9, distance: 60, spread: 18, radius: 9, height: 14 },
      { count: 9, distance: 82, spread: 22, radius: 13, height: 22 },
      { count: 8, distance: 110, spread: 25, radius: 18, height: 31 },
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
          Math.cos(angle) * distance,
          this.map.bounds.floorY - 0.34,
          Math.sin(angle) * distance,
        );
        ridge.rotation.y = angle + Math.PI * 0.5 + (random() - 0.5) * 0.45;
        this.scene.add(ridge);
      }
    }

    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x365d66, roughness: 0.94, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x4c6176, roughness: 0.96, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x294d59, roughness: 0.96, flatShading: true }),
    ];
    const rockCounts = [22, 22, 22];
    for (let materialIndex = 0; materialIndex < rockMaterials.length; materialIndex += 1) {
      const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterials[materialIndex]!, rockCounts[materialIndex]!);
      const transform = new THREE.Object3D();
      for (let index = 0; index < rockCounts[materialIndex]!; index += 1) {
        const angle = random() * Math.PI * 2;
        const distance = 39 + random() * 43;
        const scale = 0.42 + random() * 2.15;
        transform.position.set(
          Math.cos(angle) * distance,
          this.map.bounds.floorY + scale * 0.35 - 0.15,
          Math.sin(angle) * distance,
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
      stem: new THREE.MeshStandardMaterial({ color: 0x173b43, roughness: 0.92, flatShading: true }),
      leaf: new THREE.MeshStandardMaterial({
        color: 0x3e7b7c,
        roughness: 0.82,
        flatShading: true,
      }),
      glow: new THREE.MeshStandardMaterial({
        color: 0x8be1d5,
        emissive: 0x36adab,
        emissiveIntensity: 1.45,
        roughness: 0.28,
      }),
    };
    for (let index = 0; index < 16; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = 39 + random() * 31;
      const plant = createColdAlienPlant({
        seed: 0xa11e + index,
        materials: plantMaterials,
        height: 1.4 + random() * 1.45,
        radius: 0.48 + random() * 0.34,
        blades: 4 + Math.floor(random() * 2),
        castShadow: index < 8,
      });
      plant.position.set(Math.cos(angle) * distance, this.map.bounds.floorY, Math.sin(angle) * distance);
      plant.rotation.y = random() * Math.PI * 2;
      this.worldDecorations.push(plant);
      this.scene.add(plant);
    }
  }

  private createMapGeometry(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const floorGeometry = new THREE.PlaneGeometry(width, depth, 48, 40);
    const position = floorGeometry.getAttribute('position');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const x = position.getX(vertex);
      const y = position.getY(vertex);
      const macro = Math.sin(x * 0.19 + Math.cos(y * 0.11) * 1.7) * 0.5 + 0.5;
      const fine = Math.sin(x * 0.73 - y * 0.51) * Math.cos(y * 0.37) * 0.5 + 0.5;
      position.setZ(vertex, (macro - 0.5) * 0.045 + (fine - 0.5) * 0.018);
    }
    floorGeometry.computeVertexNormals();
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshStandardMaterial({
        color: 0xc6d8d3,
        map: this.groundTexture,
        roughness: 0.88,
        metalness: 0.06,
        envMapIntensity: 0.22,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(
      (this.map.bounds.minX + this.map.bounds.maxX) * 0.5,
      this.map.bounds.floorY - 0.035,
      (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5,
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    const markingMaterial = new THREE.MeshBasicMaterial({
      color: 0x94c6ca,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    for (const radius of [5.9, 11.8, 23.5]) {
      const marking = new THREE.Mesh(new THREE.RingGeometry(radius, radius + 0.065, 96), markingMaterial);
      marking.rotation.x = -Math.PI / 2;
      marking.position.y = this.map.bounds.floorY + 0.018;
      this.scene.add(marking);
    }

    for (const team of ['aurora', 'nova'] as const) {
      const side = team === 'aurora' ? -1 : 1;
      const laneMaterial = new THREE.MeshBasicMaterial({
        color: TEAM_COLORS[team].glow,
        transparent: true,
        opacity: 0.17,
        depthWrite: false,
      });
      for (const z of [-3.9, 3.9]) {
        const lane = new THREE.Mesh(new THREE.PlaneGeometry(19, 0.075), laneMaterial);
        lane.rotation.x = -Math.PI / 2;
        lane.position.set(side * 19, this.map.bounds.floorY + 0.021, z);
        this.scene.add(lane);
      }
    }

    const paintMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b4654,
      roughness: 0.56,
      metalness: 0.14,
      envMapIntensity: 0.42,
    });
    const structureMaterial = new THREE.MeshStandardMaterial({
      color: 0x0e1d29,
      roughness: 0.36,
      metalness: 0.68,
      envMapIntensity: 0.95,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x132733,
      roughness: 0.74,
      metalness: 0.18,
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
      const baseColor = new THREE.Color(obstacle.color).lerp(new THREE.Color(0x294754), 0.32);
      const material = paintMaterial.clone();
      material.color.copy(baseColor);
      material.roughness = obstacle.kind === 'tower' ? 0.46 : 0.58;
      material.metalness = obstacle.kind === 'tower' ? 0.26 : 0.12;
      const minimum = Math.min(size.x, size.y, size.z);
      const bevel = Math.min(0.16, Math.max(0.035, minimum * 0.12));
      const geometry = new RoundedBoxGeometry(size.x, size.y, size.z, 3, bevel);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(center);
      if (obstacle.kind === 'wall') {
        const visibleHeight = 1.75;
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
            color: 0x7ac5c8,
            emissive: 0x3c999c,
            emissiveIntensity: 1.15,
            roughness: 0.26,
            metalness: 0.52,
          }),
        );
        rail.position.set(center.x, obstacle.min.y + visibleHeight + 0.025, center.z);
        this.scene.add(rail);
      }
      mesh.castShadow = obstacle.kind !== 'wall' && (size.x < 18 || size.z < 18);
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      if (obstacle.kind !== 'wall') {
        const plinthHeight = Math.min(0.16, size.y * 0.12);
        const plinth = new THREE.Mesh(
          new RoundedBoxGeometry(size.x * 0.96, plinthHeight, size.z * 0.96, 2, Math.min(0.06, plinthHeight * 0.3)),
          structureMaterial,
        );
        plinth.position.set(center.x, obstacle.min.y + plinthHeight * 0.5 + 0.012, center.z);
        plinth.castShadow = true;
        plinth.receiveShadow = true;
        this.scene.add(plinth);
      }

      if (obstacle.kind !== 'wall' && size.x > 1.4 && size.z > 1.4) {
        const topHeight = 0.075;
        const top = new THREE.Mesh(
          new RoundedBoxGeometry(size.x * 0.84, topHeight, size.z * 0.84, 2, 0.025),
          new THREE.MeshStandardMaterial({
            color: baseColor.clone().lerp(new THREE.Color(0x86aeb4), 0.26),
            roughness: 0.42,
            metalness: 0.32,
            envMapIntensity: 0.7,
          }),
        );
        top.position.set(center.x, obstacle.max.y + topHeight * 0.42, center.z);
        top.castShadow = false;
        top.receiveShadow = true;
        this.scene.add(top);
      }

      if (obstacle.kind === 'cover' || obstacle.kind === 'platform') {
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

    for (const x of [-9.6, 9.6]) {
      const position: Vec3 = { x, y: this.map.bounds.floorY, z: 0 };
      if (!isJumpPad(position)) continue;
      const pedestal = new THREE.Mesh(
        new THREE.CylinderGeometry(1.28, 1.38, 0.18, 32),
        structureMaterial,
      );
      pedestal.position.set(x, this.map.bounds.floorY + 0.09, 0);
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
      pad.position.set(x, this.map.bounds.floorY + 0.195, 0);
      pad.userData.spin = x < 0 ? 1 : -1;
      this.worldDecorations.push(pad as unknown as THREE.Group);
      this.scene.add(pad);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.7, 1.05, 5.5, 32, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x79eee2,
          transparent: true,
          opacity: 0.055,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      beam.position.set(x, 2.82, 0);
      beam.userData.energyBeam = true;
      beam.userData.swayPhase = x < 0 ? 0 : Math.PI;
      this.worldDecorations.push(beam as unknown as THREE.Group);
      this.scene.add(beam);
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
    const cradle = new THREE.Mesh(new RoundedBoxGeometry(1.06, 0.45, 0.78, 3, 0.12), turretBaseMaterial);
    cradle.position.set(0, 0.87, -0.23);
    cradle.castShadow = true;
    this.towerTurret.add(cradle);
    for (const x of [-0.25, 0.25]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.09, 1.82, 12), turretMetalMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(x, 0.92, -1.05);
      barrel.castShadow = true;
      this.towerTurret.add(barrel);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.42, 12), turretGlowMaterial);
      sleeve.rotation.x = Math.PI / 2;
      sleeve.position.set(x, 0.92, -0.61);
      this.towerTurret.add(sleeve);
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.028, 7, 16), turretMetalMaterial);
      muzzle.position.set(x, 0.92, -1.97);
      this.towerTurret.add(muzzle);
    }
    const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 9), turretGlowMaterial);
    sensor.position.set(0, 1.18, -0.32);
    this.towerTurret.add(sensor);
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
      rig.armorMaterial.emissiveIntensity = player.isJuggernaut ? 0.42 + Math.sin(worldTime * 5) * 0.12 : 0.08;
      rig.accentMaterial.emissiveIntensity = player.isJuggernaut ? 1.25 : 0.48;
      rig.root.visible = (player.alive || rig.deathTimer > 0)
        && !(firstPerson && player.id === this.localPlayerId && player.alive);
    }

    for (const [id, rig] of this.playerRigs) {
      if (present.has(id)) continue;
      rig.weaponMount.clear();
      this.scene.remove(rig.root);
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
    const targetMove = smootherstep01((horizontalSpeed - 0.08) / 6.7);
    rig.moveBlend = damp(rig.moveBlend, targetMove, 13, delta);
    rig.groundBlend = damp(rig.groundBlend, player.grounded ? 1 : 0, player.grounded ? 19 : 13, delta);
    rig.forwardBlend = damp(rig.forwardBlend, THREE.MathUtils.clamp(forwardSpeed / 7, -1, 1), 10, delta);
    rig.strafeBlend = damp(rig.strafeBlend, THREE.MathUtils.clamp(strafeSpeed / 7, -1, 1), 10, delta);

    const runBlend = smootherstep01((horizontalSpeed - 2.7) / 4.3);
    const strideLength = THREE.MathUtils.lerp(1.05, 1.68, runBlend);
    const phaseDirection = rig.forwardBlend < -0.12 ? -1 : 1;
    rig.locomotionPhase += horizontalSpeed * delta / strideLength * Math.PI * 2 * phaseDirection;
    const cycle = Math.sin(rig.locomotionPhase);
    const oppositeCycle = -cycle;
    const strideAmplitude = THREE.MathUtils.lerp(0.28, 0.72, runBlend) * rig.moveBlend;
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

    const leftHipX = cycle * strideAmplitude * groundedWeight + leftAirHip * airborneWeight - jumpWeight * 0.08;
    const rightHipX = oppositeCycle * strideAmplitude * groundedWeight + rightAirHip * airborneWeight - jumpWeight * 0.02;
    const leftRecovery = Math.max(0, -cycle) * (0.36 + runBlend * 0.42) * rig.moveBlend;
    const rightRecovery = Math.max(0, cycle) * (0.36 + runBlend * 0.42) * rig.moveBlend;
    const airKnee = rise * 0.52 + fall * 0.12;
    const leftKneeX = leftRecovery * groundedWeight + airKnee * airborneWeight + landingWeight * 0.72;
    const rightKneeX = rightRecovery * groundedWeight + airKnee * airborneWeight + landingWeight * 0.72;
    const strafeLean = rig.strafeBlend * 0.12 * rig.moveBlend;

    rig.leftLeg.rotation.set(leftHipX, 0, strafeLean * 0.34);
    rig.rightLeg.rotation.set(rightHipX, 0, strafeLean * 0.34);
    rig.leftKnee.rotation.set(-leftKneeX, 0, 0);
    rig.rightKnee.rotation.set(-rightKneeX, 0, 0);
    rig.leftFoot.rotation.set(-leftHipX + leftKneeX * 0.78, 0, -strafeLean * 0.24);
    rig.rightFoot.rotation.set(-rightHipX + rightKneeX * 0.78, 0, -strafeLean * 0.24);

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
      player.pitch * 0.075 - rig.forwardBlend * 0.065 * rig.moveBlend + landingWeight * 0.1 + fall * airborneWeight * 0.055,
      0,
      -rig.strafeBlend * 0.1 * rig.moveBlend
        - cycle * 0.018 * rig.moveBlend * groundedWeight
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

  private createAstronaut(player: PlayerState): PlayerRig {
    const palette = TEAM_COLORS[player.team];
    const root = new THREE.Group();
    root.name = `astronaut-${player.id}`;
    root.position.set(player.position.x, player.position.y, player.position.z);
    root.rotation.y = player.yaw;
    const motionRoot = new THREE.Group();
    motionRoot.name = 'astronaut-motion-root';
    root.add(motionRoot);

    const armorMaterial = new THREE.MeshStandardMaterial({
      color: palette.armor,
      emissive: palette.glow,
      emissiveIntensity: 0.025,
      roughness: 0.38,
      metalness: 0.14,
      envMapIntensity: 0.9,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      emissive: palette.glow,
      emissiveIntensity: 0.72,
      roughness: 0.3,
      metalness: 0.28,
      envMapIntensity: 1.05,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({
      color: 0x101d27,
      roughness: 0.78,
      metalness: 0.06,
      envMapIntensity: 0.45,
    });
    const technicalMaterial = new THREE.MeshStandardMaterial({
      color: 0x344b57,
      roughness: 0.3,
      metalness: 0.78,
      envMapIntensity: 1.25,
    });
    const visorMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x071722,
      emissive: 0x123c50,
      emissiveIntensity: 0.38,
      roughness: 0.055,
      metalness: 0.44,
      clearcoat: 1,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.8,
    });

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

    const chest = new THREE.Mesh(new RoundedBoxGeometry(0.67, 0.5, 0.43, 4, 0.11), armorMaterial);
    chest.position.y = 1.3;
    chest.scale.set(1, 1, 0.96);
    chest.castShadow = true;
    torso.add(chest);

    const chestPlate = new THREE.Mesh(new RoundedBoxGeometry(0.45, 0.25, 0.075, 3, 0.028), accentMaterial);
    chestPlate.position.set(0, 1.31, -0.235);
    chestPlate.rotation.x = -0.04;
    chestPlate.castShadow = true;
    torso.add(chestPlate);
    const chestInset = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.095, 0.045, 2, 0.018), jointMaterial);
    chestInset.position.set(0, 1.31, -0.285);
    torso.add(chestInset);
    for (const x of [-0.135, 0.135]) {
      const status = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.022, 0.022, 2, 0.008), accentMaterial);
      status.position.set(x, 1.33, -0.318);
      torso.add(status);
    }

    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.055, 8, 20), technicalMaterial);
    collar.rotation.x = Math.PI / 2;
    collar.scale.z = 0.82;
    collar.position.y = 1.54;
    collar.castShadow = true;
    torso.add(collar);

    const backpack = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.56, 0.23, 3, 0.07), jointMaterial);
    backpack.position.set(0, 1.28, 0.31);
    backpack.castShadow = true;
    torso.add(backpack);
    for (const x of [-0.18, 0.18]) {
      const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.086, 0.39, 10), technicalMaterial);
      canister.position.set(x, 1.3, 0.46);
      canister.castShadow = true;
      torso.add(canister);
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
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.34, 24, 16), armorMaterial);
    helmet.scale.set(0.96, 1.03, 0.94);
    helmet.castShadow = true;
    head.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.282, 24, 14), visorMaterial);
    visor.scale.set(0.94, 0.67, 0.46);
    visor.position.set(0, 0.018, -0.286);
    head.add(visor);
    const brow = new THREE.Mesh(new RoundedBoxGeometry(0.48, 0.075, 0.075, 3, 0.025), technicalMaterial);
    brow.position.set(0, 0.23, -0.19);
    brow.rotation.x = -0.16;
    brow.castShadow = true;
    head.add(brow);
    const chin = new THREE.Mesh(new RoundedBoxGeometry(0.37, 0.105, 0.1, 3, 0.035), armorMaterial);
    chin.position.set(0, -0.24, -0.17);
    chin.rotation.x = 0.17;
    chin.castShadow = true;
    head.add(chin);
    for (const x of [-0.3, 0.3]) {
      const ear = new THREE.Mesh(new RoundedBoxGeometry(0.08, 0.2, 0.19, 3, 0.032), technicalMaterial);
      ear.position.set(x, 0.005, 0.015);
      head.add(ear);
    }
    const helmetLamp = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.075, 0.045, 2, 0.016), accentMaterial);
    helmetLamp.position.set(0.245, 0.205, -0.205);
    head.add(helmetLamp);
    const visorReflection = new THREE.Mesh(
      new RoundedBoxGeometry(0.08, 0.13, 0.008, 2, 0.004),
      new THREE.MeshBasicMaterial({ color: 0xc9f4ef, transparent: true, opacity: 0.24, depthWrite: false }),
    );
    visorReflection.position.set(-0.105, 0.075, -0.421);
    visorReflection.rotation.z = -0.22;
    head.add(visorReflection);

    const createArm = (side: number): THREE.Group => {
      const arm = new THREE.Group();
      arm.position.set(side * 0.42, 0.13, -0.01);
      const shoulder = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.22, 0.29, 3, 0.075), accentMaterial);
      shoulder.position.y = -0.04;
      shoulder.castShadow = true;
      arm.add(shoulder);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.23, 4, 9), armorMaterial);
      upper.position.y = -0.24;
      upper.castShadow = true;
      arm.add(upper);
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), technicalMaterial);
      elbow.position.y = -0.43;
      elbow.castShadow = true;
      arm.add(elbow);
      const forearm = new THREE.Group();
      forearm.position.y = -0.43;
      arm.userData.forearm = forearm;
      arm.add(forearm);
      const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.2, 4, 9), armorMaterial);
      lower.position.y = -0.18;
      lower.castShadow = true;
      forearm.add(lower);
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
      const hipPlate = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.22, 0.33, 3, 0.055), accentMaterial);
      hipPlate.position.set(side * 0.015, -0.06, 0);
      hipPlate.castShadow = true;
      hip.add(hipPlate);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.28, 4, 9), armorMaterial);
      thigh.position.y = -0.29;
      thigh.castShadow = true;
      hip.add(thigh);

      const knee = new THREE.Group();
      knee.position.y = -0.52;
      hip.add(knee);
      const kneeJoint = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 7), jointMaterial);
      kneeJoint.castShadow = true;
      knee.add(kneeJoint);
      const kneePlate = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.18, 0.13, 3, 0.042), accentMaterial);
      kneePlate.position.set(0, 0, -0.105);
      kneePlate.rotation.x = 0.18;
      kneePlate.castShadow = true;
      knee.add(kneePlate);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.26, 4, 9), armorMaterial);
      shin.position.y = -0.2;
      shin.castShadow = true;
      knee.add(shin);
      const shinPlate = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.25, 0.09, 3, 0.032), technicalMaterial);
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
      armorMaterial,
      accentMaterial,
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
    rig.armorMaterial.emissive.setHex(palette.glow);
    rig.accentMaterial.color.setHex(palette.accent);
    rig.accentMaterial.emissive.setHex(palette.glow);
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
    const primaryGrip = weapon.userData.primaryGrip as Vec3 | undefined;
    const supportGrip = weapon.userData.supportGrip as Vec3 | undefined;
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
    const owner = state.tower.turretOwnerId ? state.players[state.tower.turretOwnerId] : undefined;
    if (owner) this.towerTurret.rotation.y = owner.yaw;
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
      const origin = new THREE.Vector3(actor.position.x, actor.position.y + actor.height * 0.76, actor.position.z);
      const direction = new THREE.Vector3(
        -Math.sin(actor.yaw) * Math.cos(actor.pitch),
        Math.sin(actor.pitch),
        -Math.cos(actor.yaw) * Math.cos(actor.pitch),
      );
      const candidateEnd = event.position ? vectorFrom(event.position) : origin.clone().addScaledVector(direction, 18);
      const end = candidateEnd.distanceToSquared(origin) < 0.8
        ? origin.clone().addScaledVector(direction, 18)
        : candidateEnd;
      const geometry = new THREE.BufferGeometry().setFromPoints([origin, end]);
      const tint = event.weaponId ? WEAPONS[event.weaponId].tint : TEAM_COLORS[actor.team].glow;
      const material = new THREE.LineBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const line = new THREE.Line(geometry, material);
      const effect = new THREE.Group();
      effect.add(line);
      const flashMaterial = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const flash = new THREE.Mesh(new THREE.IcosahedronGeometry(0.115, 1), flashMaterial);
      flash.position.copy(origin).addScaledVector(direction, 0.48);
      flash.scale.set(0.72, 0.72, 1.9);
      flash.quaternion.setFromUnitVectors(FORWARD, direction);
      effect.add(flash);
      this.scene.add(effect);
      this.effects.push({
        object: effect,
        age: 0,
        duration: 0.085,
        update: (progress) => {
          material.opacity = (1 - progress) * 0.82;
          flashMaterial.opacity = (1 - progress) * 0.95;
          flash.scale.multiplyScalar(0.93);
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
        if (event.actorId === this.localPlayerId) this.weaponKick = 1;
      }
      return;
    }

    if (event.type === 'explosion') {
      const position = event.position ?? (event.targetId ? state.players[event.targetId]?.position : undefined);
      if (!position) return;
      const blast = new THREE.Group();
      blast.position.set(position.x, position.y, position.z);
      const coreMaterial = new THREE.MeshBasicMaterial({
        color: 0xffd6b2,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 2), coreMaterial);
      blast.add(core);
      const shellMaterial = new THREE.MeshBasicMaterial({
        color: 0xff856e,
        transparent: true,
        opacity: 0.44,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.72, 20, 12), shellMaterial);
      blast.add(shell);
      const shockMaterial = new THREE.MeshBasicMaterial({
        color: 0xff9e80,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const shock = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.035, 7, 32), shockMaterial);
      shock.rotation.x = Math.PI / 2;
      blast.add(shock);
      const light = new THREE.PointLight(0xff896f, 28, 9, 2);
      blast.add(light);
      this.scene.add(blast);
      this.effects.push({
        object: blast,
        age: 0,
        duration: 0.48,
        update: (progress) => {
          core.scale.setScalar(0.55 + progress * 4.2);
          shell.scale.setScalar(0.45 + progress * 6.3);
          shock.scale.setScalar(0.5 + progress * 7.4);
          coreMaterial.opacity = Math.max(0, 1 - progress * 1.8);
          shellMaterial.opacity = (1 - progress) * 0.44;
          shockMaterial.opacity = (1 - progress) * 0.72;
          light.intensity = (1 - progress) * (1 - progress) * 28;
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
      this.scene.remove(effect.object);
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

    if (firstPerson && localPlayer && localRig && alive) {
      const speed = Math.hypot(localPlayer.velocity.x, localPlayer.velocity.z);
      const bobAmount = localRig.moveBlend * localRig.groundBlend;
      const bobPhase = localRig.locomotionPhase;
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
        + Math.abs(Math.cos(bobPhase)) * 0.018 * bobAmount
        - landingWeight * 0.085
        + jumpWeight * 0.024;
      this.camera.position.x += Math.sin(bobPhase) * 0.011 * bobAmount;
      this.camera.rotation.set(
        localPlayer.pitch + Math.sin(worldTime * 58) * damageShake,
        localPlayer.yaw + Math.cos(worldTime * 47) * damageShake,
        Math.sin(bobPhase) * 0.0055 * bobAmount
          - localRig.strafeBlend * 0.006 * bobAmount
          + Math.sin(worldTime * 69) * damageShake * 0.35,
        'YXZ',
      );

      const activeWeapon = localPlayer.inventory[localPlayer.activeWeapon] ?? localPlayer.inventory[0];
      this.setViewWeapon(activeWeapon?.id ?? null);
      const palette = TEAM_COLORS[localPlayer.team];
      this.viewArmMaterial.color.setHex(palette.armor);
      this.viewModel.visible = true;

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
      const bobX = Math.sin(bobPhase) * 0.021 * bobAmount;
      const bobY = Math.abs(Math.cos(bobPhase)) * 0.016 * bobAmount;
      const airDrift = (1 - localRig.groundBlend) * THREE.MathUtils.clamp(localPlayer.velocity.y / 8, -1, 1);
      this.viewModel.position.set(
        0.31 + bobX,
        -0.28 - bobY - landingWeight * 0.06 + airDrift * 0.025,
        -0.62,
      );
      this.viewModel.rotation.set(
        -0.03 + landingWeight * 0.045,
        -0.045,
        0.012 - bobX * 0.32 - localRig.strafeBlend * 0.012 * bobAmount,
      );

      this.viewActionPivot.position.set(
        this.viewSwayYaw * 0.14 + (actionKind === 'melee' ? -actionPose.part * 0.08 : 0),
        this.viewSwayPitch * 0.1 - actionPose.lower * (actionKind === 'swap' ? 0.48 : 0.2) - recoil * 0.012,
        recoil * 0.07 + (actionKind === 'melee' ? -actionPose.part * 0.25 : 0),
      );
      this.viewActionPivot.rotation.set(
        this.viewSwayPitch
          + recoil * 0.11
          + (actionKind === 'melee' ? -0.58 * actionPose.part : 0.18 * actionPose.lower)
          + (actionKind === 'grenade' ? -0.34 * actionPose.part : 0),
        this.viewSwayYaw
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
    const radius = 46;
    const angle = this.elapsedRenderTime * 0.045 + 0.7;
    const desired = new THREE.Vector3(center.x + Math.cos(angle) * radius, 24, center.z + Math.sin(angle) * radius);
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

    const primaryGrip = weapon.userData.primaryGrip as Vec3 | undefined;
    const supportGrip = weapon.userData.supportGrip as Vec3 | undefined;
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
