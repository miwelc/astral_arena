import { hasLineOfSight, moveCapsule, raycastWorld } from './collision';
import { isJumpPad, MAPS } from './map';
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
  normalize,
  randomRange,
  scale,
  subtract,
  vec3,
  wrapAngle,
} from './math';
import type {
  Difficulty,
  GameEvent,
  MapDefinition,
  MatchConfig,
  MatchState,
  PlayerInput,
  PlayerKind,
  PlayerState,
  ProjectileState,
  Team,
  Vec3,
  WeaponId,
} from './types';
import { createWeaponState, DEFAULT_LOADOUT, TOWER_LOADOUT, WEAPONS } from './weapons';
import { createBotMemory, updateBotInputs } from './bots';

const FIXED_PLAYER_HEIGHT = 1.8;
const FIXED_PLAYER_RADIUS = 0.48;
const GRAVITY = 18;
const MOVE_SPEED = 7.6;
const GROUND_ACCELERATION = 38;
const AIR_ACCELERATION = 9;
const SHIELD_RECHARGE_DELAY = 4;
const SHIELD_RECHARGE_RATE = 25;
const MAX_HEALTH = 70;
const BOT_NAMES = ['Orion', 'Vega', 'Lyra', 'Atlas', 'Sol', 'Mira', 'Pulsar', 'Cosmo'];

interface ButtonState {
  fire: boolean;
  jump: boolean;
  reload: boolean;
  swap: boolean;
  melee: boolean;
  grenade: boolean;
}

const noButtons = (): ButtonState => ({ fire: false, jump: false, reload: false, swap: false, melee: false, grenade: false });

const teamForSlot = (config: MatchConfig, slot: number): Team => {
  if (config.mode === 'deathmatch' || (config.mode === 'juggernaut' && config.format === 'duel')) return 'neutral';
  return slot % 2 === 0 ? 'aurora' : 'nova';
};

const isTeamMode = (state: MatchState): boolean =>
  state.config.mode !== 'deathmatch' && !(state.config.mode === 'juggernaut' && state.config.format === 'duel');

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

export const recommendedScoreLimit = (mode: MatchConfig['mode'], format: MatchConfig['format']): number => {
  if (mode === 'capture-the-flag') return format === 'duel' ? 3 : 5;
  if (mode === 'juggernaut') return format === 'duel' ? 15 : 25;
  if (mode === 'team-deathmatch') return format === 'duel' ? 15 : 50;
  if (mode === 'towah-of-powah') return format === 'duel' ? 15 : 50;
  return format === 'duel' ? 15 : 25;
};

export const recommendedTimeLimit = (mode: MatchConfig['mode'], format: MatchConfig['format']): number => {
  if (mode === 'capture-the-flag') return (format === 'duel' ? 8 : 12) * 60;
  if (mode === 'deathmatch' && format === 'squads') return 10 * 60;
  return (format === 'duel' ? 8 : 10) * 60;
};

export class GameSimulation {
  public readonly map: MapDefinition;
  public state: MatchState;
  private readonly previousButtons = new Map<string, ButtonState>();
  private projectileSequence = 0;

  public constructor(config: MatchConfig, initialHumans: Array<{ id: string; name: string; kind?: PlayerKind }> = []) {
    this.map = MAPS[config.mapId];
    const seed = hashString(`${config.mode}:${config.format}:${Date.now()}`);
    this.state = {
      version: 1,
      matchId: `arena-${seed.toString(36)}`,
      config: { ...config },
      tick: 0,
      elapsed: 0,
      timeRemaining: config.timeLimitSeconds,
      phase: 'countdown',
      countdown: 3,
      winner: null,
      players: {},
      projectiles: [],
      pickups: this.map.pickups
        .filter((pickup) => config.mode !== 'towah-of-powah' || (pickup.kind !== 'overshield' && (pickup.kind !== 'weapon' || pickup.weaponId === 'shotgun')))
        .map((pickup) => ({ ...pickup, position: cloneVec3(pickup.position), available: true, respawnTimer: 0 })),
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
        radius: 7,
        controllingTeam: 'neutral',
        turretOwnerId: null,
        turretCooldown: 0,
      },
      teamScores: { aurora: 0, nova: 0 },
      juggernautId: null,
      eventSequence: 0,
      events: [],
      randomState: seed,
    };

