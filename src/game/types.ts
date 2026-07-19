export type GameMode = 'deathmatch' | 'team-deathmatch' | 'capture-the-flag' | 'juggernaut' | 'towah-of-powah';
export type MatchFormat = 'duel' | 'squads';
export type Difficulty = 'recruit' | 'veteran' | 'legend';
export type Team = 'aurora' | 'nova' | 'neutral';
export type PlayerKind = 'human' | 'bot' | 'remote';
export type WeaponId = 'pulse-rifle' | 'sidearm' | 'battle-rifle' | 'sniper' | 'shotgun' | 'rocket-launcher';
export type PickupKind = 'weapon' | 'overshield' | 'ammo' | 'grenade';
export const GAME_PROTOCOL_VERSION = 5 as const;
export const PLAYER_PITCH_LIMIT = 1.48;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MatchConfig {
  mode: GameMode;
  format: MatchFormat;
  /** Authoritative roster size. Deathmatch accepts 2-8; authored team modes use 8. */
  playerCount: number;
  difficulty: Difficulty;
  scoreLimit: number;
  timeLimitSeconds: number;
  botFill: boolean;
  playerName: string;
  mapId: 'crater-ridge' | 'umbra-station';
}

export interface PlayerInput {
  sequence: number;
  moveX: number;
  moveZ: number;
  yaw: number;
  pitch: number;
  fire: boolean;
  aim: boolean;
  jump: boolean;
  reload: boolean;
  swap: boolean;
  melee: boolean;
  grenade: boolean;
  /** Held stance control. Crouched movement stays off the motion tracker. */
  crouch: boolean;
  /** Context action: take a weapon or enter/leave an emplaced turret. */
  use: boolean;
}

/** Authoritative state required to predict jump-pad movement without drift. */
export interface PlayerMovementMemory {
  jumpPadReadyAt: number;
  jumpPadMomentum: {
    direction: Vec3;
    minimumSpeed: number;
  } | null;
}

export interface WeaponState {
  id: WeaponId;
  magazine: number;
  reserve: number;
  cooldown: number;
  reloadTimer: number;
  /** Normalized firing error used by both authoritative spread and the reticle. */
  bloom: number;
  /** Follow-up rounds still owed by a burst weapon. */
  burstRemaining: number;
  /** Zero-based authored spread index for the next round in the active burst. */
  burstRoundIndex: number;
  /** Seconds until the next round in the current burst. */
  burstTimer: number;
}

export interface PlayerState {
  id: string;
  name: string;
  kind: PlayerKind;
  team: Team;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  radius: number;
  height: number;
  crouched: boolean;
  grounded: boolean;
  alive: boolean;
  health: number;
  shield: number;
  maxShield: number;
  overshieldDecayDelay: number;
  lastDamageAt: number;
  respawnTimer: number;
  spawnProtection: number;
  inventory: WeaponState[];
  activeWeapon: number;
  grenades: number;
  meleeCooldown: number;
  grenadeCooldown: number;
  /** Brief draw delay after changing weapons; prevents same-tick swap shots. */
  equipTimer: number;
  /** Damage breaks smart-link zoom until the player releases the aim control. */
  aimSuppressed: boolean;
  input: PlayerInput;
  lastProcessedInput: number;
  movementMemory: PlayerMovementMemory;
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  streak: number;
  isJuggernaut: boolean;
  carryingFlagTeam: Team | null;
  bot?: BotMemory;
}

