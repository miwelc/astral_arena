import { canOccupyCapsule, hasLineOfSight, raycastWorld } from './collision';
import { MAPS, TOWER_TURRET_LAYOUT } from './map';
import { canonicalFormatForMode, isTeamGameMode, rulesForMode } from './modeRules';
import { damageScaleAtDistance, sampleDirectionInCone, shotSpread } from './gunplay';
import {
  add,
  clamp,
  cloneVec3,
  directionFromAngles,
  distance,
  distanceSquared,
  dot,
  emptyInput,
  hashString,
  moveAngleToward,
  normalize,
  randomRange,
  scale,
  subtract,
  vec3,
  wrapAngle,
} from './math';
import { PLAYER_PITCH_LIMIT } from './types';
import type {
  Difficulty,
  GameEvent,
  MapDefinition,
  MatchConfig,
  MatchState,
  PlayerInput,
  PlayerKind,
  PlayerState,
  PickupState,
  ProjectileState,
  Team,
  Vec3,
  WeaponId,
} from './types';
import { createWeaponState, DEFAULT_LOADOUT, TOWER_LOADOUT, WEAPONS } from './weapons';
import { createBotMemory, updateBotInputs } from './bots';
import {
  advancePlayerMovement,
  createPlayerMovementMemory,
  STANDING_PLAYER_HEIGHT,
} from './playerMovement';

export { PLAYER_MOVEMENT_TUNING } from './playerMovement';

const FIXED_PLAYER_HEIGHT = STANDING_PLAYER_HEIGHT;
const FIXED_PLAYER_RADIUS = 0.48;
const PROJECTILE_GRAVITY = 18;
export const MAX_PLAYER_GRENADES = 2;
export const DROPPED_PICKUP_LIFETIME_SECONDS = 20;
const SHIELD_RECHARGE_DELAY = 5;
const SHIELD_RECHARGE_RATE = 100 / 1.75;
const MAX_HEALTH = 70;
const HEALTH_RECHARGE_DELAY = 10;
const HEALTH_RECHARGE_RATE = 14;
const WEAPON_EQUIP_SECONDS = 0.42;
const MELEE_DAMAGE = 100;
const MELEE_LUNGE_RANGE = 2.55;
const GRENADE_FUSE_SECONDS = 1.4;
const GRENADE_DAMAGE = 225;
const GRENADE_OWNER_GRACE_SECONDS = 0.22;
const BOT_NAMES = ['Orion', 'Vega', 'Lyra', 'Atlas', 'Sol', 'Mira', 'Pulsar', 'Cosmo'];
const PRIORITY_EVENT_TYPES = new Set<GameEvent['type']>([
  'kill',
  'flag',
  'score',
  'match-end',
  'shield-recharge-start',
  'shield-recharge-complete',
]);

interface ButtonState {
  fire: boolean;
  jump: boolean;
  reload: boolean;
  swap: boolean;
  melee: boolean;
  grenade: boolean;
  use: boolean;
}

interface DamageOptions {
  weaponId?: WeaponId;
  position?: Vec3;
  sourcePosition?: Vec3;
  headshot?: boolean;
  headshotFraction?: number;
  headshotMode?: 'none' | 'bonus' | 'precision';
  headMultiplier?: number;
  backStrike?: boolean;
  /** The target was vulnerable when a same-tick melee was committed. */
  bypassSpawnProtection?: boolean;
}

interface DamageResult {
  shieldDamage: number;
  healthDamage: number;
  fatal: boolean;
  effectiveHeadshot: boolean;
}

interface PendingMeleeHit {
  attackerId: string;
  targetId: string;
  amount: number;
  options: DamageOptions;
}

const noButtons = (): ButtonState => ({
  fire: false,
  jump: false,
  reload: false,
  swap: false,
  melee: false,
  grenade: false,
  use: false,
});

export const WEAPON_PICKUP_INTERACTION_RADIUS = Math.sqrt(2.2);
export const TURRET_INTERACTION_RADIUS = 6.4;
export const TURRET_INTERACTION_VERTICAL_RANGE = 2.2;
const TURRET_MOUNT_POSITION_TOLERANCE = 0.35;
const TURRET_EXIT_CLEARANCE = 0.18;

const horizontalDistanceSquared = (from: Vec3, to: Vec3): number => {
  const x = from.x - to.x;
  const z = from.z - to.z;
  return x * x + z * z;
};

const normalizedPlayerCount = (mode: MatchConfig['mode'], requested: number | undefined): number => {
  if (mode !== 'deathmatch') return rulesForMode(mode).maxPlayers;
  const finiteRequested = requested !== undefined && Number.isFinite(requested) ? Math.floor(requested) : 2;
  return clamp(finiteRequested, 2, rulesForMode(mode).maxPlayers);
};

/**
 * Physical, authoritative capsule position for an operator. The position is
 * part of PlayerState, so remote clients, radar, hit detection and replays all
 * see the astronaut on the raised emplacement rather than on the lower deck.
 */
export const towerTurretOperatorPosition = (towerCenter: Vec3, yaw: number): Vec3 => {
  const forward = directionFromAngles(yaw, 0);
  return {
    x: towerCenter.x - forward.x * TOWER_TURRET_LAYOUT.operatorDistance,
    y: towerCenter.y + TOWER_TURRET_LAYOUT.operatorFeetOffset,
    z: towerCenter.z - forward.z * TOWER_TURRET_LAYOUT.operatorDistance,
  };
};

/** Shared muzzle/sight origin used by authoritative firing and presentation. */
export const towerTurretFiringOrigin = (towerCenter: Vec3): Vec3 =>
  add(towerCenter, vec3(0, TOWER_TURRET_LAYOUT.firingOriginOffset, 0));

/** Shared by simulation and HUD prompts so the usable control deck is unambiguous. */
export const canUseTowerTurret = (player: PlayerState, tower: MatchState['tower']): boolean => {
  if (!player.alive) return false;
  const horizontalDistance = Math.sqrt(horizontalDistanceSquared(player.position, tower.center));
  if (tower.turretOwnerId === player.id) {
    return Math.abs(horizontalDistance - TOWER_TURRET_LAYOUT.operatorDistance) <= TURRET_MOUNT_POSITION_TOLERANCE
      && Math.abs(player.position.y - (tower.center.y + TOWER_TURRET_LAYOUT.operatorFeetOffset))
        <= TURRET_MOUNT_POSITION_TOLERANCE;
  }
  return horizontalDistance <= TURRET_INTERACTION_RADIUS
    && Math.abs(player.position.y - tower.center.y) <= TURRET_INTERACTION_VERTICAL_RANGE;
};

/** Exact predicate used by presentation code to offer an E-key weapon prompt. */
export const canUseWeaponPickup = (player: PlayerState, pickup: PickupState): boolean =>
  player.alive
  && pickup.available
  && pickup.kind === 'weapon'
  && pickup.weaponId !== undefined
  && distanceSquared(player.position, pickup.position) <= WEAPON_PICKUP_INTERACTION_RADIUS ** 2;

const teamForSlot = (config: MatchConfig, slot: number): Team => {
  if (!isTeamGameMode(config.mode)) return 'neutral';
  return slot % 2 === 0 ? 'aurora' : 'nova';
};

const isTeamMode = (state: MatchState): boolean =>
  isTeamGameMode(state.config.mode);

const isEnemy = (state: MatchState, attacker: PlayerState, target: PlayerState): boolean => {
  if (attacker.id === target.id) return false;
  if (!isTeamMode(state)) return true;
  return attacker.team !== target.team;
};

const modeRespawnSeconds = (config: MatchConfig): number => {
  if (config.mode === 'capture-the-flag') return 5;
  if (config.mode === 'team-deathmatch' || config.mode === 'towah-of-powah') return 4;
  return 3;
};

export const recommendedScoreLimit = (mode: MatchConfig['mode'], _format: MatchConfig['format']): number => {
  if (mode === 'capture-the-flag') return 5;
  if (mode === 'juggernaut') return 25;
  if (mode === 'team-deathmatch' || mode === 'towah-of-powah') return 50;
  return 15;
};

export const recommendedTimeLimit = (mode: MatchConfig['mode'], _format: MatchConfig['format']): number => {
  if (mode === 'capture-the-flag') return 12 * 60;
  if (mode === 'deathmatch') return 8 * 60;
  return 10 * 60;
};

export class GameSimulation {
  public readonly map: MapDefinition;
  public state: MatchState;
  private readonly previousButtons = new Map<string, ButtonState>();
  /** Tracks the transition, not every recharge tick, so audiovisual events never spam. */
  private readonly shieldRechargeActive = new Set<string>();
  /** Rising-edge context actions captured before button history advances. */
  private readonly usePressedThisTick = new Set<string>();
  /** One context action may activate at most one world interaction. */
  private readonly consumedUseThisTick = new Set<string>();
  /** Recent authoritative damage used to award Halo-style assists on a kill. */
  private readonly damageContributors = new Map<string, Map<string, { at: number; amount: number }>>();
  /** Deferred until every player has acted so same-tick melees can trade. */
  private readonly pendingMeleeHits: PendingMeleeHit[] = [];
  private resolvingMeleeHits = false;
  private pendingJuggernautSuccessorId: string | null = null;
  private projectileSequence = 0;
  private pickupSequence = 0;

