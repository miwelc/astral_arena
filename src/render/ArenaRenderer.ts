import * as THREE from 'three';

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

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

const TEAM_COLORS: Record<Team, { armor: number; accent: number; glow: number }> = {
  aurora: { armor: 0x2c9f9c, accent: 0x8af1df, glow: 0x43f1d5 },
  nova: { armor: 0x76518f, accent: 0xd49bdc, glow: 0xd873c7 },
  neutral: { armor: 0x778c96, accent: 0xc4d8db, glow: 0x83c6cb },
};

interface PlayerRig {
  root: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  weaponMount: THREE.Group;
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
}

interface PickupVisual {
  root: THREE.Group;
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
  private readonly camera = new THREE.PerspectiveCamera(74, 1, 0.035, 240);
  private readonly clock = new THREE.Clock();
  private readonly playerRigs = new Map<string, PlayerRig>();
  private readonly pickupVisuals = new Map<string, PickupVisual>();
  private readonly projectileVisuals = new Map<string, ProjectileVisual>();
  private readonly flagVisuals = new Map<FlagState['team'], THREE.Group>();
  private readonly effects: TransientEffect[] = [];
  private readonly weaponTemplates = new Map<WeaponId, THREE.Group>();
  private readonly worldDecorations: THREE.Group[] = [];
  private readonly viewModel = new THREE.Group();
  private readonly viewWeaponMount = new THREE.Group();
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
  private elapsedRenderTime = 0;
  private disposed = false;