    initialHumans.forEach((human, index) => this.insertPlayer(human.id, human.name, human.kind ?? 'human', teamForSlot(config, index)));
    if (config.botFill) this.fillWithBots();
    if (config.mode === 'juggernaut') this.assignInitialJuggernaut();
  }

  public get maxPlayers(): number {
    return this.state.config.format === 'duel' ? 2 : 8;
  }

  public setInput(playerId: string, input: PlayerInput): void {
    const player = this.state.players[playerId];
    if (!player || player.kind === 'bot') return;
    if (![input.sequence, input.moveX, input.moveZ, input.yaw, input.pitch].every(Number.isFinite)) return;
    player.input = {
      ...input,
      moveX: clamp(input.moveX, -1, 1),
      moveZ: clamp(input.moveZ, -1, 1),
      yaw: wrapAngle(input.yaw),
      pitch: clamp(input.pitch, -1.48, 1.48),
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
        if (inheritedJuggernaut) this.state.juggernautId = null;
        delete this.state.players[replacement.id];
        this.previousButtons.delete(replacement.id);
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
    delete this.state.players[id];
    this.previousButtons.delete(id);
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
    this.state.events = this.state.events.filter((event) => this.state.elapsed - event.time < 4);

    if (this.state.phase === 'countdown') {
      this.state.countdown = Math.max(0, this.state.countdown - safeDt);
      if (this.state.countdown <= 0) this.state.phase = 'playing';
    }
    if (this.state.phase === 'finished') return;

    this.state.elapsed += safeDt;
    if (this.state.phase === 'playing') this.state.timeRemaining = Math.max(0, this.state.timeRemaining - safeDt);

    updateBotInputs(this.state, this.map, safeDt, (from, to) => hasLineOfSight(from, to, this.map));
    for (const player of Object.values(this.state.players)) this.updatePlayer(player, safeDt);
    this.updateProjectiles(safeDt);
    if (this.state.phase === 'playing') {
      this.updatePickups(safeDt);
      this.updateFlags(safeDt);
      this.updateTower(safeDt);
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
      grenades: 2,
      meleeCooldown: 0,
      grenadeCooldown: 0,
      input: emptyInput(),
      lastProcessedInput: 0,
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
    player.spawnProtection = Math.max(0, player.spawnProtection - dt);
    for (const weapon of player.inventory) {
      weapon.cooldown = Math.max(0, weapon.cooldown - dt);
      if (weapon.reloadTimer > 0) {
        weapon.reloadTimer = Math.max(0, weapon.reloadTimer - dt);
        if (weapon.reloadTimer === 0) {
          const definition = WEAPONS[weapon.id];
          const amount = Math.min(definition.magazineSize - weapon.magazine, weapon.reserve);
          weapon.magazine += amount;
          weapon.reserve -= amount;
        }
      }
    }

    if (!player.alive) {
      player.respawnTimer -= dt;
      if (player.respawnTimer <= 0) this.spawnPlayer(player, false);
      return;
    }

    if (player.shield > player.maxShield) {
      player.overshieldDecayDelay = Math.max(0, player.overshieldDecayDelay - dt);
      if (player.overshieldDecayDelay === 0) player.shield = Math.max(player.maxShield, player.shield - 5 * dt);
    } else if (player.maxShield > 0 && this.state.elapsed - player.lastDamageAt >= (player.isJuggernaut ? 5 : SHIELD_RECHARGE_DELAY)) {
      player.shield = Math.min(player.maxShield, player.shield + SHIELD_RECHARGE_RATE * dt);
    }

    player.yaw = player.input.yaw;
    player.pitch = clamp(player.input.pitch, -1.48, 1.48);
    player.lastProcessedInput = Math.max(player.lastProcessedInput, player.input.sequence);

    const previous = this.previousButtons.get(player.id) ?? noButtons();
    const canAct = this.state.phase === 'playing';
    if (canAct) this.updateMovement(player, dt, !previous.jump && player.input.jump);

    const currentWeapon = player.inventory[player.activeWeapon];
    if (currentWeapon && canAct) {
      if (!previous.swap && player.input.swap && player.inventory.length > 1) player.activeWeapon = (player.activeWeapon + 1) % player.inventory.length;
      if (!previous.reload && player.input.reload) this.startReload(player);
      const definition = WEAPONS[currentWeapon.id];
      const wantsFire = player.input.fire && (definition.automatic || !previous.fire);
      if (wantsFire) this.fireWeapon(player);
      if (!previous.melee && player.input.melee) this.melee(player);
      if (!previous.grenade && player.input.grenade) this.throwGrenade(player);
    }

    this.previousButtons.set(player.id, {
      fire: player.input.fire,
      jump: player.input.jump,
      reload: player.input.reload,
      swap: player.input.swap,
      melee: player.input.melee,
      grenade: player.input.grenade,
    });
  }

  private updateMovement(player: PlayerState, dt: number, jumpPressed: boolean): void {
    const forward = { x: -Math.sin(player.yaw), y: 0, z: -Math.cos(player.yaw) };
    const right = { x: Math.cos(player.yaw), y: 0, z: -Math.sin(player.yaw) };
    let wish = add(scale(right, player.input.moveX), scale(forward, player.input.moveZ));
    if (dot(wish, wish) > 1) wish = normalize(wish);
    const speedModifier = (player.isJuggernaut ? 0.95 : 1) * (player.carryingFlagTeam ? 0.95 : 1);
    const desired = scale(wish, MOVE_SPEED * speedModifier);
    const acceleration = player.grounded ? GROUND_ACCELERATION : AIR_ACCELERATION;
    const maxChange = acceleration * dt;
    const changeX = clamp(desired.x - player.velocity.x, -maxChange, maxChange);
    const changeZ = clamp(desired.z - player.velocity.z, -maxChange, maxChange);
    player.velocity.x += changeX;
    player.velocity.z += changeZ;
    if (dot(wish, wish) < 0.01 && player.grounded) {
      const friction = Math.max(0, 1 - 10 * dt);
      player.velocity.x *= friction;
      player.velocity.z *= friction;
    }
    if (jumpPressed && player.grounded) {
      player.velocity.y = 6.3;
      player.grounded = false;
    }
    if (isJumpPad(player.position) && player.grounded) {
      const side = player.position.x < 0 ? -1 : 1;
      player.position.x = side * 5.8;
      player.position.y = 5.92;
      player.velocity.y = 2.8;
      player.velocity.x = -side * 3;
      player.grounded = false;
    }
    player.velocity.y -= GRAVITY * dt;
    const movement = moveCapsule(player, this.map, dt);
    player.position = movement.position;
    player.velocity = movement.velocity;
    player.grounded = movement.grounded;
  }

  private startReload(player: PlayerState): void {
    const weapon = player.inventory[player.activeWeapon];
    if (!weapon || weapon.reloadTimer > 0 || weapon.reserve <= 0) return;
    const definition = WEAPONS[weapon.id];
    if (weapon.magazine >= definition.magazineSize) return;
    weapon.reloadTimer = definition.reloadSeconds;
    this.pushEvent({ type: 'reload', actorId: player.id, weaponId: weapon.id });
  }

  private fireWeapon(player: PlayerState): void {
    const weapon = player.inventory[player.activeWeapon];
    if (!weapon || weapon.cooldown > 0 || weapon.reloadTimer > 0) return;
    const definition = WEAPONS[weapon.id];
    const ammunitionCost = weapon.id === 'battle-rifle' ? 3 : 1;
    if (weapon.magazine < ammunitionCost) {
      this.startReload(player);
      return;
    }
    weapon.magazine -= ammunitionCost;
    weapon.cooldown = definition.fireInterval;
    player.spawnProtection = 0;
    const origin = { x: player.position.x, y: player.position.y + 1.5, z: player.position.z };
    const baseDirection = directionFromAngles(player.yaw, player.pitch);
    this.pushEvent({ type: 'shot', actorId: player.id, weaponId: weapon.id, position: origin });

    if (definition.projectile === 'rocket') {
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
        fuse: 5,
        alive: true,
      });
      return;
    }

    for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
      const spreadScale = definition.spread;
      const direction = normalize({
        x: baseDirection.x + randomRange(this.state, -spreadScale, spreadScale),
        y: baseDirection.y + randomRange(this.state, -spreadScale, spreadScale),
        z: baseDirection.z + randomRange(this.state, -spreadScale, spreadScale),
      });
      const hit = raycastWorld(origin, direction, definition.range, this.map, Object.values(this.state.players), player.id);
      if (!hit?.playerId) continue;
      const target = this.state.players[hit.playerId];
      if (!target || !isEnemy(this.state, player, target)) continue;
      let amount = definition.damage;
      if (hit.headshot && (target.shield <= 0 || weapon.id === 'sniper')) amount *= definition.headMultiplier;
      this.applyDamage(target, amount, player, weapon.id, hit.point);
    }
    if (weapon.magazine === 0) this.startReload(player);
  }

  private melee(player: PlayerState): void {
    if (player.meleeCooldown > 0) return;
    player.meleeCooldown = 0.85;
    player.spawnProtection = 0;
    const forward = directionFromAngles(player.yaw, 0);
    let best: PlayerState | null = null;
    let bestDistance = 2.15;
    for (const target of Object.values(this.state.players)) {
      if (!target.alive || !isEnemy(this.state, player, target)) continue;
      const delta = subtract(target.position, player.position);
      const targetDistance = distance(player.position, target.position);
      if (targetDistance < bestDistance && dot(normalize(delta), forward) > 0.55 && hasLineOfSight(add(player.position, vec3(0, 1.2, 0)), add(target.position, vec3(0, 1.2, 0)), this.map)) {
        best = target;
        bestDistance = targetDistance;
      }
    }
    if (!best) return;
    const targetForward = directionFromAngles(best.yaw, 0);
    const targetToAttacker = normalize(subtract(player.position, best.position));
    const backStrike = dot(targetForward, targetToAttacker) > 0.62;
    this.pushEvent({ type: 'melee', actorId: player.id, targetId: best.id, position: cloneVec3(best.position) });
    this.applyDamage(best, backStrike ? 220 : 90, player, undefined, best.position);
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
      damage: 120,
      blastRadius: 5.5,
      fuse: 1.7,
      alive: true,
    });
  }

  private applyDamage(target: PlayerState, amount: number, attacker: PlayerState | null, weaponId?: WeaponId, position?: Vec3): void {
    if (!target.alive || target.spawnProtection > 0 || amount <= 0) return;
    if (attacker && attacker.id !== target.id && !isEnemy(this.state, attacker, target)) return;
    target.lastDamageAt = this.state.elapsed;
    const shieldBefore = target.shield;
    const absorbed = Math.min(target.shield, amount);
    target.shield -= absorbed;
    target.health -= amount - absorbed;
    this.pushEvent({ type: 'hit', actorId: attacker?.id, targetId: target.id, weaponId, position: position ? cloneVec3(position) : cloneVec3(target.position), amount });
    if (shieldBefore > 0 && target.shield <= 0) this.pushEvent({ type: 'shield-break', actorId: attacker?.id, targetId: target.id, position: cloneVec3(target.position) });
    if (target.health <= 0) this.killPlayer(target, attacker, weaponId);
  }

  private killPlayer(victim: PlayerState, killer: PlayerState | null, weaponId?: WeaponId): void {
    if (!victim.alive) return;
    victim.alive = false;
    victim.health = 0;
    victim.deaths += 1;
    victim.streak = 0;
    victim.respawnTimer = modeRespawnSeconds(this.state.config);
    victim.velocity = vec3();
    this.dropCarriedFlag(victim);
    if (killer && killer.id !== victim.id) {
      killer.kills += 1;
      killer.streak += 1;
    }
    this.pushEvent({
      type: 'kill',
      actorId: killer?.id,
      targetId: victim.id,
      weaponId,
      position: cloneVec3(victim.position),
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
          this.makeJuggernaut(killer);
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
    for (const projectile of this.state.projectiles) {
      if (!projectile.alive) continue;
      projectile.fuse -= dt;
      const previous = cloneVec3(projectile.position);
      if (projectile.kind === 'grenade') projectile.velocity.y -= GRAVITY * dt;
      projectile.position = add(projectile.position, scale(projectile.velocity, dt));
      let explode = projectile.fuse <= 0;

      if (projectile.position.y <= this.map.bounds.floorY + projectile.radius) {
        if (projectile.kind === 'rocket') explode = true;
        else {
          projectile.position.y = this.map.bounds.floorY + projectile.radius;
          projectile.velocity.y = Math.abs(projectile.velocity.y) * 0.48;
          projectile.velocity.x *= 0.78;
          projectile.velocity.z *= 0.78;
        }
      }

      const directionDelta = subtract(projectile.position, previous);
      const travel = distance(previous, projectile.position);
      if (travel > 0.0001) {
        const hit = raycastWorld(previous, scale(directionDelta, 1 / travel), travel + projectile.radius, this.map, Object.values(this.state.players), projectile.ownerId);
        if (hit) {
          if (projectile.kind === 'rocket') {
            projectile.position = hit.obstacleId
              ? add(hit.point, scale(directionDelta, -(projectile.radius + 0.04) / travel))
              : cloneVec3(hit.point);
            explode = true;
          } else if (hit.playerId) explode = true;
          else if (hit.obstacleId) {
            projectile.position = previous;
            projectile.velocity.x *= -0.42;
            projectile.velocity.z *= -0.42;
          }
        }
      }
      if (explode) this.explode(projectile);
    }
    this.state.projectiles = this.state.projectiles.filter((projectile) => projectile.alive);
  }

  private explode(projectile: ProjectileState): void {
    projectile.alive = false;
    this.pushEvent({ type: 'explosion', actorId: projectile.ownerId, position: cloneVec3(projectile.position) });
    const owner = this.state.players[projectile.ownerId] ?? null;
    for (const target of Object.values(this.state.players)) {
      if (!target.alive) continue;
      const targetCenter = add(target.position, vec3(0, 0.9, 0));
      const targetDistance = distance(projectile.position, targetCenter);
      if (targetDistance > projectile.blastRadius) continue;
      if (!hasLineOfSight(projectile.position, targetCenter, this.map)) continue;
      let amount = projectile.damage * (1 - targetDistance / projectile.blastRadius * 0.82);
      if (owner && target.id === owner.id) amount *= 0.7;
      this.applyDamage(target, amount, owner, projectile.kind === 'rocket' ? 'rocket-launcher' : undefined, projectile.position);
      const impulse = normalize(subtract(targetCenter, projectile.position));
      target.velocity = add(target.velocity, scale(impulse, Math.max(0, 8 - targetDistance)));
    }
  }

  private updatePickups(dt: number): void {
    for (const pickup of this.state.pickups) {
      if (!pickup.available) {
        pickup.respawnTimer = Math.max(0, pickup.respawnTimer - dt);
        if (pickup.respawnTimer === 0) pickup.available = true;
        continue;
      }
      for (const player of Object.values(this.state.players)) {
        if (!player.alive || distanceSquared(player.position, pickup.position) > 2.2) continue;
        let consumed = false;
        if (pickup.kind === 'grenade' && player.grenades < 2) {
          player.grenades += 1;
          consumed = true;
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
        } else if (pickup.kind === 'weapon' && pickup.weaponId) {
          const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
          if (existing) {
            const previousReserve = existing.reserve;
            existing.reserve = Math.min(WEAPONS[existing.id].maxReserve, existing.reserve + WEAPONS[existing.id].magazineSize);
            consumed = existing.reserve > previousReserve;
          } else if (player.inventory.length < 2) {
            player.inventory.push(createWeaponState(pickup.weaponId));
            consumed = true;
          } else {
            player.inventory[player.activeWeapon] = createWeaponState(pickup.weaponId);
            consumed = true;
          }
        }
        if (consumed) {
          pickup.available = false;
          pickup.respawnTimer = pickup.respawnSeconds;
          this.pushEvent({ type: 'pickup', actorId: player.id, weaponId: pickup.weaponId, position: cloneVec3(pickup.position) });
          break;
        }
      }
    }
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
            this.resetFlag(flag, `${carrier.name} capturó la bandera`);
          }
        }
      } else if (flag.status === 'dropped') {
        flag.returnTimer -= dt;
        if (flag.returnTimer <= 0) this.resetFlag(flag, `La bandera ${flag.team} volvió a base`);
      }

      if (flag.status !== 'carried') {
        for (const player of Object.values(this.state.players)) {
          if (!player.alive || distanceSquared(player.position, flag.position) > 2.25) continue;
          if (player.team === flag.team) {
            if (flag.status === 'dropped') this.resetFlag(flag, `${player.name} devolvió la bandera`);
          } else if (!player.carryingFlagTeam && player.team !== 'neutral') {
            flag.status = 'carried';
            flag.carrierId = player.id;
            player.carryingFlagTeam = flag.team;
            player.spawnProtection = 0;
            this.pushEvent({ type: 'flag', actorId: player.id, message: `${player.name} tomó la bandera` });
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
      this.pushEvent({ type: 'flag', actorId: player.id, position: cloneVec3(player.position), message: `${player.name} soltó la bandera` });
    }
    player.carryingFlagTeam = null;
  }

  private resetFlag(flag: MatchState['flags'][number], message: string): void {
    if (flag.carrierId) {
      const carrier = this.state.players[flag.carrierId];
      if (carrier) carrier.carryingFlagTeam = null;
    }
    flag.position = cloneVec3(flag.basePosition);
    flag.status = 'home';
    flag.carrierId = null;
    flag.returnTimer = 0;
    this.pushEvent({ type: 'flag', position: cloneVec3(flag.position), message });
  }

  private updateTower(dt: number): void {
    if (this.state.config.mode !== 'towah-of-powah') return;
    const occupants = Object.values(this.state.players).filter(
      (player) => player.alive && player.position.y >= 5.15 && distanceSquared(player.position, this.state.tower.center) <= this.state.tower.radius ** 2,
    );
    const teams = new Set(occupants.map((player) => player.team));
    if (teams.size === 1) {
      const [team] = teams;
      if (team) {
        this.state.tower.controllingTeam = team;
        this.state.tower.turretOwnerId = occupants[0]?.id ?? null;
      }
    } else if (teams.size > 1) {
      this.state.tower.controllingTeam = 'neutral';
      this.state.tower.turretOwnerId = null;
    } else {
      this.state.tower.controllingTeam = 'neutral';
      this.state.tower.turretOwnerId = null;
    }
    this.state.tower.turretCooldown = Math.max(0, this.state.tower.turretCooldown - dt);
    const controller = this.state.tower.turretOwnerId ? this.state.players[this.state.tower.turretOwnerId] : null;
    if (!controller || this.state.tower.turretCooldown > 0) return;
    const turretOrigin = add(this.state.tower.center, vec3(0, 2.7, 0));
    const target = Object.values(this.state.players)
      .filter((player) => player.alive && isEnemy(this.state, controller, player) && distance(player.position, turretOrigin) < 70)
      .filter((player) => hasLineOfSight(turretOrigin, add(player.position, vec3(0, 1, 0)), this.map))
      .sort((a, b) => distanceSquared(a.position, turretOrigin) - distanceSquared(b.position, turretOrigin))[0];
    if (target) {
      this.state.tower.turretCooldown = 0.14;
      this.pushEvent({ type: 'shot', actorId: controller.id, position: turretOrigin, message: 'Torreta' });
      this.applyDamage(target, 13, controller, 'pulse-rifle', target.position);
    }
  }

  private spawnPlayer(player: PlayerState, initial: boolean): void {
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
    player.yaw = selection.yaw;
    player.pitch = 0;
    player.alive = true;
    player.health = MAX_HEALTH;
    player.maxShield = this.state.config.mode === 'towah-of-powah' ? 0 : player.isJuggernaut ? 150 : 100;
    player.shield = player.maxShield;
    player.overshieldDecayDelay = 0;
    player.grenades = 2;
    player.spawnProtection = 1;
    player.respawnTimer = 0;
    const loadout = this.state.config.mode === 'towah-of-powah' ? TOWER_LOADOUT : DEFAULT_LOADOUT;
    player.inventory = loadout.map(createWeaponState);
    player.activeWeapon = 0;
    player.input = { ...emptyInput(), yaw: player.yaw };
    this.previousButtons.set(player.id, noButtons());
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
    if (this.state.events.length > 80) this.state.events.splice(0, this.state.events.length - 80);
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
  const format = overrides.format ?? 'duel';
  return {
    mode,
    format,
    difficulty: overrides.difficulty ?? ('veteran' satisfies Difficulty),
    scoreLimit: overrides.scoreLimit ?? recommendedScoreLimit(mode, format),
    timeLimitSeconds: overrides.timeLimitSeconds ?? recommendedTimeLimit(mode, format),
    botFill: overrides.botFill ?? true,
    playerName: overrides.playerName ?? 'Astronauta',
    mapId: 'crater-ridge',
  };
};