  public constructor(config: MatchConfig, initialHumans: Array<{ id: string; name: string; kind?: PlayerKind }> = []) {
    const normalizedConfig: MatchConfig = {
      ...config,
      format: canonicalFormatForMode(config.mode),
      playerCount: normalizedPlayerCount(config.mode, config.playerCount),
    };
    this.map = MAPS[normalizedConfig.mapId];
    const seed = hashString(`${normalizedConfig.mode}:${normalizedConfig.format}:${Date.now()}`);
    this.state = {
      version: 1,
      matchId: `arena-${seed.toString(36)}`,
      config: normalizedConfig,
      tick: 0,
      elapsed: 0,
      timeRemaining: normalizedConfig.timeLimitSeconds,
      phase: 'countdown',
      countdown: 3,
      winner: null,
      players: {},
      projectiles: [],
      pickups: this.map.pickups
        .filter((pickup) => normalizedConfig.mode !== 'towah-of-powah' || (pickup.kind !== 'overshield' && (pickup.kind !== 'weapon' || pickup.weaponId === 'shotgun')))
        .map((pickup) => ({
          ...pickup,
          position: cloneVec3(pickup.position),
          amount: pickup.kind === 'grenade' ? 2 : 1,
          temporary: false,
          despawnTimer: 0,
          available: true,
          respawnTimer: 0,
        })),
      flags: [
        {
          team: 'aurora',
          basePosition: cloneVec3(this.map.flagBases.aurora),
          position: cloneVec3(this.map.flagBases.aurora),
          status: 'home',
          carrierId: null,
          returnTimer: 0,
        },
        {
          team: 'nova',
          basePosition: cloneVec3(this.map.flagBases.nova),
          position: cloneVec3(this.map.flagBases.nova),
          status: 'home',
          carrierId: null,
          returnTimer: 0,
        },
      ],
      tower: {
        center: cloneVec3(this.map.towerCenter),
        radius: this.map.towerZone.radius,
        controllingTeam: 'neutral',
        turretOwnerId: null,
        turretYaw: 0,
        turretPitch: 0,
        turretCooldown: 0,
      },
      teamScores: { aurora: 0, nova: 0 },
      juggernautId: null,
      eventSequence: 0,
      events: [],
      randomState: seed,
    };

    initialHumans.forEach((human, index) => this.insertPlayer(human.id, human.name, human.kind ?? 'human', teamForSlot(normalizedConfig, index)));
    if (normalizedConfig.botFill) this.fillWithBots();
    if (normalizedConfig.mode === 'juggernaut') this.assignInitialJuggernaut();
  }

  public get maxPlayers(): number {
    return this.state.config.playerCount;
  }