  public constructor(container: HTMLElement, map: MapDefinition) {
    this.container = container;
    this.map = map;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.container.append(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x8faeb9);
    this.scene.fog = new THREE.FogExp2(0x8ca9b3, 0.0082);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(44, 24, 42);
    this.camera.lookAt(0, 4, 0);
    this.scene.add(this.camera);

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.65));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    const overlayHeight = 0.125;
    this.damageOverlay?.scale.set(overlayHeight * this.camera.aspect, overlayHeight, 1);
  }

  public render(state: MatchState, alpha: number, firstPerson: boolean): void {
    if (this.disposed) return;

    const delta = Math.min(this.clock.getDelta(), 0.05);
    this.elapsedRenderTime += delta;
    const interpolation = clamp01(alpha);
    const worldTime = state.elapsed + interpolation / 60;

    this.syncPlayers(state, interpolation, worldTime, firstPerson);
    this.syncPickups(state.pickups, worldTime);
    this.syncFlags(state.config.mode === 'capture-the-flag' ? state.flags : [], state, worldTime);
    this.syncProjectiles(state.projectiles, worldTime);
    this.syncTower(state, worldTime);
    this.syncObjectiveVisibility(state);
    this.consumeEvents(state);
    this.updateEffects(delta);
    this.updateDecorations(worldTime);
    this.updateCamera(state, firstPerson, worldTime, delta);

    this.damagePulse = Math.max(0, this.damagePulse - delta * 2.65);
    this.weaponKick = Math.max(0, this.weaponKick - delta * 7.5);
    this.damageUniform.value = this.damagePulse * this.damagePulse * 0.78;
    this.renderer.toneMappingExposure = 1.06 - this.damagePulse * 0.12;
    this.skyMaterial.uniforms.uTime!.value = worldTime;

    this.renderer.render(this.scene, this.camera);
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
    for (const template of this.weaponTemplates.values()) collect(template);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();

    this.renderer.dispose();
    this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
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
          vec4 world = modelMatrix * vec4(position, 1.0);
          vDirection = normalize(world.xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDirection;
        uniform float uTime;

        float hash(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.yzx + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          float h = clamp(vDirection.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 horizon = vec3(0.50, 0.67, 0.72);
          vec3 middle = vec3(0.24, 0.42, 0.56);
          vec3 zenith = vec3(0.11, 0.19, 0.34);
          vec3 color = mix(horizon, middle, smoothstep(0.34, 0.69, h));
          color = mix(color, zenith, smoothstep(0.66, 1.0, h));

          vec3 sunDir = normalize(vec3(-0.55, 0.52, -0.65));
          float sun = pow(max(dot(vDirection, sunDir), 0.0), 420.0);
          float haze = pow(max(dot(vDirection, sunDir), 0.0), 9.0);
          color += vec3(0.78, 0.85, 0.78) * sun * 1.6;
          color += vec3(0.22, 0.37, 0.43) * haze * 0.35;

          float stars = step(0.9978, hash(floor(vDirection * 470.0 + uTime * 0.006)));
          stars *= smoothstep(0.64, 0.94, h) * 0.28;
          color += stars * vec3(0.72, 0.89, 1.0);
          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });

    const sky = new THREE.Mesh(new THREE.SphereGeometry(185, 32, 18), material);
    sky.renderOrder = -100;
    sky.frustumCulled = false;
    this.scene.add(sky);
    return material;
  }

  private createLighting(): void {
    const hemisphere = new THREE.HemisphereLight(0xb9e3eb, 0x304b58, 1.75);
    this.scene.add(hemisphere);

    const sun = new THREE.DirectionalLight(0xe5f2dc, 2.7);
    sun.position.set(-36, 52, 24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -48;
    sun.shadow.camera.right = 48;
    sun.shadow.camera.top = 42;
    sun.shadow.camera.bottom = -42;
    sun.shadow.camera.near = 8;
    sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.00045;
    sun.shadow.normalBias = 0.025;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8fa8ff, 0.52);
    fill.position.set(28, 18, -34);
    this.scene.add(fill);
  }

  private createLandscape(): void {
    const outerGround = new THREE.Mesh(
      new THREE.CircleGeometry(112, 64),
      new THREE.MeshStandardMaterial({
        color: 0x375b62,
        roughness: 1,
        metalness: 0,
        flatShading: true,
      }),
    );
    outerGround.rotation.x = -Math.PI / 2;
    outerGround.position.y = this.map.bounds.floorY - 0.22;
    outerGround.receiveShadow = true;
    this.scene.add(outerGround);

    const random = seededRandom(0x51f1e);
    const mountainMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x3f6470, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x4d6078, roughness: 1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x456f75, roughness: 1, flatShading: true }),
    ];

    for (let index = 0; index < 28; index += 1) {
      const angle = (index / 28) * Math.PI * 2 + (random() - 0.5) * 0.12;
      const distance = 67 + random() * 35;
      const radius = 7 + random() * 12;
      const height = 12 + random() * 26;
      const geometry = new THREE.ConeGeometry(radius, height, 5 + Math.floor(random() * 3), 2);
      const material = mountainMaterials[index % mountainMaterials.length]!;
      const mountain = new THREE.Mesh(geometry, material);
      mountain.position.set(Math.cos(angle) * distance, height * 0.5 - 1, Math.sin(angle) * distance);
      mountain.rotation.y = random() * Math.PI;
      mountain.scale.z = 0.65 + random() * 0.65;
      mountain.castShadow = index < 12;
      mountain.receiveShadow = true;
      this.scene.add(mountain);
    }

    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockMaterials = [
      new THREE.MeshStandardMaterial({ color: 0x50767b, roughness: 0.98, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x5d6883, roughness: 0.98, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x3e626c, roughness: 0.98, flatShading: true }),
    ];

    for (let index = 0; index < 46; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = 43 + random() * 38;
      const rock = new THREE.Mesh(rockGeometry, rockMaterials[index % rockMaterials.length]!);
      const scale = 0.55 + random() * 2.3;
      rock.position.set(Math.cos(angle) * distance, scale * 0.4 - 0.1, Math.sin(angle) * distance);
      rock.scale.set(scale * (0.7 + random() * 0.7), scale * (0.6 + random() * 0.5), scale);
      rock.rotation.set(random() * 0.5, random() * Math.PI, random() * 0.35);
      rock.castShadow = true;
      rock.receiveShadow = true;
      this.scene.add(rock);
    }

    for (let index = 0; index < 34; index += 1) {
      const angle = random() * Math.PI * 2;
      const distance = 42 + random() * 28;
      const plant = this.createPlant(random);
      plant.position.set(Math.cos(angle) * distance, this.map.bounds.floorY, Math.sin(angle) * distance);
      plant.rotation.y = random() * Math.PI * 2;
      const scale = 0.72 + random() * 1.35;
      plant.scale.setScalar(scale);
      plant.userData.swayPhase = random() * Math.PI * 2;
      this.worldDecorations.push(plant);
      this.scene.add(plant);
    }
  }

  private createPlant(random: () => number): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.16, 1.8, 5),
      new THREE.MeshStandardMaterial({ color: 0x31565b, roughness: 1, flatShading: true }),
    );
    trunk.position.y = 0.9;
    trunk.castShadow = true;
    group.add(trunk);

    const foliageMaterial = new THREE.MeshStandardMaterial({
      color: random() > 0.48 ? 0x4a8a83 : 0x557b92,
      roughness: 0.92,
      flatShading: true,
    });
    for (let level = 0; level < 3; level += 1) {
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(0.82 - level * 0.13, 1.35, 6),
        foliageMaterial,
      );
      crown.position.y = 1.35 + level * 0.52;
      crown.rotation.y = level * 0.55;
      crown.castShadow = true;
      group.add(crown);
    }
    return group;
  }

  private createMapGeometry(): void {
    const width = this.map.bounds.maxX - this.map.bounds.minX;
    const depth = this.map.bounds.maxZ - this.map.bounds.minZ;
    const floorGeometry = new THREE.PlaneGeometry(width, depth, 18, 15).toNonIndexed();
    const position = floorGeometry.getAttribute('position');
    const colors = new Float32Array(position.count * 3);
    const random = seededRandom(0xc001c0de);
    const shades = [new THREE.Color(0x557a7c), new THREE.Color(0x4d747a), new THREE.Color(0x607c83)];
    for (let triangle = 0; triangle < position.count; triangle += 3) {
      const color = shades[Math.floor(random() * shades.length)]!;
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const offset = (triangle + vertex) * 3;
        colors[offset] = color.r;
        colors[offset + 1] = color.g;
        colors[offset + 2] = color.b;
      }
    }
    floorGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    floorGeometry.computeVertexNormals();
    const floor = new THREE.Mesh(
      floorGeometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.02, flatShading: true }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(
      (this.map.bounds.minX + this.map.bounds.maxX) * 0.5,
      this.map.bounds.floorY - 0.035,
      (this.map.bounds.minZ + this.map.bounds.maxZ) * 0.5,
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

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
      const baseColor = new THREE.Color(obstacle.color);
      const material = new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: obstacle.kind === 'tower' ? 0.68 : 0.84,
        metalness: obstacle.kind === 'tower' ? 0.22 : 0.08,
        flatShading: true,
      });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
      mesh.position.copy(center);
      mesh.castShadow = obstacle.kind !== 'wall' || size.x < 10;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      const edgeColor = baseColor.clone().lerp(new THREE.Color(0xb4e2df), 0.28);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry, 22),
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.19 }),
      );
      edges.position.copy(center);
      this.scene.add(edges);

      if (obstacle.kind !== 'wall' && size.x > 1.4 && size.z > 1.4) {
        const top = new THREE.Mesh(
          new THREE.PlaneGeometry(size.x * 0.82, size.z * 0.82),
          new THREE.MeshBasicMaterial({
            color: baseColor.clone().lerp(new THREE.Color(0xa9d7d0), 0.2),
            transparent: true,
            opacity: 0.28,
            depthWrite: false,
          }),
        );
        top.rotation.x = -Math.PI / 2;
        top.position.set(center.x, obstacle.max.y + 0.008, center.z);
        this.scene.add(top);
      }
    }

    for (const x of [-9.6, 9.6]) {
      const position: Vec3 = { x, y: this.map.bounds.floorY, z: 0 };
      if (!isJumpPad(position)) continue;
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
      pad.position.set(x, this.map.bounds.floorY + 0.025, 0);
      pad.userData.spin = x < 0 ? 1 : -1;
      this.worldDecorations.push(pad as unknown as THREE.Group);
      this.scene.add(pad);
    }
  }

  private createObjectiveMarkers(): void {
    for (const team of ['aurora', 'nova'] as const) {
      const palette = TEAM_COLORS[team];
      const basePosition = this.map.flagBases[team];
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
      color: 0x1b3546,
      roughness: 0.58,
      metalness: 0.48,
    });
    const turretGlowMaterial = new THREE.MeshStandardMaterial({
      color: 0x7ee4dc,
      emissive: 0x3ccac2,
      emissiveIntensity: 1.2,
      roughness: 0.38,
      metalness: 0.5,
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.78, 0.62, 8), turretBaseMaterial);
    base.position.y = 0.31;
    base.castShadow = true;
    this.towerTurret.add(base);
    const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.52, 0.88), turretBaseMaterial);
    cradle.position.y = 0.77;
    cradle.castShadow = true;
    this.towerTurret.add(cradle);
    for (const x of [-0.25, 0.25]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.11, 1.9, 8), turretGlowMaterial);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(x, 0.88, -0.88);
      barrel.castShadow = true;
      this.towerTurret.add(barrel);
    }
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
    this.camera.add(this.viewModel);

    const gloveMaterial = new THREE.MeshStandardMaterial({
      color: 0xb7d4d2,
      roughness: 0.6,
      metalness: 0.18,
    });
    const rightForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.34, 4, 8), this.viewArmMaterial);
    rightForearm.rotation.x = Math.PI * 0.47;
    rightForearm.position.set(0.2, -0.09, 0.13);
    this.viewModel.add(rightForearm);
    const rightGlove = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.2), gloveMaterial);
    rightGlove.position.set(0.2, -0.02, -0.12);
    this.viewModel.add(rightGlove);

    const leftForearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.31, 4, 8), this.viewArmMaterial);
    leftForearm.rotation.x = Math.PI * 0.43;
    leftForearm.rotation.z = -0.2;
    leftForearm.position.set(-0.18, -0.08, -0.05);
    this.viewModel.add(leftForearm);
    const leftGlove = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.13, 0.18), gloveMaterial);
    leftGlove.position.set(-0.13, -0.02, -0.29);
    this.viewModel.add(leftGlove);

    this.viewModel.add(this.viewWeaponMount);
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
    this.camera.add(overlay);
    return overlay;
  }

  private syncPlayers(state: MatchState, alpha: number, worldTime: number, firstPerson: boolean): void {
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
        rig.previousPosition.copy(rig.targetPosition);
        vectorFrom(player.position, rig.targetPosition);
        rig.previousYaw = rig.targetYaw;
        rig.targetYaw = player.yaw;
        rig.lastTick = state.tick;
      }
      rig.root.position.lerpVectors(rig.previousPosition, rig.targetPosition, alpha);
      rig.root.rotation.y = lerpAngle(rig.previousYaw, rig.targetYaw, alpha);

      const horizontalSpeed = Math.hypot(player.velocity.x, player.velocity.z);
      const gait = worldTime * (5.8 + horizontalSpeed * 1.25) + (hashString(player.id) % 100) * 0.04;
      const stride = Math.sin(gait) * Math.min(horizontalSpeed / 5.5, 1) * (player.grounded ? 0.56 : 0.08);
      rig.leftLeg.rotation.x = stride;
      rig.rightLeg.rotation.x = -stride;
      rig.leftArm.rotation.x = -stride * 0.34;
      rig.rightArm.rotation.x = stride * 0.18;
      rig.torso.position.y = Math.abs(Math.sin(gait)) * Math.min(horizontalSpeed / 8, 1) * 0.035;
      rig.head.rotation.x = THREE.MathUtils.clamp(player.pitch * 0.35, -0.42, 0.42);

      const activeWeapon = player.inventory[player.activeWeapon] ?? player.inventory[0];
      const weaponId = activeWeapon?.id ?? null;
      if (weaponId !== rig.weaponId) this.setRigWeapon(rig, weaponId);

      const recentlyDamaged = state.elapsed - player.lastDamageAt < 0.22;
      rig.shield.visible = player.alive && player.shield > 0 && (recentlyDamaged || player.spawnProtection > 0);
      rig.shield.material.opacity = player.spawnProtection > 0
        ? 0.12 + Math.sin(worldTime * 12) * 0.035
        : 0.2;
      rig.shield.rotation.y = worldTime * 0.55;
      rig.juggernautRing.visible = player.alive && player.isJuggernaut;
      rig.juggernautRing.rotation.z = worldTime * 0.72;
      rig.armorMaterial.emissiveIntensity = player.isJuggernaut ? 0.42 + Math.sin(worldTime * 5) * 0.12 : 0.08;
      rig.accentMaterial.emissiveIntensity = player.isJuggernaut ? 1.25 : 0.48;
      rig.root.visible = player.alive && !(firstPerson && player.id === this.localPlayerId);
    }

    for (const [id, rig] of this.playerRigs) {
      if (present.has(id)) continue;
      rig.weaponMount.clear();
      this.scene.remove(rig.root);
      disposeObject(rig.root);
      this.playerRigs.delete(id);
    }
  }

  private syncObjectiveVisibility(state: MatchState): void {
    for (const decoration of this.worldDecorations) {
      if (typeof decoration.userData.teamBeacon === 'string') decoration.visible = state.config.mode === 'capture-the-flag';
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

    const armorMaterial = new THREE.MeshStandardMaterial({
      color: palette.armor,
      emissive: palette.glow,
      emissiveIntensity: 0.08,
      roughness: 0.5,
      metalness: 0.26,
      flatShading: true,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      emissive: palette.glow,
      emissiveIntensity: 0.48,
      roughness: 0.38,
      metalness: 0.32,
      flatShading: true,
    });
    const jointMaterial = new THREE.MeshStandardMaterial({ color: 0x172a35, roughness: 0.7, metalness: 0.42 });
    const visorMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x0c2637,
      emissive: 0x174c62,
      emissiveIntensity: 0.7,
      roughness: 0.08,
      metalness: 0.72,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
    });

    const torso = new THREE.Group();
    torso.position.y = 0;
    root.add(torso);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 0.46, 4, 8), armorMaterial);
    chest.scale.set(1.02, 1, 0.72);
    chest.position.y = 1.13;
    chest.castShadow = true;
    torso.add(chest);
    const chestPlate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, 0.12), accentMaterial);
    chestPlate.position.set(0, 1.18, -0.29);
    chestPlate.rotation.x = -0.08;
    chestPlate.castShadow = true;
    torso.add(chestPlate);
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.56, 0.24), jointMaterial);
    backpack.position.set(0, 1.14, 0.3);
    backpack.castShadow = true;
    torso.add(backpack);
    for (const x of [-0.18, 0.18]) {
      const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.42, 7), accentMaterial);
      canister.position.set(x, 1.13, 0.44);
      canister.castShadow = true;
      torso.add(canister);
    }

    const head = new THREE.Group();
    // Match the simulation's head hit-volume (height * 0.86) closely.
    head.position.y = 1.55;
    root.add(head);
    const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 2), armorMaterial);
    helmet.scale.set(0.94, 1.02, 0.93);
    helmet.castShadow = true;
    head.add(helmet);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.272, 16, 9, 0, Math.PI * 2, 0.15, 1.75), visorMaterial);
    visor.scale.set(1, 0.72, 0.42);
    visor.position.set(0, 0.015, -0.29);
    visor.rotation.x = Math.PI * 0.5;
    head.add(visor);
    const helmetLamp = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.045), accentMaterial);
    helmetLamp.position.set(0.24, 0.19, -0.19);
    head.add(helmetLamp);

    const createArm = (side: number): THREE.Group => {
      const arm = new THREE.Group();
      arm.position.set(side * 0.42, 1.38, 0);
      const shoulder = new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 1), accentMaterial);
      shoulder.scale.set(1, 0.88, 0.94);
      shoulder.castShadow = true;
      arm.add(shoulder);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.3, 3, 7), armorMaterial);
      upper.position.y = -0.27;
      upper.rotation.z = side * -0.08;
      upper.castShadow = true;
      arm.add(upper);
      const glove = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.22), jointMaterial);
      glove.position.set(side * 0.02, -0.53, -0.04);
      glove.castShadow = true;
      arm.add(glove);
      return arm;
    };
    const leftArm = createArm(-1);
    const rightArm = createArm(1);
    torso.add(leftArm, rightArm);

    const createLeg = (side: number): THREE.Group => {
      const leg = new THREE.Group();
      leg.position.set(side * 0.18, 0.95, 0);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.34, 3, 7), armorMaterial);
      thigh.position.y = -0.22;
      thigh.castShadow = true;
      leg.add(thigh);
      const knee = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.2, 0.15), accentMaterial);
      knee.position.set(0, -0.48, -0.1);
      knee.rotation.x = 0.18;
      knee.castShadow = true;
      leg.add(knee);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.29, 3, 7), armorMaterial);
      shin.position.y = -0.68;
      shin.castShadow = true;
      leg.add(shin);
      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.18, 0.4), jointMaterial);
      boot.position.set(0, -0.9, -0.08);
      boot.castShadow = true;
      leg.add(boot);
      return leg;
    };
    const leftLeg = createLeg(-1);
    const rightLeg = createLeg(1);
    root.add(leftLeg, rightLeg);

    const weaponMount = new THREE.Group();
    weaponMount.position.set(0.34, 1.08, -0.37);
    torso.add(weaponMount);

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
    root.add(shield);

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
    root.add(juggernautRing);

    const initial = vectorFrom(player.position);
    return {
      root,
      torso,
      head,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      weaponMount,
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
    rig.weaponMount.clear();
    rig.weaponId = id;
    if (!id) return;
    const model = this.getWeaponTemplate(id).clone(true);
    model.scale.setScalar(0.72);
    model.rotation.x = -0.08;
    rig.weaponMount.add(model);
  }

  private getWeaponTemplate(id: WeaponId): THREE.Group {
    const cached = this.weaponTemplates.get(id);
    if (cached) return cached;

    const definition = WEAPONS[id];
    const group = new THREE.Group();
    group.name = `weapon-${id}`;
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x263947,
      roughness: 0.42,
      metalness: 0.58,
      flatShading: true,
    });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x101e28, roughness: 0.58, metalness: 0.62 });
    const glowMaterial = new THREE.MeshStandardMaterial({
      color: definition.tint,
      emissive: definition.tint,
      emissiveIntensity: 1.25,
      roughness: 0.28,
      metalness: 0.4,
    });

    const addBox = (
      size: [number, number, number],
      position: [number, number, number],
      material: THREE.Material = bodyMaterial,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
      mesh.position.set(...position);
      mesh.castShadow = true;
      group.add(mesh);
      return mesh;
    };

    if (id === 'sidearm') {
      addBox([0.24, 0.22, 0.72], [0, 0, -0.2]);
      addBox([0.16, 0.07, 0.56], [0, 0.145, -0.23], glowMaterial);
      const grip = addBox([0.19, 0.45, 0.22], [0, -0.28, 0.02], darkMaterial);
      grip.rotation.x = -0.18;
    } else if (id === 'rocket-launcher') {
      for (const x of [-0.19, 0.19]) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 1.35, 10), bodyMaterial);
        tube.rotation.x = Math.PI / 2;
        tube.position.set(x, 0.02, -0.35);
        tube.castShadow = true;
        group.add(tube);
        const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.035, 6, 12), glowMaterial);
        muzzle.position.set(x, 0.02, -1.03);
        group.add(muzzle);
      }
      addBox([0.62, 0.22, 0.4], [0, -0.1, 0.12], darkMaterial);
      addBox([0.17, 0.44, 0.2], [0.18, -0.3, 0.11], bodyMaterial);
    } else {
      const length = id === 'sniper' ? 1.72 : id === 'shotgun' ? 1.22 : 1.3;
      const height = id === 'shotgun' ? 0.31 : 0.27;
      addBox([0.31, height, length], [0, 0, -length * 0.35]);
      addBox([0.23, 0.1, length * 0.72], [0, height * 0.58, -length * 0.47], glowMaterial);
      addBox([0.18, 0.48, 0.22], [0.08, -0.28, 0.02], darkMaterial).rotation.x = -0.16;
      addBox([0.25, 0.22, 0.52], [0, -0.02, 0.35], darkMaterial);

      if (id === 'sniper') {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1.2, 8), darkMaterial);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.02, -1.42);
        group.add(barrel);
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.58, 10), glowMaterial);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.27, -0.52);
        group.add(scope);
      } else if (id === 'shotgun') {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.84, 10), darkMaterial);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.01, -1.1);
        group.add(barrel);
        addBox([0.34, 0.25, 0.37], [0, -0.06, -0.66], glowMaterial);
      } else if (id === 'battle-rifle') {
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.4, 9), glowMaterial);
        scope.rotation.x = Math.PI / 2;
        scope.position.set(0, 0.23, -0.46);
        group.add(scope);
      }
    }

    group.traverse((object) => {
      object.frustumCulled = false;
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
        visual.baseY + Math.sin(worldTime * 2.15 + visual.phase) * 0.13,
        pickup.position.z,
      );
      visual.root.rotation.y = worldTime * 0.72 + visual.phase;
    }
    for (const [id, visual] of this.pickupVisuals) {
      if (!present.has(id)) visual.root.visible = false;
    }
  }

  private createPickup(pickup: PickupState): PickupVisual {
    const root = new THREE.Group();
    const glowColor = pickup.weaponId ? WEAPONS[pickup.weaponId].tint : pickup.kind === 'overshield' ? 0x65f1e5 : 0x9ebfd2;
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
    root.add(ring);

    if (pickup.kind === 'weapon' && pickup.weaponId) {
      const weapon = this.getWeaponTemplate(pickup.weaponId).clone(true);
      weapon.scale.setScalar(0.48);
      weapon.rotation.z = 0.18;
      weapon.position.y = 0.17;
      root.add(weapon);
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
      root.add(core);
      const shell = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.42, 1),
        new THREE.MeshBasicMaterial({ color: 0x9ffff3, wireframe: true, transparent: true, opacity: 0.4 }),
      );
      shell.position.y = 0.18;
      root.add(shell);
    } else if (pickup.kind === 'grenade') {
      const grenade = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.25, 1),
        new THREE.MeshStandardMaterial({ color: 0x466d6f, roughness: 0.54, metalness: 0.42 }),
      );
      grenade.position.y = 0.16;
      root.add(grenade);
      const cap = new THREE.Mesh(
        new THREE.TorusGeometry(0.1, 0.025, 5, 10),
        new THREE.MeshStandardMaterial({ color: 0xb3ded5, metalness: 0.6, roughness: 0.3 }),
      );
      cap.position.y = 0.43;
      cap.rotation.x = Math.PI / 2;
      root.add(cap);
    } else {
      const crate = new THREE.Mesh(
        new THREE.BoxGeometry(0.58, 0.34, 0.42),
        new THREE.MeshStandardMaterial({ color: 0x395461, roughness: 0.58, metalness: 0.38 }),
      );
      crate.position.y = 0.12;
      root.add(crate);
      for (const x of [-0.18, 0, 0.18]) {
        const cell = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.19, 0.45),
          new THREE.MeshStandardMaterial({ color: 0x8dc5c7, emissive: 0x416c76, emissiveIntensity: 0.6 }),
        );
        cell.position.set(x, 0.14, -0.02);
        root.add(cell);
      }
    }

    root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.castShadow = true;
    });
    root.position.set(pickup.position.x, pickup.position.y, pickup.position.z);
    return { root, baseY: pickup.position.y, phase: (hashString(pickup.id) % 628) / 100 };
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
      this.scene.add(line);
      this.effects.push({
        object: line,
        age: 0,
        duration: 0.085,
        update: (progress) => {
          material.opacity = (1 - progress) * 0.82;
        },
      });
      if (event.actorId === this.localPlayerId) this.weaponKick = 1;
      return;
    }

    if (event.type === 'explosion') {
      const position = event.position ?? (event.targetId ? state.players[event.targetId]?.position : undefined);
      if (!position) return;
      const material = new THREE.MeshBasicMaterial({
        color: 0xff856e,
        transparent: true,
        opacity: 0.82,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const blast = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), material);
      blast.position.set(position.x, position.y, position.z);
      this.scene.add(blast);
      this.effects.push({
        object: blast,
        age: 0,
        duration: 0.48,
        update: (progress) => {
          blast.scale.setScalar(0.35 + progress * 5.8);
          material.opacity = (1 - progress) * 0.82;
        },
      });
      return;
    }

    if (event.type === 'hit' || event.type === 'shield-break' || event.type === 'melee') {
      const position = event.position ?? (event.targetId ? state.players[event.targetId]?.position : undefined);
      if (!position) return;
      const material = new THREE.MeshBasicMaterial({
        color: event.type === 'shield-break' ? 0x73f4ee : 0xe4b3d8,
        transparent: true,
        opacity: 0.68,
        wireframe: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const ripple = new THREE.Mesh(new THREE.SphereGeometry(0.48, 12, 8), material);
      const verticalOffset = event.type === 'hit' ? 0 : 0.9;
      ripple.position.set(position.x, position.y + verticalOffset, position.z);
      this.scene.add(ripple);
      this.effects.push({
        object: ripple,
        age: 0,
        duration: 0.24,
        update: (progress) => {
          ripple.scale.setScalar(0.6 + progress * 1.8);
          material.opacity = (1 - progress) * 0.68;
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
        decoration.rotation.z = Math.sin(worldTime * 0.7 + decoration.userData.swayPhase) * 0.018;
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
      const bobAmount = localPlayer.grounded ? Math.min(speed / 7, 1) : 0;
      const bobPhase = worldTime * (7.2 + speed * 0.45);
      const damageShake = this.damagePulse * 0.018;
      const eyeHeight = localPlayer.height * 0.86;
      this.camera.position.copy(localRig.root.position);
      this.camera.position.y += eyeHeight + Math.sin(bobPhase * 2) * 0.018 * bobAmount;
      this.camera.position.x += Math.sin(bobPhase) * 0.01 * bobAmount;
      this.camera.rotation.set(
        localPlayer.pitch + Math.sin(worldTime * 58) * damageShake,
        localPlayer.yaw + Math.cos(worldTime * 47) * damageShake,
        Math.sin(bobPhase) * 0.004 * bobAmount + Math.sin(worldTime * 69) * damageShake * 0.35,
        'YXZ',
      );

      const activeWeapon = localPlayer.inventory[localPlayer.activeWeapon] ?? localPlayer.inventory[0];
      this.setViewWeapon(activeWeapon?.id ?? null);
      const palette = TEAM_COLORS[localPlayer.team];
      this.viewArmMaterial.color.setHex(palette.armor);
      this.viewModel.visible = true;
      const bobX = Math.sin(bobPhase) * 0.018 * bobAmount;
      const bobY = Math.abs(Math.cos(bobPhase)) * 0.014 * bobAmount;
      this.viewModel.position.set(0.31 + bobX, -0.28 - bobY - this.weaponKick * 0.012, -0.62 + this.weaponKick * 0.055);
      this.viewModel.rotation.set(
        -0.03 + this.weaponKick * 0.09,
        -0.045 - this.weaponKick * 0.025,
        0.012 - bobX * 0.28,
      );
      return;
    }

    this.viewModel.visible = false;
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
    if (!id) return;
    const weapon = this.getWeaponTemplate(id).clone(true);
    weapon.scale.setScalar(0.54);
    weapon.position.set(0.01, 0.03, -0.09);
    this.viewWeaponMount.add(weapon);
  }
}