export interface BotMemory {
  difficulty: Difficulty;
  decisionTimer: number;
  targetId: string | null;
  lastSeenPosition: Vec3 | null;
  lastSeenAt: number;
  /** Countdown until the next deliberate motion-tracker glance. */
  radarGlanceTimer: number;
  /** Radar is sampled, not tracked continuously; this identifies the sampled contact. */
  radarContactId: string | null;
  /** Noisy position captured at the last glance and never updated between glances. */
  radarContactPosition: Vec3 | null;
  radarContactAt: number;
  waypointIndex: number;
  /** Stable authored route through a multi-level map's waypoint graph. */
  navigationRoute: number[];
  navigationCursor: number;
  navigationGoalIndex: number | null;
  reactionTimer: number;
  aimError: Vec3;
  preferredRange: number;
  objective: 'attack' | 'defend' | 'pickup' | 'flag' | 'tower';
  lastPosition: Vec3 | null;
  stuckTimer: number;
  unstickTimer: number;
  /** Pickup currently pursued; persisted so navigation can measure real progress. */
  pickupTargetId: string | null;
  pickupBestDistance: number;
  pickupProgressAt: number;
  /** Recently unreachable or unusable pickups, with simulation-time retry deadlines. */
  pickupBlacklist: Array<{ pickupId: string; retryAt: number }>;
}

export interface ProjectileState {
  id: string;
  kind: 'rocket' | 'grenade' | 'bullet';
  ownerId: string;
  team: Team;
  /** Present for lightweight ballistic rounds such as the battle rifle. */
  weaponId?: WeaponId;
  position: Vec3;
  velocity: Vec3;
  radius: number;
  damage: number;
  blastRadius: number;
  /** Grenades start their fuse on the first surface impact; other rounds are armed immediately. */
  armed: boolean;
  fuse: number;
  alive: boolean;
}

export interface PickupState {
  id: string;
  kind: PickupKind;
  position: Vec3;
  weaponId?: WeaponId;
  /** Exact ammunition retained by a weapon dropped on death. */
  weaponState?: WeaponState;
  /** Number of grenades granted; fixed grenade racks carry a pair. */
  amount: number;
  /** Temporary death drops are removed instead of entering a respawn cycle. */
  temporary: boolean;
  despawnTimer: number;
  available: boolean;
  respawnTimer: number;
  respawnSeconds: number;
}

export interface FlagState {
  team: Exclude<Team, 'neutral'>;
  basePosition: Vec3;
  position: Vec3;
  status: 'home' | 'carried' | 'dropped';
  carrierId: string | null;
  returnTimer: number;
}

export interface TowerState {
  center: Vec3;
  radius: number;
  controllingTeam: Team;
  /** Player currently operating the turret; null means the turret cannot fire. */
  turretOwnerId: string | null;
  turretYaw: number;
  turretPitch: number;
  turretCooldown: number;
}

export interface GameEvent {
  id: number;
  time: number;
  type:
    | 'shot'
    | 'hit'
    | 'shield-break'
    | 'shield-recharge-start'
    | 'shield-recharge-complete'
    | 'kill'
    | 'respawn'
    | 'pickup'
    | 'reload'
    | 'flag'
    | 'score'
    | 'explosion'
    | 'melee'
    | 'match-end';
  actorId?: string;
  /** Team captured at event time, retained even if the actor disconnects. */
  actorTeam?: Team;
  targetId?: string;
  weaponId?: WeaponId;
  position?: Vec3;
  /** World-space origin of incoming damage, retained for directional HUD feedback. */
  sourcePosition?: Vec3;
  /** True when a shot endpoint is an actual world/player impact, not max range. */
  impact?: boolean;
  /** Authoritative pellet/burst endpoints used to render the same cone that dealt damage. */
  traces?: Vec3[];
  message?: string;
  amount?: number;
  /** Authoritative damage classification for audiovisual feedback and medals. */
  headshot?: boolean;
  fatal?: boolean;
  shieldDamage?: number;
  healthDamage?: number;
  backStrike?: boolean;
  explosionKind?: 'rocket' | 'grenade';
  radius?: number;
  flagTeam?: Exclude<Team, 'neutral'>;
  flagAction?: 'taken' | 'dropped' | 'returned' | 'captured';
}

export interface MatchState {
  version: 1;
  matchId: string;
  config: MatchConfig;
  tick: number;
  elapsed: number;
  timeRemaining: number;
  phase: 'countdown' | 'playing' | 'finished';
  countdown: number;
  winner: Team | string | null;
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
  pickups: PickupState[];
  flags: FlagState[];
  tower: TowerState;
  teamScores: Record<Exclude<Team, 'neutral'>, number>;
  juggernautId: string | null;
  eventSequence: number;
  events: GameEvent[];
  randomState: number;
}

