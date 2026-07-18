export type GameMode = 'deathmatch' | 'team-deathmatch' | 'capture-the-flag' | 'juggernaut' | 'towah-of-powah';
export type MatchFormat = 'duel' | 'squads';
export type Difficulty = 'recruit' | 'veteran' | 'legend';
export type Team = 'aurora' | 'nova' | 'neutral';
export type PlayerKind = 'human' | 'bot' | 'remote';
export type WeaponId = 'pulse-rifle' | 'sidearm' | 'battle-rifle' | 'sniper' | 'shotgun' | 'rocket-launcher';
export type PickupKind = 'weapon' | 'overshield' | 'ammo' | 'grenade';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MatchConfig {
  mode: GameMode;
  format: MatchFormat;
  difficulty: Difficulty;
  scoreLimit: number;
  timeLimitSeconds: number;
  botFill: boolean;
  playerName: string;
  mapId: 'crater-ridge';
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
}

export interface WeaponState {
  id: WeaponId;
  magazine: number;
  reserve: number;
  cooldown: number;
  reloadTimer: number;
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
  input: PlayerInput;
  lastProcessedInput: number;
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
  waypointIndex: number;
  reactionTimer: number;
  aimError: Vec3;
  preferredRange: number;
  objective: 'attack' | 'defend' | 'pickup' | 'flag' | 'tower';
  lastPosition: Vec3 | null;
  stuckTimer: number;
  unstickTimer: number;
}

export interface ProjectileState {
  id: string;
  kind: 'rocket' | 'grenade';
  ownerId: string;
  team: Team;
  position: Vec3;
  velocity: Vec3;
  radius: number;
  damage: number;
  blastRadius: number;
  fuse: number;
  alive: boolean;
}

export interface PickupState {
  id: string;
  kind: PickupKind;
  position: Vec3;
  weaponId?: WeaponId;
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
  turretOwnerId: string | null;
  turretCooldown: number;
}

export interface GameEvent {
  id: number;
  time: number;
  type: 'shot' | 'hit' | 'shield-break' | 'kill' | 'respawn' | 'pickup' | 'reload' | 'flag' | 'score' | 'explosion' | 'melee' | 'match-end';
  actorId?: string;
  targetId?: string;
  weaponId?: WeaponId;
  position?: Vec3;
  message?: string;
  amount?: number;
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
  magazineSize: number;
  startingReserve: number;
  maxReserve: number;
  reloadSeconds: number;
  range: number;
  spread: number;
  pellets: number;
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

export interface MapDefinition {
  id: MatchConfig['mapId'];
  name: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number; floorY: number; ceilingY: number };
  obstacles: AabbObstacle[];
  spawns: SpawnPoint[];
  waypoints: Vec3[];
  pickups: Omit<PickupState, 'available' | 'respawnTimer'>[];
  flagBases: Record<Exclude<Team, 'neutral'>, Vec3>;
  towerCenter: Vec3;
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
  serverTime: number;
  acknowledgedInputs: Record<string, number>;
  state: MatchState;
}

export type ClientMessage =
  | { kind: 'hello'; name: string; protocol: 1 }
  | { kind: 'input'; playerId: string; input: PlayerInput }
  | { kind: 'ready'; playerId: string }
  | { kind: 'ping'; sentAt: number };

export type HostMessage =
  | SerializedSnapshot
  | { kind: 'welcome'; playerId: string; config: MatchConfig; protocol: 1 }
  | { kind: 'pong'; sentAt: number; serverAt: number }
  | { kind: 'error'; message: string };