  public setInput(playerId: string, input: PlayerInput): void {
    const player = this.state.players[playerId];
    if (!player || player.kind === 'bot') return;
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) return;
    if (input.sequence < player.input.sequence) return;
    if (![input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite)) return;
    player.input = {
      ...input,
      moveX: clamp(input.moveX, -1, 1),
      moveZ: clamp(input.moveZ, -1, 1),
      yaw: wrapAngle(input.yaw),
      pitch: clamp(input.pitch, -PLAYER_PITCH_LIMIT, PLAYER_PITCH_LIMIT),
    };
  }

  public addRemotePlayer(id: string, name: string): PlayerState | null {
    if (this.state.players[id]) return this.state.players[id];
    const bots = Object.values(this.state.players).filter((player) => player.kind === 'bot');
    if (bots.length === 0 && Object.keys(this.state.players).length >= this.maxPlayers) return null;
    let slot = Object.keys(this.state.players).length;
    let inheritedTeam = teamForSlot(this.state.config, slot);
    let inheritedJuggernaut = false;
    if (bots.length > 0) {
      const teamCounts = { aurora: 0, nova: 0 };
      for (const player of Object.values(this.state.players)) {
        if (player.kind !== 'bot' && player.team !== 'neutral') teamCounts[player.team] += 1;
      }
      const preferredTeam: Team = teamCounts.aurora <= teamCounts.nova ? 'aurora' : 'nova';
      const replacement = bots.find((bot) => bot.team === preferredTeam) ?? bots[0];
      if (replacement) {
        inheritedTeam = replacement.team;
        inheritedJuggernaut = replacement.isJuggernaut;
        this.dropCarriedFlag(replacement);
        if (inheritedJuggernaut) this.state.juggernautId = null;
        this.releaseTurret(replacement.id, false);
        delete this.state.players[replacement.id];
        this.previousButtons.delete(replacement.id);
        this.damageContributors.delete(replacement.id);
        for (const contributors of this.damageContributors.values()) contributors.delete(replacement.id);
      }
      slot = Object.keys(this.state.players).length;
    }
    const player = this.insertPlayer(id, name, 'remote', isTeamMode(this.state) ? inheritedTeam : teamForSlot(this.state.config, slot));
    if (inheritedJuggernaut && this.state.config.mode === 'juggernaut') this.makeJuggernaut(player);
    return player;
  }

  public removeRemotePlayer(id: string): void {
    const player = this.state.players[id];
    if (!player) return;
    const wasJuggernaut = player.isJuggernaut;
    this.dropCarriedFlag(player);
    if (wasJuggernaut) this.state.juggernautId = null;
    this.releaseTurret(id, false);
    delete this.state.players[id];
    this.previousButtons.delete(id);
    this.shieldRechargeActive.delete(id);
    this.damageContributors.delete(id);
    for (const contributors of this.damageContributors.values()) contributors.delete(id);
    if (this.state.config.botFill && this.state.phase !== 'finished') this.fillWithBots();
    if (wasJuggernaut && this.state.config.mode === 'juggernaut') {
      const successor = Object.values(this.state.players).find((candidate) => candidate.alive);
      if (successor) this.makeJuggernaut(successor);
    }
  }

  public snapshot(): MatchState {
    return structuredClone(this.state);
  }

  public step(dt: number): void {
    const safeDt = clamp(dt, 0, 0.05);
    this.state.tick += 1;
    let expiredEventCount = 0;
    while (
      expiredEventCount < this.state.events.length
      && this.state.elapsed - this.state.events[expiredEventCount]!.time >= 4
    ) {
      expiredEventCount += 1;
    }
    if (expiredEventCount > 0) this.state.events.splice(0, expiredEventCount);

    if (this.state.phase === 'countdown') {
      this.state.countdown = Math.max(0, this.state.countdown - safeDt);
      if (this.state.countdown <= 0) this.state.phase = 'playing';
    }
    if (this.state.phase === 'finished') return;

    this.state.elapsed += safeDt;
    if (this.state.phase === 'playing') this.state.timeRemaining = Math.max(0, this.state.timeRemaining - safeDt);

    updateBotInputs(this.state, this.map, safeDt, (from, to) => hasLineOfSight(from, to, this.map));
    this.usePressedThisTick.clear();
    this.consumedUseThisTick.clear();
    this.pendingMeleeHits.length = 0;
    for (const player of Object.values(this.state.players)) this.updatePlayer(player, safeDt);
    this.resolveMeleeHits();
    this.updateProjectiles(safeDt);
    if (this.state.phase === 'playing') {
      // Turret interaction wins over a colocated weapon prompt for the same
      // context-action edge, and an operator must explicitly pull the trigger.
      this.updateTower(safeDt);
      this.updatePickups(safeDt);
      this.updateFlags(safeDt);
      this.ensureJuggernaut();
    }
    this.evaluateMatchEnd();
  }

  private insertPlayer(id: string, name: string, kind: PlayerKind, team: Team): PlayerState {
    const loadout = this.state.config.mode === 'towah-of-powah' ? TOWER_LOADOUT : DEFAULT_LOADOUT;
    const maxShield = this.state.config.mode === 'towah-of-powah' ? 0 : 100;
    const player: PlayerState = {
      id,
      name: name.trim().slice(0, 18) || (kind === 'bot' ? 'Bot' : 'Astronauta'),
      kind,
      team,
      position: vec3(0, 0, 0),
      velocity: vec3(),
      yaw: team === 'nova' ? Math.PI / 2 : -Math.PI / 2,
      pitch: 0,
      radius: FIXED_PLAYER_RADIUS,
      height: FIXED_PLAYER_HEIGHT,
      crouched: false,
      grounded: false,
      alive: true,
      health: MAX_HEALTH,
      shield: maxShield,
      maxShield,
      overshieldDecayDelay: 0,
      lastDamageAt: -99,
      respawnTimer: 0,
      spawnProtection: 1,
      inventory: loadout.map(createWeaponState),
      activeWeapon: 0,
      grenades: MAX_PLAYER_GRENADES,
      meleeCooldown: 0,
      grenadeCooldown: 0,
      equipTimer: 0,
      aimSuppressed: false,
      input: emptyInput(),
      lastProcessedInput: 0,
      movementMemory: createPlayerMovementMemory(),
      kills: 0,
      deaths: 0,
      assists: 0,
      score: 0,
      streak: 0,
      isJuggernaut: false,
      carryingFlagTeam: null,
      bot: kind === 'bot' ? createBotMemory(this.state.config.difficulty) : undefined,
    };
    this.state.players[id] = player;
    this.previousButtons.set(id, noButtons());
    this.spawnPlayer(player, true);
    return player;
  }

  private fillWithBots(): void {
    let index = 0;
    while (Object.keys(this.state.players).length < this.maxPlayers) {
      const slot = Object.keys(this.state.players).length;
      const id = `bot-${slot}-${index}`;
      let team = teamForSlot(this.state.config, slot);
      if (isTeamMode(this.state)) {
        const counts = { aurora: 0, nova: 0 };
        for (const player of Object.values(this.state.players)) {
          if (player.team !== 'neutral') counts[player.team] += 1;
        }
        team = counts.aurora <= counts.nova ? 'aurora' : 'nova';
      }
      if (!this.state.players[id]) this.insertPlayer(id, BOT_NAMES[index % BOT_NAMES.length] ?? `Bot ${index + 1}`, 'bot', team);
      index += 1;
    }
  }

  private updatePlayer(player: PlayerState, dt: number): void {
    player.meleeCooldown = Math.max(0, player.meleeCooldown - dt);
    player.grenadeCooldown = Math.max(0, player.grenadeCooldown - dt);
    player.equipTimer = Math.max(0, player.equipTimer - dt);
    player.spawnProtection = Math.max(0, player.spawnProtection - dt);
    if (!player.input.aim) player.aimSuppressed = false;

    const activeAtFrameStart = player.inventory[player.activeWeapon];
    let activeCooldownCarry = 0;
    for (const weapon of player.inventory) {
      if (weapon.cooldown > 0) {
        const cooledDown = weapon.cooldown - dt;
        if (weapon === activeAtFrameStart && cooledDown < 0) activeCooldownCarry = cooledDown;
        weapon.cooldown = Math.max(0, cooledDown);
      }
      weapon.bloom = Math.max(0, weapon.bloom - WEAPONS[weapon.id].bloomRecovery * dt);
      if (weapon !== activeAtFrameStart) {
        // Halo-style weapon handling never completes a magazine in the holster.
        weapon.reloadTimer = 0;
        weapon.burstRemaining = 0;
        weapon.burstRoundIndex = 0;
        weapon.burstTimer = 0;
      }
    }
    if (activeAtFrameStart?.reloadTimer && activeAtFrameStart.reloadTimer > 0) {
      activeAtFrameStart.reloadTimer = Math.max(0, activeAtFrameStart.reloadTimer - dt);
      if (activeAtFrameStart.reloadTimer === 0) this.finishReload(player, activeAtFrameStart);
    }

    if (!player.alive) {
      this.shieldRechargeActive.delete(player.id);
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) this.spawnPlayer(player, false);
      return;
    }

    this.updateShieldRecharge(player, dt);
    this.updateHealthRecharge(player, dt);

    const operatingTurret = this.state.config.mode === 'towah-of-powah'
      && this.state.tower.turretOwnerId === player.id;
    player.yaw = operatingTurret
      ? moveAngleToward(
          player.yaw,
          player.input.yaw,
          TOWER_TURRET_LAYOUT.turnRate * dt,
        )
      : player.input.yaw;
    player.pitch = clamp(player.input.pitch, -PLAYER_PITCH_LIMIT, PLAYER_PITCH_LIMIT);
    player.lastProcessedInput = Math.max(player.lastProcessedInput, player.input.sequence);

    const previous = this.previousButtons.get(player.id) ?? noButtons();
    const canAct = this.state.phase === 'playing';
    const usePressed = canAct && !previous.use && player.input.use;
    if (usePressed) this.usePressedThisTick.add(player.id);
    const enteringTurret = usePressed
      && this.state.config.mode === 'towah-of-powah'
      && this.state.tower.turretOwnerId === null
      && canUseTowerTurret(player, this.state.tower);
    if (canAct) {
      if (operatingTurret) this.holdTurretOperator(player);
      else this.updateMovement(player, dt, !previous.jump && player.input.jump);
    }

    let currentWeapon = player.inventory[player.activeWeapon];
    if (currentWeapon && canAct && !operatingTurret && !enteringTurret) {
      const swapPressed = !previous.swap && player.input.swap && player.inventory.length > 1;
      const meleePressed = !previous.melee && player.input.melee;
      const grenadePressed = !previous.grenade && player.input.grenade;
      if (swapPressed) {
        this.cancelWeaponAction(currentWeapon);
        player.activeWeapon = (player.activeWeapon + 1) % player.inventory.length;
        player.equipTimer = WEAPON_EQUIP_SECONDS;
        currentWeapon = player.inventory[player.activeWeapon];
      } else if (player.equipTimer <= 0 && currentWeapon) {
        // Mutually exclusive action priority prevents fire, melee and grenade
        // from all resolving on the same authoritative tick.
        if (meleePressed) {
          this.cancelWeaponAction(currentWeapon);
          this.melee(player);
        } else if (grenadePressed) {
          this.cancelWeaponAction(currentWeapon);
          this.throwGrenade(player);
        } else {
          if (currentWeapon.burstRemaining > 0) this.updateWeaponBurst(player, currentWeapon, dt);
          const definition = WEAPONS[currentWeapon.id];
          const wantsFire = player.input.fire && (definition.automatic || !previous.fire);
          if (wantsFire) this.fireWeapon(player, activeCooldownCarry);
          if (!previous.reload && player.input.reload) this.startReload(player);
        }
      }
    }

    this.previousButtons.set(player.id, {
      fire: player.input.fire,
      jump: player.input.jump,
      reload: player.input.reload,
      swap: player.input.swap,
      melee: player.input.melee,
      grenade: player.input.grenade,
      use: player.input.use,
    });
  }

  private holdTurretOperator(player: PlayerState): void {
    player.position = towerTurretOperatorPosition(this.state.tower.center, player.yaw);
    player.velocity = vec3();
    player.height = FIXED_PLAYER_HEIGHT;
    player.crouched = false;
    player.grounded = true;
  }

  private updateMovement(player: PlayerState, dt: number, jumpPressed: boolean): void {
    advancePlayerMovement(
      player,
      player.input,
      {
        map: this.map,
        tower: this.state.tower,
        elapsed: this.state.elapsed,
      },
      player.movementMemory,
      dt,
      jumpPressed,
    );
  }

  private updateShieldRecharge(player: PlayerState, dt: number): void {
    if (player.shield > player.maxShield) {
      this.shieldRechargeActive.delete(player.id);
      player.overshieldDecayDelay = Math.max(0, player.overshieldDecayDelay - dt);
      if (player.overshieldDecayDelay === 0) player.shield = Math.max(player.maxShield, player.shield - 5 * dt);
      return;
    }

    const rechargeDelay = player.isJuggernaut ? 5 : SHIELD_RECHARGE_DELAY;
    const canRecharge = player.maxShield > 0
      && player.shield < player.maxShield
      && this.state.elapsed - player.lastDamageAt >= rechargeDelay;
    if (!canRecharge) {
      this.shieldRechargeActive.delete(player.id);
      return;
    }

    // A zero-length diagnostic step must not manufacture a transition event.
    if (dt <= 0) return;
    if (!this.shieldRechargeActive.has(player.id)) {
      this.shieldRechargeActive.add(player.id);
      this.pushEvent({
        type: 'shield-recharge-start',
        targetId: player.id,
        position: cloneVec3(player.position),
        message: `${player.name}: barrera regenerándose`,
      });
    }

    player.shield = Math.min(player.maxShield, player.shield + SHIELD_RECHARGE_RATE * dt);
    if (player.shield >= player.maxShield) {
      this.shieldRechargeActive.delete(player.id);
      this.pushEvent({
        type: 'shield-recharge-complete',
        targetId: player.id,
        position: cloneVec3(player.position),
        message: `${player.name}: barrera restaurada`,
      });
    }
  }

  private updateHealthRecharge(player: PlayerState, dt: number): void {
    if (dt <= 0 || player.health >= MAX_HEALTH) return;
    if (this.state.elapsed - player.lastDamageAt < HEALTH_RECHARGE_DELAY) return;
    player.health = Math.min(MAX_HEALTH, player.health + HEALTH_RECHARGE_RATE * dt);
  }

  private startReload(player: PlayerState): void {
    const weapon = player.inventory[player.activeWeapon];
    if (!weapon || weapon.reloadTimer > 0 || weapon.burstRemaining > 0 || weapon.reserve <= 0) return;
    const definition = WEAPONS[weapon.id];
    if (weapon.magazine >= definition.magazineSize) return;
    weapon.reloadTimer = definition.reloadSeconds;
    this.pushEvent({ type: 'reload', actorId: player.id, weaponId: weapon.id });
  }

  private finishReload(player: PlayerState, weapon: PlayerState['inventory'][number]): void {
    const definition = WEAPONS[weapon.id];
    if (definition.reloadStyle === 'shell') {
      if (weapon.magazine < definition.magazineSize && weapon.reserve > 0) {
        weapon.magazine += 1;
        weapon.reserve -= 1;
      }
      if (weapon.magazine < definition.magazineSize && weapon.reserve > 0) {
        weapon.reloadTimer = definition.reloadSeconds;
        this.pushEvent({ type: 'reload', actorId: player.id, weaponId: weapon.id });
      }
      return;
    }
    const amount = Math.min(definition.magazineSize - weapon.magazine, weapon.reserve);
    weapon.magazine += amount;
    weapon.reserve -= amount;
  }

  private cancelWeaponAction(weapon: PlayerState['inventory'][number]): void {
    weapon.reloadTimer = 0;
    weapon.burstRemaining = 0;
    weapon.burstRoundIndex = 0;
    weapon.burstTimer = 0;
  }

  private updateWeaponBurst(
    player: PlayerState,
    weapon: PlayerState['inventory'][number],
    dt: number,
  ): void {
    const definition = WEAPONS[weapon.id];
    if (!definition.burstCount || weapon.burstRemaining <= 0) return;
    weapon.burstTimer -= dt;
    while (weapon.burstRemaining > 0 && weapon.burstTimer <= 0.000001) {
      if (weapon.magazine <= 0) {
        weapon.burstRemaining = 0;
        weapon.burstRoundIndex = 0;
        weapon.burstTimer = 0;
        this.startReload(player);
        return;
      }
      this.fireWeaponRound(player, weapon, weapon.burstRoundIndex);
      weapon.burstRoundIndex += 1;
      weapon.burstRemaining -= 1;
      if (weapon.burstRemaining > 0) weapon.burstTimer += definition.burstInterval ?? 0.067;
    }
    if (weapon.burstRemaining === 0) {
      weapon.burstRoundIndex = 0;
      weapon.burstTimer = 0;
      if (weapon.magazine === 0) this.startReload(player);
    }
  }

  private fireWeapon(player: PlayerState, cooldownCarry = 0): void {
    const weapon = player.inventory[player.activeWeapon];
    if (!weapon || weapon.cooldown > 0 || weapon.burstRemaining > 0 || player.equipTimer > 0) return;
    const definition = WEAPONS[weapon.id];
    if (weapon.reloadTimer > 0) {
      // A tube-fed shotgun may fire a shell that has already been loaded.
      if (definition.reloadStyle === 'shell' && weapon.magazine > 0) weapon.reloadTimer = 0;
      else return;
    }
    if (weapon.magazine <= 0) {
      this.startReload(player);
      return;
    }
    // A fixed step can pass the exact ready time by a fraction of a tick. Carry
    // that excess into the next interval so held automatic fire keeps its
    // authored average cadence instead of rounding every shot up to 1/60 s.
    weapon.cooldown = Math.max(0, definition.fireInterval + Math.min(0, cooldownCarry));
    const rounds = Math.min(definition.burstCount ?? 1, weapon.magazine);
    this.fireWeaponRound(player, weapon, 0);
    weapon.burstRemaining = Math.max(0, rounds - 1);
    weapon.burstRoundIndex = weapon.burstRemaining > 0 ? 1 : 0;
    weapon.burstTimer = weapon.burstRemaining > 0 ? definition.burstInterval ?? 0.067 : 0;
    if (weapon.burstRemaining === 0 && weapon.magazine === 0) this.startReload(player);
  }

  private fireWeaponRound(
    player: PlayerState,
    weapon: PlayerState['inventory'][number],
    burstIndex: number,
  ): void {
    if (weapon.magazine <= 0) return;
    const definition = WEAPONS[weapon.id];
    weapon.magazine -= 1;
    player.spawnProtection = 0;
    const origin = { x: player.position.x, y: player.position.y + 1.5, z: player.position.z };
    const rawDirection = directionFromAngles(player.yaw, player.pitch);
    const hitscanPlayers = definition.ballisticSpeed || definition.projectile === 'rocket'
      ? undefined
      : Object.values(this.state.players);
    const baseDirection = this.assistedAimDirection(player, origin, rawDirection, definition, hitscanPlayers);
    if (definition.ballisticSpeed) {
      const direction = sampleDirectionInCone(
        baseDirection,
        shotSpread(definition, weapon, burstIndex),
        randomRange(this.state, 0, 1),
        randomRange(this.state, 0, 1),
      );
      this.pushEvent({
        type: 'shot',
        actorId: player.id,
        weaponId: weapon.id,
        position: add(origin, scale(direction, 6)),
        sourcePosition: cloneVec3(origin),
        impact: false,
      });
      this.state.projectiles.push({
        id: `projectile-${this.projectileSequence++}`,
        kind: 'bullet',
        ownerId: player.id,
        team: player.team,
        weaponId: weapon.id,
        // Collision starts at the authoritative eye/muzzle origin. Presentation
        // may render the round ahead of it, but the initial 0.7 u must still be
        // swept so nearby cover and targets cannot be skipped.
        position: cloneVec3(origin),
        velocity: scale(direction, definition.ballisticSpeed),
        radius: 0.025,
        damage: definition.damage,
        blastRadius: 0,
        armed: true,
        fuse: definition.range / definition.ballisticSpeed,
        alive: true,
      });
      weapon.bloom = Math.min(1, weapon.bloom + definition.bloomPerShot);
      return;
    }
    if (definition.projectile === 'rocket') {
      this.pushEvent({
        type: 'shot',
        actorId: player.id,
        weaponId: weapon.id,
        position: add(origin, scale(baseDirection, Math.min(5, definition.range))),
        sourcePosition: cloneVec3(origin),
        impact: false,
      });
      this.state.projectiles.push({
        id: `projectile-${this.projectileSequence++}`,
        kind: 'rocket',
        ownerId: player.id,
        team: player.team,
        position: add(origin, scale(baseDirection, 0.85)),
        velocity: scale(baseDirection, 28),
        radius: 0.22,
        damage: definition.damage,
        blastRadius: definition.splashRadius ?? 5.5,
        armed: true,
        fuse: 5,
        alive: true,
      });
      weapon.bloom = Math.min(1, weapon.bloom + definition.bloomPerShot);
      return;
    }

    const traces: Vec3[] = [];
    const resolvedHits: Array<ReturnType<typeof raycastWorld>> = [];
    const spreadScale = shotSpread(definition, weapon, burstIndex);
    const players = hitscanPlayers ?? Object.values(this.state.players);
    for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
      const direction = sampleDirectionInCone(
        baseDirection,
        spreadScale,
        randomRange(this.state, 0, 1),
        randomRange(this.state, 0, 1),
      );
      const hit = raycastWorld(origin, direction, definition.range, this.map, players, player.id);
      resolvedHits.push(hit);
      traces.push(hit?.point ?? add(origin, scale(direction, definition.range)));
    }
    this.pushEvent({
      type: 'shot',
      actorId: player.id,
      weaponId: weapon.id,
      position: traces[0],
      sourcePosition: cloneVec3(origin),
      impact: resolvedHits.some((hit) => hit !== null),
      traces: traces.length > 1 ? traces : undefined,
    });

    const damageByTarget = new Map<string, {
      amount: number;
      headAmount: number;
      position: Vec3;
    }>();
    for (const hit of resolvedHits) {
      if (!hit?.playerId) continue;
      const target = this.state.players[hit.playerId];
      if (!target || !isEnemy(this.state, player, target)) continue;
      const amount = definition.damage * damageScaleAtDistance(definition, hit.distance);
      const aggregate = damageByTarget.get(target.id) ?? {
        amount: 0,
        headAmount: 0,
        position: hit.point,
      };
      aggregate.amount += amount;
      if (hit.headshot) aggregate.headAmount += amount;
      damageByTarget.set(target.id, aggregate);
    }
    for (const [targetId, aggregate] of damageByTarget) {
      const target = this.state.players[targetId];
      if (!target) continue;
      this.applyDamage(target, aggregate.amount, player, {
        weaponId: weapon.id,
        position: aggregate.position,
        sourcePosition: origin,
        headshot: aggregate.headAmount > 0,
        headshotFraction: aggregate.amount > 0 ? aggregate.headAmount / aggregate.amount : 0,
        headshotMode: definition.headshotMode,
        headMultiplier: definition.headMultiplier,
      });
    }
    weapon.bloom = Math.min(1, weapon.bloom + definition.bloomPerShot);
  }

  private assistedAimDirection(
    player: PlayerState,
    origin: Vec3,
    direction: Vec3,
    definition: (typeof WEAPONS)[WeaponId],
    knownPlayers?: readonly PlayerState[],
  ): Vec3 {
    const angleLimit = definition.magnetismAngle ?? 0;
    const assistRange = Math.min(definition.range, definition.magnetismRange ?? 0);
    if (player.kind === 'bot' || angleLimit <= 0 || assistRange <= 0) return direction;
    const players = knownPlayers ?? Object.values(this.state.players);

    // Never pull an already valid body/head ray away from the point the player chose.
    const directHit = raycastWorld(
      origin,
      direction,
      definition.range,
      this.map,
      players,
      player.id,
    );
    if (directHit?.playerId) return direction;

    let bestDirection: Vec3 | null = null;
    let bestAngle = angleLimit;
    for (const target of players) {
      if (!target.alive || target.spawnProtection > 0 || !isEnemy(this.state, player, target)) continue;
      const targetPoint = add(target.position, vec3(0, target.height * 0.62, 0));
      const delta = subtract(targetPoint, origin);
      const targetDistance = distance(origin, targetPoint);
      if (targetDistance > assistRange || !hasLineOfSight(origin, targetPoint, this.map)) continue;
      const candidateDirection = normalize(delta);
      const angle = Math.acos(clamp(dot(direction, candidateDirection), -1, 1));
      if (angle >= bestAngle) continue;
      bestAngle = angle;
      bestDirection = candidateDirection;
    }
    return bestDirection ?? direction;
  }

  private melee(player: PlayerState): void {
    if (player.meleeCooldown > 0) return;
    player.meleeCooldown = 0.85;
    player.spawnProtection = 0;
    const forward = directionFromAngles(player.yaw, 0);
    let best: PlayerState | null = null;
    let bestDistance = MELEE_LUNGE_RANGE;
    for (const target of Object.values(this.state.players)) {
      if (!target.alive || !isEnemy(this.state, player, target)) continue;
      const delta = subtract(target.position, player.position);
      const targetDistance = distance(player.position, target.position);
      if (targetDistance < bestDistance && dot(normalize(delta), forward) > 0.48 && hasLineOfSight(add(player.position, vec3(0, 1.2, 0)), add(target.position, vec3(0, 1.2, 0)), this.map)) {
        best = target;
        bestDistance = targetDistance;
      }
    }
    if (!best) return;
    const targetForward = directionFromAngles(best.yaw, 0);
    const targetToAttacker = normalize(subtract(player.position, best.position));
    // targetForward points out of the victim's face; an attacker behind them is
    // therefore in the opposite hemisphere. The old comparison was inverted.
    const backStrike = dot(targetForward, targetToAttacker) < -0.62;
    if (bestDistance > 1.25) {
      const lungeDirection = normalize(subtract(best.position, player.position));
      player.velocity.x = lungeDirection.x * 6.2;
      player.velocity.z = lungeDirection.z * 6.2;
    }
    this.pushEvent({
      type: 'melee',
      actorId: player.id,
      targetId: best.id,
      position: cloneVec3(best.position),
      sourcePosition: cloneVec3(player.position),
      backStrike,
    });
    this.pendingMeleeHits.push({
      attackerId: player.id,
      targetId: best.id,
      amount: backStrike ? 220 : MELEE_DAMAGE,
      options: {
        position: cloneVec3(best.position),
        sourcePosition: cloneVec3(player.position),
        backStrike,
        bypassSpawnProtection: true,
      },
    });
  }

  private resolveMeleeHits(): void {
    this.resolvingMeleeHits = true;
    try {
      for (const pending of this.pendingMeleeHits) {
        const target = this.state.players[pending.targetId];
        const attacker = this.state.players[pending.attackerId] ?? null;
        if (target) this.applyDamage(target, pending.amount, attacker, pending.options);
      }
    } finally {
      this.resolvingMeleeHits = false;
      this.pendingMeleeHits.length = 0;
    }
    if (this.state.config.mode === 'juggernaut' && !this.state.juggernautId) {
      const nominated = this.pendingJuggernautSuccessorId
        ? this.state.players[this.pendingJuggernautSuccessorId]
        : null;
      const successor = nominated?.alive
        ? nominated
        : Object.values(this.state.players).find((candidate) => candidate.alive);
      if (successor) this.makeJuggernaut(successor);
    }
    this.pendingJuggernautSuccessorId = null;
  }

  private throwGrenade(player: PlayerState): void {
    if (player.grenadeCooldown > 0 || player.grenades <= 0 || player.carryingFlagTeam) return;
    player.grenades -= 1;
    player.grenadeCooldown = 0.65;
    player.spawnProtection = 0;
    const direction = directionFromAngles(player.yaw, player.pitch);
    const origin = add(player.position, vec3(0, 1.35, 0));
    this.state.projectiles.push({
      id: `projectile-${this.projectileSequence++}`,
      kind: 'grenade',
      ownerId: player.id,
      team: player.team,
      position: add(origin, scale(direction, 0.8)),
      velocity: add(scale(direction, 14), vec3(0, 5.5, 0)),
      radius: 0.16,
      damage: GRENADE_DAMAGE,
      blastRadius: 5.5,
      armed: false,
      fuse: GRENADE_FUSE_SECONDS,
      alive: true,
    });
  }

  private applyDamage(
    target: PlayerState,
    amount: number,
    attacker: PlayerState | null,
    options: DamageOptions = {},
  ): DamageResult {
    const emptyResult: DamageResult = {
      shieldDamage: 0,
      healthDamage: 0,
      fatal: false,
      effectiveHeadshot: false,
    };
    if (!target.alive || (target.spawnProtection > 0 && !options.bypassSpawnProtection) || amount <= 0) return emptyResult;
    if (attacker && attacker.id !== target.id && !isEnemy(this.state, attacker, target)) return emptyResult;
    target.lastDamageAt = this.state.elapsed;
    const shieldBefore = target.shield;
    const healthBefore = target.health;
    const shieldDamage = Math.min(target.shield, amount);
    target.shield -= shieldDamage;
    const exposedBaseDamage = Math.max(0, amount - shieldDamage);
    const headshotFraction = clamp(options.headshotFraction ?? (options.headshot ? 1 : 0), 0, 1);
    const effectiveHeadshot = Boolean(options.headshot && exposedBaseDamage > 0 && headshotFraction > 0);
    let requestedHealthDamage = exposedBaseDamage;
    if (effectiveHeadshot && options.headshotMode === 'precision') {
      // Precision headshots execute only after the base projectile reaches
      // health. Shields still absorb ordinary damage, including overshields.
      requestedHealthDamage = healthBefore;
    } else if (effectiveHeadshot && options.headshotMode === 'bonus') {
      const weightedMultiplier = 1 + ((options.headMultiplier ?? 1) - 1) * headshotFraction;
      requestedHealthDamage *= weightedMultiplier;
    }
    const healthDamage = Math.min(healthBefore, requestedHealthDamage);
    target.health -= healthDamage;
    const fatal = target.health <= 0;
    // Grouped pellet weapons may brush the helmet with one pellet while the
    // body carries the hit. Reserve precision feedback for shots whose sampled
    // damage was predominantly a head hit.
    const confirmedHeadshot = Boolean(options.headshot) && headshotFraction >= 0.5;
    const eventPosition = options.position ? cloneVec3(options.position) : cloneVec3(target.position);
    const sourcePosition = options.sourcePosition
      ? cloneVec3(options.sourcePosition)
      : attacker
        ? cloneVec3(attacker.position)
        : undefined;
    target.aimSuppressed = target.input.aim;
    if (attacker && attacker.id !== target.id && shieldDamage + healthDamage > 0) {
      const contributors = this.damageContributors.get(target.id) ?? new Map();
      const previous = contributors.get(attacker.id);
      contributors.set(attacker.id, {
        at: this.state.elapsed,
        amount: (previous && this.state.elapsed - previous.at <= 5 ? previous.amount : 0)
          + shieldDamage
          + healthDamage,
      });
      this.damageContributors.set(target.id, contributors);
    }
    this.pushEvent({
      type: 'hit',
      actorId: attacker?.id,
      targetId: target.id,
      weaponId: options.weaponId,
      position: eventPosition,
      sourcePosition,
      amount: shieldDamage + healthDamage,
      shieldDamage,
      healthDamage,
      headshot: confirmedHeadshot,
      fatal,
      backStrike: options.backStrike,
    });
    if (shieldBefore > 0 && target.shield <= 0) {
      this.pushEvent({
        type: 'shield-break',
        actorId: attacker?.id,
        targetId: target.id,
        position: cloneVec3(target.position),
        sourcePosition,
      });
    }
    if (fatal) {
      this.killPlayer(target, attacker, options.weaponId, {
        headshot: effectiveHeadshot && confirmedHeadshot && options.headshotMode !== 'none',
        backStrike: options.backStrike,
      });
    }
    return { shieldDamage, healthDamage, fatal, effectiveHeadshot };
  }

  private killPlayer(
    victim: PlayerState,
    killer: PlayerState | null,
    weaponId?: WeaponId,
    metadata: Pick<GameEvent, 'headshot' | 'backStrike'> = {},
  ): void {
    if (!victim.alive) return;
    this.dropDeathEquipment(victim);
    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.streak = 0;
    victim.respawnTimer = modeRespawnSeconds(this.state.config);
    victim.velocity = vec3();
    this.releaseTurret(victim.id);
    this.dropCarriedFlag(victim);
    if (killer && killer.id !== victim.id) {
      killer.kills += 1;
      killer.streak += 1;
    }
    const contributors = this.damageContributors.get(victim.id);
    if (contributors) {
      for (const [attackerId, contribution] of contributors) {
        if (attackerId === killer?.id || this.state.elapsed - contribution.at > 5 || contribution.amount <= 0) continue;
        const assistant = this.state.players[attackerId];
        if (assistant && assistant.id !== victim.id && isEnemy(this.state, assistant, victim)) assistant.assists += 1;
      }
      this.damageContributors.delete(victim.id);
    }
    this.pushEvent({
      type: 'kill',
      actorId: killer?.id,
      targetId: victim.id,
      weaponId,
      position: cloneVec3(victim.position),
      sourcePosition: killer ? cloneVec3(killer.position) : undefined,
      headshot: metadata.headshot,
      fatal: true,
      backStrike: metadata.backStrike,
      message: killer ? `${killer.name} eliminó a ${victim.name}` : `${victim.name} cayó`,
    });

    const mode = this.state.config.mode;
    if (killer && killer.id !== victim.id) {
      if (mode === 'deathmatch') {
        killer.score += 1;
      } else if (mode === 'team-deathmatch' || mode === 'towah-of-powah') {
        killer.score += 1;
        if (killer.team !== 'neutral') this.state.teamScores[killer.team] += 1;
      } else if (mode === 'juggernaut') {
        if (killer.isJuggernaut) this.awardJuggernautPoint(killer);
        if (victim.isJuggernaut) {
          this.awardJuggernautPoint(killer);
          if (this.resolvingMeleeHits) {
            victim.isJuggernaut = false;
            this.state.juggernautId = null;
            this.pendingJuggernautSuccessorId = killer.id;
          } else {
            this.makeJuggernaut(killer);
          }
        }
      }
    }
    if (victim.isJuggernaut && (!killer || killer.id === victim.id)) {
      victim.isJuggernaut = false;
      this.state.juggernautId = null;
      const successor = Object.values(this.state.players).find((player) => player.alive && player.id !== victim.id);
      if (successor) this.makeJuggernaut(successor);
    }
  }

  private dropDeathEquipment(victim: PlayerState): void {
    const activeWeapon = victim.inventory[victim.activeWeapon];
    const right = { x: Math.cos(victim.yaw), y: 0, z: -Math.sin(victim.yaw) };
    if (activeWeapon) {
      const droppedWeapon = {
        ...activeWeapon,
        cooldown: 0,
        reloadTimer: 0,
        bloom: 0,
        burstRemaining: 0,
        burstRoundIndex: 0,
        burstTimer: 0,
      };
      this.addDeathPickup({
        kind: 'weapon',
        position: add(victim.position, add(scale(right, -0.38), vec3(0, 0.28, 0))),
        weaponId: activeWeapon.id,
        weaponState: droppedWeapon,
        amount: 1,
      });
      // The authoritative copy now lives in the pickup. Clearing the corpse
      // prevents a later system from duplicating its ammunition before respawn.
      activeWeapon.magazine = 0;
      activeWeapon.reserve = 0;
    }
    if (victim.grenades > 0) {
      this.addDeathPickup({
        kind: 'grenade',
        position: add(victim.position, add(scale(right, 0.38), vec3(0, 0.24, 0))),
        amount: victim.grenades,
      });
      victim.grenades = 0;
    }
  }

  private addDeathPickup(
    drop: Pick<PickupState, 'kind' | 'position' | 'amount'>
      & Pick<Partial<PickupState>, 'weaponId' | 'weaponState'>,
  ): void {
    // Bound temporary state so an unusually long or highly lethal session can
    // never exceed the P2P snapshot budget.
    if (this.state.pickups.length >= 112) {
      const oldestDropIndex = this.state.pickups.findIndex((pickup) => pickup.temporary);
      if (oldestDropIndex >= 0) this.state.pickups.splice(oldestDropIndex, 1);
    }
    this.state.pickups.push({
      id: `drop-${this.state.tick}-${++this.pickupSequence}`,
      kind: drop.kind,
      position: cloneVec3(drop.position),
      weaponId: drop.weaponId,
      weaponState: drop.weaponState ? { ...drop.weaponState } : undefined,
      amount: drop.amount,
      temporary: true,
      despawnTimer: DROPPED_PICKUP_LIFETIME_SECONDS,
      available: true,
      respawnTimer: 0,
      respawnSeconds: DROPPED_PICKUP_LIFETIME_SECONDS,
    });
  }

  private awardJuggernautPoint(player: PlayerState): void {
    player.score += 1;
    if (isTeamMode(this.state) && player.team !== 'neutral') this.state.teamScores[player.team] += 1;
  }

  private assignInitialJuggernaut(): void {
    const players = Object.values(this.state.players);
    const player = players[Math.floor(randomRange(this.state, 0, players.length))];
    if (player) this.makeJuggernaut(player);
  }

  private makeJuggernaut(player: PlayerState): void {
    for (const candidate of Object.values(this.state.players)) {
      if (candidate.isJuggernaut && candidate.id !== player.id) {
        candidate.isJuggernaut = false;
        candidate.maxShield = this.state.config.mode === 'towah-of-powah' ? 0 : 100;
        candidate.shield = Math.min(candidate.shield, candidate.maxShield);
      }
    }
    player.isJuggernaut = true;
    player.maxShield = 150;
    player.shield = 150;
    player.spawnProtection = 0.75;
    this.state.juggernautId = player.id;
    this.pushEvent({ type: 'score', actorId: player.id, message: `${player.name} es el Coloso` });
  }

  private updateProjectiles(dt: number): void {
    const projectiles = this.state.projectiles;
    if (projectiles.length === 0) return;
    const players = Object.values(this.state.players);
    for (const projectile of projectiles) {
      if (!projectile.alive) continue;
      if (projectile.kind !== 'grenade' || projectile.armed) projectile.fuse -= dt;
      const previous = cloneVec3(projectile.position);
      if (projectile.kind === 'bullet') {
        const movementDt = projectile.fuse < 0 ? Math.max(0, dt + projectile.fuse) : dt;
        projectile.position = add(projectile.position, scale(projectile.velocity, movementDt));
        const directionDelta = subtract(projectile.position, previous);
        const travel = distance(previous, projectile.position);
        const hit = travel > 0.0001
          ? raycastWorld(
            previous,
            scale(directionDelta, 1 / travel),
            travel + projectile.radius,
            this.map,
            players,
            projectile.ownerId,
          )
          : null;
        if (hit) {
          projectile.position = cloneVec3(hit.point);
          projectile.alive = false;
          const owner = this.state.players[projectile.ownerId];
          const target = hit.playerId ? this.state.players[hit.playerId] : undefined;
          const weaponId = projectile.weaponId ?? 'battle-rifle';
          const definition = WEAPONS[weaponId];
          if (owner && target && isEnemy(this.state, owner, target)) {
            this.applyDamage(target, projectile.damage, owner, {
              weaponId,
              position: hit.point,
              sourcePosition: owner.position,
              headshot: Boolean(hit.headshot),
              headshotMode: definition.headshotMode,
              headMultiplier: definition.headMultiplier,
            });
          }
        } else if (projectile.fuse <= 0) {
          projectile.alive = false;
        }
        continue;
      }
      if (projectile.kind === 'grenade') projectile.velocity.y -= PROJECTILE_GRAVITY * dt;
      projectile.position = add(projectile.position, scale(projectile.velocity, dt));
      let explode = projectile.kind === 'rocket' && projectile.fuse <= 0;

      if (projectile.position.y <= this.map.bounds.floorY + projectile.radius) {
        if (projectile.kind === 'rocket') explode = true;
        else {
          this.armGrenade(projectile);
          projectile.position.y = this.map.bounds.floorY + projectile.radius;
          if (projectile.fuse <= 0) {
            explode = true;
          } else {
            projectile.velocity.y = Math.abs(projectile.velocity.y) * 0.48;
            projectile.velocity.x *= 0.78;
            projectile.velocity.z *= 0.78;
          }
        }
      }

      const directionDelta = subtract(projectile.position, previous);
      const travel = distance(previous, projectile.position);
      if (travel > 0.0001) {
        const ignoreOwner = projectile.kind === 'rocket'
          || projectile.fuse > GRENADE_FUSE_SECONDS - GRENADE_OWNER_GRACE_SECONDS;
        const hit = raycastWorld(
          previous,
          scale(directionDelta, 1 / travel),
          travel + projectile.radius,
          this.map,
          players,
          ignoreOwner ? projectile.ownerId : undefined,
        );
        if (hit) {
          if (projectile.kind === 'rocket') {
            projectile.position = hit.obstacleId
              ? add(hit.point, scale(directionDelta, -(projectile.radius + 0.04) / travel))
              : cloneVec3(hit.point);
            explode = true;
          } else if (hit.playerId) {
            projectile.position = cloneVec3(hit.point);
            explode = true;
          } else if (hit.obstacleId) {
            const obstacle = this.map.obstacles.find((candidate) => candidate.id === hit.obstacleId);
            this.armGrenade(projectile);
            const hitTop = Boolean(
              obstacle
              && directionDelta.y < 0
              && Math.abs(hit.point.y - obstacle.max.y) < 0.04,
            );
            if (hitTop && obstacle) {
              projectile.position = {
                x: hit.point.x,
                y: obstacle.max.y + projectile.radius,
                z: hit.point.z,
              };
              if (projectile.fuse <= 0) {
                explode = true;
              } else {
                projectile.velocity.y = Math.abs(projectile.velocity.y) * 0.48;
                projectile.velocity.x *= 0.78;
                projectile.velocity.z *= 0.78;
              }
            } else {
              projectile.position = previous;
              if (!obstacle) {
                projectile.velocity.x *= -0.42;
                projectile.velocity.z *= -0.42;
              } else {
                const faceDistanceX = Math.min(
                  Math.abs(hit.point.x - obstacle.min.x),
                  Math.abs(hit.point.x - obstacle.max.x),
                );
                const faceDistanceY = Math.min(
                  Math.abs(hit.point.y - obstacle.min.y),
                  Math.abs(hit.point.y - obstacle.max.y),
                );
                const faceDistanceZ = Math.min(
                  Math.abs(hit.point.z - obstacle.min.z),
                  Math.abs(hit.point.z - obstacle.max.z),
                );
                if (faceDistanceX <= faceDistanceY && faceDistanceX <= faceDistanceZ) {
                  projectile.velocity.x *= -0.42;
                  projectile.velocity.z *= 0.9;
                } else if (faceDistanceZ <= faceDistanceY) {
                  projectile.velocity.x *= 0.9;
                  projectile.velocity.z *= -0.42;
                } else {
                  projectile.velocity.y *= -0.42;
                  projectile.velocity.x *= 0.9;
                  projectile.velocity.z *= 0.9;
                }
              }
            }
          }
        }
      }
      if (explode) this.explode(projectile, players);
    }
    let aliveCount = 0;
    for (const projectile of projectiles) {
      if (projectile.alive) projectiles[aliveCount++] = projectile;
    }
    projectiles.length = aliveCount;
  }

  private armGrenade(projectile: ProjectileState): void {
    if (projectile.kind !== 'grenade' || projectile.armed) return;
    projectile.armed = true;
    projectile.fuse = GRENADE_FUSE_SECONDS;
  }

  private explode(projectile: ProjectileState, players: readonly PlayerState[]): void {
    if (projectile.kind === 'bullet') return;
    projectile.alive = false;
    this.pushEvent({
      type: 'explosion',
      actorId: projectile.ownerId,
      position: cloneVec3(projectile.position),
      sourcePosition: cloneVec3(projectile.position),
      explosionKind: projectile.kind,
      radius: projectile.blastRadius,
    });
    const owner = this.state.players[projectile.ownerId] ?? null;
    for (const target of players) {
      if (!target.alive) continue;
      const targetCenter = add(target.position, vec3(0, 0.9, 0));
      const targetDistance = distance(projectile.position, targetCenter);
      if (targetDistance > projectile.blastRadius) continue;
      if (!hasLineOfSight(projectile.position, targetCenter, this.map)) continue;
      const normalizedDistance = clamp(targetDistance / projectile.blastRadius, 0, 1);
      let amount = projectile.damage * (1 - normalizedDistance ** 1.35 * 0.88);
      if (owner && target.id === owner.id) amount *= projectile.kind === 'grenade' ? 0.9 : 1;
      this.applyDamage(target, amount, owner, {
        weaponId: projectile.kind === 'rocket' ? 'rocket-launcher' : undefined,
        position: projectile.position,
        sourcePosition: projectile.position,
      });
      const impulse = normalize(subtract(targetCenter, projectile.position));
      target.velocity = add(target.velocity, scale(impulse, Math.max(0, 8 - targetDistance)));
    }
  }

  private updatePickups(dt: number): void {
    const remainingPickups: PickupState[] = [];
    let players: PlayerState[] | null = null;
    for (const pickup of this.state.pickups) {
      if (pickup.temporary) {
        pickup.despawnTimer = Math.max(0, pickup.despawnTimer - dt);
        if (pickup.despawnTimer === 0) continue;
      }
      if (!pickup.available) {
        pickup.respawnTimer = Math.max(0, pickup.respawnTimer - dt);
        if (pickup.respawnTimer === 0) pickup.available = true;
        remainingPickups.push(pickup);
        continue;
      }
      let removeTemporaryPickup = false;
      players ??= Object.values(this.state.players);
      for (const player of players) {
        if (!player.alive || distanceSquared(player.position, pickup.position) > 2.2) continue;
        let consumed = false;
        let grantedAmount = 0;
        if (pickup.kind === 'grenade' && player.grenades < MAX_PLAYER_GRENADES) {
          const before = player.grenades;
          player.grenades = Math.min(MAX_PLAYER_GRENADES, player.grenades + pickup.amount);
          grantedAmount = player.grenades - before;
          consumed = grantedAmount > 0;
        } else if (pickup.kind === 'overshield' && !player.isJuggernaut && player.maxShield > 0 && player.shield < 175) {
          player.shield = Math.min(175, player.shield + 75);
          player.overshieldDecayDelay = 10;
          consumed = true;
        } else if (pickup.kind === 'ammo') {
          let grantedAmmo = false;
          for (const weapon of player.inventory) {
            const definition = WEAPONS[weapon.id];
            const previousReserve = weapon.reserve;
            weapon.reserve = Math.min(definition.maxReserve, weapon.reserve + definition.magazineSize);
            grantedAmmo ||= weapon.reserve > previousReserve;
          }
          consumed = grantedAmmo;
        } else if (canUseWeaponPickup(player, pickup) && pickup.weaponId && this.hasUnconsumedUse(player.id)) {
          const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
          if (existing) {
            const definition = WEAPONS[existing.id];
            const ammunition = pickup.weaponState
              ? pickup.weaponState.magazine + pickup.weaponState.reserve
              : definition.magazineSize;
            const reserveGrant = Math.min(Math.max(0, definition.maxReserve - existing.reserve), ammunition);
            existing.reserve += reserveGrant;
            grantedAmount = reserveGrant;
            consumed = grantedAmount > 0;
          } else if (player.inventory.length < 2) {
            player.inventory.push(this.weaponFromPickup(pickup));
            consumed = true;
          } else {
            player.inventory[player.activeWeapon] = this.weaponFromPickup(pickup);
            player.equipTimer = WEAPON_EQUIP_SECONDS;
            consumed = true;
          }
        }
        if (consumed) {
          if (pickup.kind === 'weapon') this.consumeUse(player.id);
          if (pickup.temporary && pickup.kind === 'grenade') {
            // A two-grenade death pile can be shared: a player carrying one
            // takes only the free slot and leaves the second grenade behind.
            pickup.amount = Math.max(0, pickup.amount - grantedAmount);
            removeTemporaryPickup = pickup.amount === 0;
          } else if (pickup.temporary) removeTemporaryPickup = true;
          else {
            pickup.available = false;
            pickup.respawnTimer = pickup.respawnSeconds;
          }
          this.pushEvent({
            type: 'pickup',
            actorId: player.id,
            weaponId: pickup.weaponId,
            position: cloneVec3(pickup.position),
            amount: grantedAmount || undefined,
          });
          break;
        }
      }
      if (!removeTemporaryPickup) remainingPickups.push(pickup);
    }
    this.state.pickups = remainingPickups;
  }

  private weaponFromPickup(pickup: PickupState): PlayerState['inventory'][number] {
    if (!pickup.weaponId) throw new Error('A weapon pickup must identify its weapon');
    if (!pickup.weaponState) return createWeaponState(pickup.weaponId);
    const definition = WEAPONS[pickup.weaponId];
    return {
      ...pickup.weaponState,
      id: pickup.weaponId,
      magazine: clamp(Math.floor(pickup.weaponState.magazine), 0, definition.magazineSize),
      reserve: clamp(Math.floor(pickup.weaponState.reserve), 0, definition.maxReserve),
      cooldown: 0,
      reloadTimer: 0,
      bloom: 0,
      burstRemaining: 0,
      burstRoundIndex: 0,
      burstTimer: 0,
    };
  }

  private hasUnconsumedUse(playerId: string): boolean {
    return this.usePressedThisTick.has(playerId) && !this.consumedUseThisTick.has(playerId);
  }

  private consumeUse(playerId: string): void {
    this.consumedUseThisTick.add(playerId);
  }

  private updateFlags(dt: number): void {
    if (this.state.config.mode !== 'capture-the-flag') return;
    for (const flag of this.state.flags) {
      if (flag.status === 'carried' && flag.carrierId) {
        const carrier = this.state.players[flag.carrierId];
        if (!carrier?.alive) {
          flag.status = 'dropped';
          flag.carrierId = null;
          flag.returnTimer = 12;
        } else {
          flag.position = add(carrier.position, vec3(0, 1.6, 0));
          const ownBase = this.map.flagBases[carrier.team as Exclude<Team, 'neutral'>];
          const ownFlag = this.state.flags.find((candidate) => candidate.team === carrier.team);
          if (ownBase && ownFlag?.status === 'home' && distanceSquared(carrier.position, ownBase) < 4) {
            this.state.teamScores[carrier.team as Exclude<Team, 'neutral'>] += 1;
            carrier.score += 1;
            carrier.carryingFlagTeam = null;
            this.resetFlag(flag, `${carrier.name} capturó la bandera`, {
              actorId: carrier.id,
              actorTeam: carrier.team,
              flagAction: 'captured',
            });
          }
        }
      } else if (flag.status === 'dropped') {
        flag.returnTimer -= dt;
        if (flag.returnTimer <= 0) this.resetFlag(flag, `La bandera ${flag.team} volvió a base`, {
          flagAction: 'returned',
        });
      }

      if (flag.status !== 'carried') {
        for (const player of Object.values(this.state.players)) {
          if (!player.alive || distanceSquared(player.position, flag.position) > 2.25) continue;
          if (player.team === flag.team) {
            if (flag.status === 'dropped') this.resetFlag(flag, `${player.name} devolvió la bandera`, {
              actorId: player.id,
              actorTeam: player.team,
              flagAction: 'returned',
            });
          } else if (!player.carryingFlagTeam && player.team !== 'neutral') {
            flag.status = 'carried';
            flag.carrierId = player.id;
            player.carryingFlagTeam = flag.team;
            player.spawnProtection = 0;
            this.pushEvent({
              type: 'flag',
              actorId: player.id,
              actorTeam: player.team,
              flagTeam: flag.team,
              flagAction: 'taken',
              message: `${player.name} tomó la bandera`,
            });
          }
        }
      }
    }
  }

  private dropCarriedFlag(player: PlayerState): void {
    if (!player.carryingFlagTeam) return;
    const flag = this.state.flags.find((candidate) => candidate.team === player.carryingFlagTeam);
    if (flag) {
      flag.status = 'dropped';
      flag.carrierId = null;
      flag.position = cloneVec3(player.position);
      flag.returnTimer = 12;
      this.pushEvent({
        type: 'flag',
        actorId: player.id,
        actorTeam: player.team,
        flagTeam: flag.team,
        flagAction: 'dropped',
        position: cloneVec3(player.position),
        message: `${player.name} soltó la bandera`,
      });
    }
    player.carryingFlagTeam = null;
  }

  private resetFlag(
    flag: MatchState['flags'][number],
    message: string,
    metadata: Pick<GameEvent, 'actorId' | 'actorTeam' | 'flagAction'> = {},
  ): void {
    if (flag.carrierId) {
      const carrier = this.state.players[flag.carrierId];
      if (carrier) carrier.carryingFlagTeam = null;
    }
    flag.position = cloneVec3(flag.basePosition);
    flag.status = 'home';
    flag.carrierId = null;
    flag.returnTimer = 0;
    this.pushEvent({
      type: 'flag',
      ...metadata,
      flagTeam: flag.team,
      position: cloneVec3(flag.position),
      message,
    });
  }

  private updateTower(dt: number): void {
    if (this.state.config.mode !== 'towah-of-powah') return;
    const occupants = Object.values(this.state.players).filter(
      (player) => player.alive
        && player.position.y >= this.map.towerZone.controlMinY
        && distanceSquared(player.position, this.state.tower.center) <= this.state.tower.radius ** 2,
    );
    const teams = new Set(occupants.map((player) => player.team));
    if (teams.size === 1) {
      const [team] = teams;
      if (team) {
        this.state.tower.controllingTeam = team;
      }
    } else if (teams.size > 1) {
      this.state.tower.controllingTeam = 'neutral';
    } else {
      this.state.tower.controllingTeam = 'neutral';
    }

    const previousOperator = this.state.tower.turretOwnerId
      ? this.state.players[this.state.tower.turretOwnerId]
      : null;
    if (!previousOperator || !canUseTowerTurret(previousOperator, this.state.tower)) {
      if (this.state.tower.turretOwnerId) this.releaseTurret(this.state.tower.turretOwnerId);
      else this.state.tower.turretOwnerId = null;
    }

    const currentOperator = this.state.tower.turretOwnerId
      ? this.state.players[this.state.tower.turretOwnerId]
      : null;
    if (currentOperator && this.hasUnconsumedUse(currentOperator.id)) {
      this.consumeUse(currentOperator.id);
      this.releaseTurret(currentOperator.id);
    } else if (!currentOperator) {
      const candidate = Object.values(this.state.players)
        .filter((player) => canUseTowerTurret(player, this.state.tower) && this.hasUnconsumedUse(player.id))
        .sort((left, right) => {
          const distanceDelta = horizontalDistanceSquared(left.position, this.state.tower.center)
            - horizontalDistanceSquared(right.position, this.state.tower.center);
          return distanceDelta || left.id.localeCompare(right.id);
        })[0];
      if (candidate) {
        this.consumeUse(candidate.id);
        this.mountTurret(candidate);
      }
    }

    this.state.tower.turretCooldown = Math.max(0, this.state.tower.turretCooldown - dt);
    const controller = this.state.tower.turretOwnerId ? this.state.players[this.state.tower.turretOwnerId] : null;
    if (!controller) return;
    this.state.tower.turretYaw = controller.yaw;
    this.state.tower.turretPitch = clamp(
      controller.pitch,
      TOWER_TURRET_LAYOUT.minPitch,
      TOWER_TURRET_LAYOUT.maxPitch,
    );
    if (!controller.input.fire || this.state.tower.turretCooldown > 0) return;

    const turretOrigin = towerTurretFiringOrigin(this.state.tower.center);
    const direction = directionFromAngles(this.state.tower.turretYaw, this.state.tower.turretPitch);
    const hit = raycastWorld(
      turretOrigin,
      direction,
      70,
      this.map,
      Object.values(this.state.players),
      controller.id,
    );
    const endpoint = hit?.point ?? add(turretOrigin, scale(direction, 70));
    this.state.tower.turretCooldown = 0.14;
    this.pushEvent({
      type: 'shot',
      actorId: controller.id,
      weaponId: 'pulse-rifle',
      position: cloneVec3(endpoint),
      impact: hit !== null,
      message: 'Torreta',
    });
    if (!hit?.playerId) return;
    const target = this.state.players[hit.playerId];
    if (target && isEnemy(this.state, controller, target)) {
      const definition = WEAPONS['pulse-rifle'];
      this.applyDamage(target, 13, controller, {
        weaponId: 'pulse-rifle',
        position: hit.point,
        sourcePosition: turretOrigin,
        headshot: Boolean(hit.headshot),
        headshotMode: definition.headshotMode,
        headMultiplier: definition.headMultiplier,
      });
    }
  }

  private mountTurret(player: PlayerState): void {
    this.state.tower.turretOwnerId = player.id;
    this.state.tower.turretYaw = player.yaw;
    this.state.tower.turretPitch = clamp(
      player.pitch,
      TOWER_TURRET_LAYOUT.minPitch,
      TOWER_TURRET_LAYOUT.maxPitch,
    );
    const weapon = player.inventory[player.activeWeapon];
    if (weapon) this.cancelWeaponAction(weapon);
    this.holdTurretOperator(player);
  }

  private safeTurretExitPosition(player: PlayerState): Vec3 {
    const angularOffsets = [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 4, -Math.PI / 4];
    const radii = [TOWER_TURRET_LAYOUT.exitRadius, TOWER_TURRET_LAYOUT.exitRadius + 0.9, TOWER_TURRET_LAYOUT.exitRadius + 1.8];
    const otherPlayers = Object.values(this.state.players).filter(
      (candidate) => candidate.id !== player.id && candidate.alive,
    );
    let mapSafeFallback: Vec3 | null = null;

    for (const radius of radii) {
      for (const angularOffset of angularOffsets) {
        const yaw = wrapAngle(player.yaw + angularOffset);
        const forward = directionFromAngles(yaw, 0);
        const candidate = {
          x: this.state.tower.center.x - forward.x * radius,
          y: this.state.tower.center.y,
          z: this.state.tower.center.z - forward.z * radius,
        };
        if (!canOccupyCapsule(candidate, player.radius, FIXED_PLAYER_HEIGHT, this.map)) continue;
        mapSafeFallback ??= candidate;
        const occupied = otherPlayers.some((other) =>
          Math.abs(other.position.y - candidate.y) < Math.max(other.height, FIXED_PLAYER_HEIGHT)
          && horizontalDistanceSquared(other.position, candidate)
            < (other.radius + player.radius + TURRET_EXIT_CLEARANCE) ** 2,
        );
        if (!occupied) return candidate;
      }
    }
    return mapSafeFallback ?? {
      x: this.state.tower.center.x,
      y: this.state.tower.center.y,
      z: this.state.tower.center.z + TOWER_TURRET_LAYOUT.exitRadius,
    };
  }

  private releaseTurret(playerId: string, reposition = true): void {
    if (this.state.tower.turretOwnerId !== playerId) return;
    this.state.tower.turretOwnerId = null;
    const player = this.state.players[playerId];
    if (!reposition || !player?.alive) return;
    player.position = this.safeTurretExitPosition(player);
    player.velocity = vec3();
    player.height = FIXED_PLAYER_HEIGHT;
    player.crouched = false;
    player.grounded = true;
  }

  private spawnPlayer(player: PlayerState, initial: boolean): void {
    this.releaseTurret(player.id);
    this.damageContributors.delete(player.id);
    const matching = this.map.spawns.filter((spawn) => {
      if (!isTeamMode(this.state)) return true;
      return spawn.team === player.team;
    });
    const enemies = Object.values(this.state.players).filter((candidate) => candidate.alive && isEnemy(this.state, player, candidate));
    const allies = Object.values(this.state.players).filter((candidate) => candidate.alive && candidate.id !== player.id && candidate.team === player.team);
    const ranked = matching
      .map((spawn) => {
        let score = 0;
        for (const enemy of enemies) {
          const separation = distance(spawn.position, enemy.position);
          score += Math.min(25, separation);
          if (separation < 10) score -= 80;
          if (separation < 18 && hasLineOfSight(add(spawn.position, vec3(0, 1.3, 0)), add(enemy.position, vec3(0, 1.3, 0)), this.map)) score -= 60;
        }
        for (const ally of allies) {
          const separation = distance(spawn.position, ally.position);
          if (separation < 3) score -= 45;
          else score += Math.min(6, separation * 0.2);
        }
        return { spawn, score: score + randomRange(this.state, 0, 4) };
      })
      .sort((a, b) => b.score - a.score);
    const selection = ranked[Math.floor(randomRange(this.state, 0, Math.min(3, ranked.length)))]?.spawn ?? this.map.spawns[0];
    if (!selection) return;
    player.position = cloneVec3(selection.position);
    player.velocity = vec3();
    player.height = FIXED_PLAYER_HEIGHT;
    player.crouched = false;
    player.grounded = true;
    player.yaw = selection.yaw;
    player.pitch = 0;
    player.alive = true;
    player.health = MAX_HEALTH;
    player.maxShield = this.state.config.mode === 'towah-of-powah' ? 0 : player.isJuggernaut ? 150 : 100;
    player.shield = player.maxShield;
    player.overshieldDecayDelay = 0;
    player.grenades = MAX_PLAYER_GRENADES;
    player.meleeCooldown = 0;
    player.grenadeCooldown = 0;
    player.equipTimer = 0;
    player.aimSuppressed = false;
    player.spawnProtection = 1;
    player.respawnTimer = 0;
    const loadout = this.state.config.mode === 'towah-of-powah' ? TOWER_LOADOUT : DEFAULT_LOADOUT;
    player.inventory = loadout.map(createWeaponState);
    player.activeWeapon = 0;
    player.input = { ...emptyInput(), yaw: player.yaw };
    this.previousButtons.set(player.id, noButtons());
    player.movementMemory = createPlayerMovementMemory();
    if (!initial) this.pushEvent({ type: 'respawn', actorId: player.id, position: cloneVec3(player.position) });
  }

  private evaluateMatchEnd(): void {
    if (this.state.phase !== 'playing') return;
    const limit = this.state.config.scoreLimit;
    let winner: Team | string | null = null;
    if (isTeamMode(this.state)) {
      const { aurora, nova } = this.state.teamScores;
      if ((aurora >= limit || nova >= limit) && aurora !== nova) winner = aurora > nova ? 'aurora' : 'nova';
    } else {
      const leader = Object.values(this.state.players).sort((a, b) => b.score - a.score)[0];
      if (leader && leader.score >= limit) winner = leader.id;
    }
    if (!winner && this.state.timeRemaining <= 0) {
      if (isTeamMode(this.state)) {
        if (this.state.teamScores.aurora !== this.state.teamScores.nova) winner = this.state.teamScores.aurora > this.state.teamScores.nova ? 'aurora' : 'nova';
      } else {
        const ranked = Object.values(this.state.players).sort((a, b) => b.score - a.score);
        if (ranked[0] && ranked[0].score !== ranked[1]?.score) winner = ranked[0].id;
      }
      if (!winner) this.state.timeRemaining = 30;
    }
    if (winner) {
      this.state.winner = winner;
      this.state.phase = 'finished';
      const label = winner === 'aurora' ? 'Aurora' : winner === 'nova' ? 'Nova' : this.state.players[winner]?.name ?? 'Sin vencedor';
      this.pushEvent({ type: 'match-end', message: `Victoria: ${label}` });
    }
  }

  private pushEvent(event: Omit<GameEvent, 'id' | 'time'>): void {
    this.state.events.push({ ...event, id: ++this.state.eventSequence, time: this.state.elapsed });
    while (this.state.events.length > 80) {
      // Gunfire can produce many transient events in a single firefight. Keep
      // the sparse events needed by the kill feed and objective announcer.
      const transientIndex = this.state.events.findIndex((candidate) =>
        !PRIORITY_EVENT_TYPES.has(candidate.type),
      );
      this.state.events.splice(transientIndex >= 0 ? transientIndex : 0, 1);
    }
  }

  private ensureJuggernaut(): void {
    if (this.state.config.mode !== 'juggernaut') return;
    const current = this.state.juggernautId ? this.state.players[this.state.juggernautId] : null;
    if (current?.alive && current.isJuggernaut) return;
    const successor = Object.values(this.state.players).find((candidate) => candidate.alive);
    if (successor) this.makeJuggernaut(successor);
  }
}

export const createDefaultConfig = (overrides: Partial<MatchConfig> = {}): MatchConfig => {
  const mode = overrides.mode ?? 'deathmatch';
  const format = canonicalFormatForMode(mode);
  return {
    mode,
    format,
    playerCount: normalizedPlayerCount(mode, overrides.playerCount),
    difficulty: overrides.difficulty ?? ('veteran' satisfies Difficulty),
    scoreLimit: overrides.scoreLimit ?? recommendedScoreLimit(mode, format),
    timeLimitSeconds: overrides.timeLimitSeconds ?? recommendedTimeLimit(mode, format),
    botFill: overrides.botFill ?? true,
    playerName: overrides.playerName ?? 'Astronauta',
    mapId: overrides.mapId ?? 'crater-ridge',
  };
};