export interface WeaponDefinition {
  id: WeaponId;
  label: string;
  role: string;
  automatic: boolean;
  fireInterval: number;
  damage: number;
  headMultiplier: number;
  /** Precision hits execute once base damage reaches health; bonus only multiplies exposed health. */
  headshotMode: 'none' | 'bonus' | 'precision';
  magazineSize: number;
  startingReserve: number;
  maxReserve: number;
  reloadSeconds: number;
  range: number;
  /** Minimum and maximum half-angle of the shot cone, in radians. */
  spread: number;
  maxSpread: number;
  /** Normalized bloom added per round and recovered per second. */
  bloomPerShot: number;
  bloomRecovery: number;
  pellets: number;
  burstCount?: number;
  burstInterval?: number;
  /** Optional authored per-round error for a burst, in radians. */
  burstSpread?: readonly number[];
  /** Units per second for a lightweight ballistic round; absent means hitscan. */
  ballisticSpeed?: number;
  reloadStyle?: 'magazine' | 'shell';
  /** Smart-link optical FOV steps. Absence means the weapon does not zoom. */
  zoomFov?: readonly number[];
  magnetismAngle?: number;
  magnetismRange?: number;
  damageFalloffStart?: number;
  damageFalloffEnd?: number;
  minimumDamageScale?: number;
  recoil: number;
  projectile?: 'rocket';
  splashRadius?: number;
  tint: number;
}

export interface AabbObstacle {
  id: string;
  min: Vec3;
  max: Vec3;
  kind: 'wall' | 'platform' | 'tower' | 'cover';
  color: number;
}

export interface SpawnPoint {
  position: Vec3;
  yaw: number;
  team: Team;
}

export interface JumpPadZone {
  id: string;
  center: Vec3;
  halfSize: { x: number; z: number };
  /** Suggested launch velocity. Simulation may refine it for the destination. */
  launchVelocity: Vec3;
}

export type NavigationTraversal = 'walk' | 'jump' | 'drop' | 'launch';

export interface WaypointLink {
  from: number;
  to: number;
  traversal: NavigationTraversal;
  /** Most corridors and stair flights are safe in both directions. */
  bidirectional: boolean;
}

export interface MapDefinition {
  id: MatchConfig['mapId'];
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; floorY: number; ceilingY: number };
  obstacles: AabbObstacle[];
  spawns: SpawnPoint[];
  waypoints: Vec3[];
  /**
   * Optional directed navigation graph over `waypoints`; bidirectional links
   * opt into their reverse edge. Stacked maps should author this so bots do
   * not mistake a visible deck for a directly walkable destination.
   */
  waypointLinks?: WaypointLink[];
  jumpPads: JumpPadZone[];
  pickups: Omit<PickupState, 'available' | 'respawnTimer' | 'weaponState' | 'amount' | 'temporary' | 'despawnTimer'>[];
  flagBases: Record<Exclude<Team, 'neutral'>, Vec3>;
  towerCenter: Vec3;
  towerZone: {
    radius: number;
    controlMinY: number;
    patrolRadius: number;
  };
}

export interface RayHit {
  distance: number;
  point: Vec3;
  playerId?: string;
  headshot?: boolean;
  obstacleId?: string;
}

export interface SerializedSnapshot {
  kind: 'snapshot';
  state: MatchState;
}

export type ClientMessage =
  | { kind: 'hello'; name: string; protocol: typeof GAME_PROTOCOL_VERSION }
  | { kind: 'input'; input: PlayerInput }
  | { kind: 'ping'; sentAt: number };

export type HostMessage =
  | SerializedSnapshot
  | { kind: 'welcome'; playerId: string; protocol: typeof GAME_PROTOCOL_VERSION }
  | { kind: 'pong'; sentAt: number }
  | { kind: 'error'; message: string };
