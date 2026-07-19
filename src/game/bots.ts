import {
  clamp,
  distance,
  emptyInput,
  hashString,
  horizontalDistance,
  moveAngleToward,
  normalize,
  pitchTo,
  random01,
  randomRange,
  subtract,
  vec3,
  wrapAngle,
  yawTo,
} from './math';
import { PLAYER_PITCH_LIMIT } from './types';
import type {
  BotMemory,
  Difficulty,
  MapDefinition,
  MatchState,
  NavigationTraversal,
  PickupState,
  PlayerInput,
  PlayerState,
  Team,
  Vec3,
  WeaponId,
  WeaponState,
} from './types';
import { TOWER_TURRET_LAYOUT } from './map';
import { isTeamGameMode } from './modeRules';
import { WEAPONS } from './weapons';

export type LineOfSightTest = (from: Vec3, to: Vec3) => boolean;

export interface DifficultyProfile {
  reaction: number;
  decisionInterval: number;
  aimError: number;
  turnRate: number;
  visionRange: number;
  fieldOfView: number;
  fireTolerance: number;
  memorySeconds: number;
  grenadeChance: number;
  jumpChance: number;
  combatMovementScale: number;
  /** Null disables motion-tracker use; otherwise a human-like glance cadence. */
  radarGlanceInterval: readonly [minimum: number, maximum: number] | null;
  /** A sampled contact fades well before the next typical glance. */
  radarMemorySeconds: number;
  /** Horizontal uncertainty applied to a sampled radar contact. */
  radarPositionError: number;
}

interface ObjectivePlan {
  goal: Vec3 | null;
  urgent: boolean;
  pickupId?: string;
}

export const BOT_DIFFICULTY_PROFILES: Readonly<Record<Difficulty, Readonly<DifficultyProfile>>> = {
  recruit: {
    reaction: 0.72,
    decisionInterval: 0.34,
    aimError: 8 * (Math.PI / 180),
    turnRate: 90 * (Math.PI / 180),
    visionRange: 34,
    fieldOfView: 100 * (Math.PI / 180),
    fireTolerance: 3.4 * (Math.PI / 180),
    memorySeconds: 1.6,
    grenadeChance: 0.012,
    jumpChance: 0.015,
    combatMovementScale: 0.78,
    radarGlanceInterval: null,
    radarMemorySeconds: 0,
    radarPositionError: 0,
  },
  veteran: {
    reaction: 0.46,
    decisionInterval: 0.23,
    aimError: 4.8 * (Math.PI / 180),
    turnRate: 145 * (Math.PI / 180),
    visionRange: 48,
    fieldOfView: 116 * (Math.PI / 180),
    fireTolerance: 2.2 * (Math.PI / 180),
    memorySeconds: 2.3,
    grenadeChance: 0.03,
    jumpChance: 0.025,
    combatMovementScale: 0.88,
    radarGlanceInterval: [2.6, 3.8],
    radarMemorySeconds: 1.25,
    radarPositionError: 2.3,
  },
  legend: {
    reaction: 0.28,
    decisionInterval: 0.16,
    aimError: 2.5 * (Math.PI / 180),
    turnRate: 225 * (Math.PI / 180),
    visionRange: 62,
    fieldOfView: 132 * (Math.PI / 180),
    fireTolerance: 1.35 * (Math.PI / 180),
    memorySeconds: 3,
    grenadeChance: 0.05,
    jumpChance: 0.04,
    combatMovementScale: 0.95,
    radarGlanceInterval: [1.45, 2.35],
    radarMemorySeconds: 1.6,
    radarPositionError: 1.25,
  },
};

const TURRET_PROFILE_CACHE = new WeakMap<Readonly<DifficultyProfile>, DifficultyProfile>();

const turretProfileFor = (profile: Readonly<DifficultyProfile>): DifficultyProfile => {
  let turretProfile = TURRET_PROFILE_CACHE.get(profile);
  if (!turretProfile) {
    turretProfile = {
      ...profile,
      visionRange: Math.max(70, profile.visionRange),
      fieldOfView: Math.PI * 2,
    };
    TURRET_PROFILE_CACHE.set(profile, turretProfile);
  }
  return turretProfile;
};

const WEAPON_RANGE: Record<WeaponId, { ideal: number; minimum: number; maximum: number }> = {
  'pulse-rifle': { ideal: 18, minimum: 3, maximum: 46 },
  sidearm: { ideal: 25, minimum: 5, maximum: 62 },
  'battle-rifle': { ideal: 31, minimum: 8, maximum: 76 },
  sniper: { ideal: 48, minimum: 15, maximum: 150 },
  shotgun: { ideal: 5.5, minimum: 0, maximum: 15 },
  'rocket-launcher': { ideal: 22, minimum: 7, maximum: 78 },
};

const MAX_GRENADES = 2;
const PICKUP_PROGRESS_EPSILON = 0.55;
const PICKUP_PROGRESS_TIMEOUT = 4.5;
const PICKUP_INTERACTION_TIMEOUT = 1.4;
const PICKUP_RETRY_DELAY = 9;
const MAX_PICKUP_BLACKLIST = 4;
const MOTION_RADAR_RADIUS = 25;
const MOTION_RADAR_THRESHOLD = 0.55;
const MOTION_RADAR_SHOT_REVEAL_SECONDS = 0.8;
const MOTION_RADAR_ELEVATION_THRESHOLD = 2.4;
const TOWER_PATROL_STEP_SECONDS = 2.4;
const DIRECT_NAVIGATION_HEIGHT = 0.55;

const WEAPON_PICKUP_RATING: Readonly<Record<WeaponId, number>> = {
  'pulse-rifle': 2.5,
  sidearm: 2.4,
  'battle-rifle': 3.5,
  sniper: 4.6,
  shotgun: 4,
  'rocket-launcher': 5,
};

const orderedPlayers = (state: MatchState): PlayerState[] =>
  Object.values(state.players).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

const eyePosition = (player: PlayerState): Vec3 => ({
  x: player.position.x,
  y: player.position.y + Math.min(1.5, player.height * 0.84),
  z: player.position.z,
});

const raisedPoint = (point: Vec3): Vec3 => ({ x: point.x, y: point.y + 1, z: point.z });

const isEnemy = (state: MatchState, player: PlayerState, other: PlayerState): boolean => {
  if (player.id === other.id || !other.alive) return false;
  if (!isTeamGameMode(state.config.mode)) return true;
  return player.team === 'neutral' || other.team === 'neutral' || player.team !== other.team;
};

const isInView = (player: PlayerState, point: Vec3, profile: DifficultyProfile): boolean => {
  const range = horizontalDistance(player.position, point);
  if (range <= 6) return true;
  const angle = Math.abs(wrapAngle(yawTo(player.position, point) - player.yaw));
  return angle <= profile.fieldOfView * 0.5;
};

const canSeePlayer = (
  observer: PlayerState,
  target: PlayerState,
  profile: DifficultyProfile,
  hasLineOfSight: LineOfSightTest,
): boolean =>
  distance(observer.position, target.position) <= profile.visionRange &&
  isInView(observer, target.position, profile) &&
  hasLineOfSight(eyePosition(observer), eyePosition(target));

const targetPriority = (state: MatchState, observer: PlayerState, target: PlayerState, currentId: string | null): number => {
  let score = distance(observer.position, target.position);
  if (target.id === currentId) score -= 5;
  if (target.isJuggernaut) score -= 28;
  if (target.carryingFlagTeam === observer.team) score -= 32;
  if (target.shield <= 0) score -= 4;
  if (state.config.mode === 'towah-of-powah' && horizontalDistance(target.position, state.tower.center) <= state.tower.radius) {
    score -= 8;
  }
  return score;
};

const acquireVisibleTarget = (
  state: MatchState,
  observer: PlayerState,
  profile: DifficultyProfile,
  hasLineOfSight: LineOfSightTest,
  players: readonly PlayerState[] = orderedPlayers(state),
): PlayerState | null => {
  let best: PlayerState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  // Being hit is an awareness cue even when the attacker started just outside
  // the normal field of view. The bot still needs range and line of sight, so
  // this does not become wall vision.
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (!event || state.elapsed - event.time > 1.25) break;
    if (event.type !== 'hit' || event.targetId !== observer.id || !event.actorId) continue;
    const attacker = state.players[event.actorId];
    if (
      attacker?.alive &&
      isEnemy(state, observer, attacker) &&
      distance(observer.position, attacker.position) <= profile.visionRange &&
      hasLineOfSight(eyePosition(observer), eyePosition(attacker))
    ) {
      best = attacker;
      bestScore = targetPriority(state, observer, attacker, observer.bot?.targetId ?? null) - 14;
      break;
    }
  }

  for (const candidate of players) {
    if (!isEnemy(state, observer, candidate) || !canSeePlayer(observer, candidate, profile, hasLineOfSight)) continue;
    const score = targetPriority(state, observer, candidate, observer.bot?.targetId ?? null);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

const firedRecently = (state: MatchState, playerId: string): boolean => {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (!event || state.elapsed - event.time > MOTION_RADAR_SHOT_REVEAL_SECONDS) break;
    if (event.type === 'shot' && event.actorId === playerId && event.time <= state.elapsed) return true;
  }
  return false;
};

/**
 * Mirrors the information available on the player motion tracker: movement is
 * detectable through cover at short range, but crouch-walking is silent and a
 * stationary/crouched target is only exposed briefly by firing. Keeping this
 * predicate independent from line of sight prevents accidental wall shooting;
 * radar contacts are navigation clues, never valid firing solutions.
 */
export const isPlayerRevealedToBotRadar = (
  state: MatchState,
  observer: PlayerState,
  target: PlayerState,
): boolean => {
  if (!isEnemy(state, observer, target)) return false;
  if (horizontalDistance(observer.position, target.position) > MOTION_RADAR_RADIUS) return false;
  if (firedRecently(state, target.id)) return true;
  if (target.crouched) return false;
  return Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z) >= MOTION_RADAR_THRESHOLD;
};

const acquireMotionRadarContact = (
  state: MatchState,
  observer: PlayerState,
  players: readonly PlayerState[],
): PlayerState | null => {
  let selected: PlayerState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of players) {
    if (!isPlayerRevealedToBotRadar(state, observer, candidate)) continue;
    let score = horizontalDistance(observer.position, candidate.position);
    if (candidate.id === observer.bot?.targetId) score -= 3;
    if (firedRecently(state, candidate.id)) score -= 4;
    if (score < bestScore) {
      selected = candidate;
      bestScore = score;
    }
  }
  return selected;
};

/**
 * Takes one deliberate, imperfect snapshot of the motion tracker. Unlike
 * sight, this never updates `targetId` or `lastSeenPosition`: it is only a
 * short-lived navigation clue and can therefore never become a firing
 * solution through cover.
 */
const takeMotionRadarGlance = (
  state: MatchState,
  observer: PlayerState,
  profile: DifficultyProfile,
  players: readonly PlayerState[],
): void => {
  const memory = observer.bot!;
  const interval = profile.radarGlanceInterval;
  if (!interval) {
    memory.radarGlanceTimer = 0;
    memory.radarContactId = null;
    memory.radarContactPosition = null;
    memory.radarContactAt = -1_000_000;
    return;
  }

  memory.radarGlanceTimer = randomRange(state, interval[0], interval[1]);
  const contact = acquireMotionRadarContact(state, observer, players);
  if (!contact) {
    memory.radarContactId = null;
    memory.radarContactPosition = null;
    memory.radarContactAt = state.elapsed;
    return;
  }

  // Each glance produces a new coarse bearing. Holding this fixed between
  // glances is important: moving enemies do not become radar wallhacks.
  const errorAngle = randomRange(state, -Math.PI, Math.PI);
  const errorRadius = randomRange(state, profile.radarPositionError * 0.35, profile.radarPositionError);
  const verticalDelta = contact.position.y - observer.position.y;
  // A human tracker reports only above / level / below, never an exact floor
  // height. Preserve that same coarse cue in the bot's navigation memory.
  const sampledElevation = verticalDelta > MOTION_RADAR_ELEVATION_THRESHOLD
    ? MOTION_RADAR_ELEVATION_THRESHOLD
    : verticalDelta < -MOTION_RADAR_ELEVATION_THRESHOLD
      ? -MOTION_RADAR_ELEVATION_THRESHOLD
      : 0;
  memory.radarContactId = contact.id;
  memory.radarContactPosition = {
    x: contact.position.x + Math.cos(errorAngle) * errorRadius,
    y: observer.position.y + sampledElevation,
    z: contact.position.z + Math.sin(errorAngle) * errorRadius,
  };
  memory.radarContactAt = state.elapsed;
};

const expireMotionRadarContact = (
  state: MatchState,
  memory: BotMemory,
  profile: DifficultyProfile,
): void => {
  if (
    !profile.radarGlanceInterval ||
    state.elapsed - memory.radarContactAt > profile.radarMemorySeconds
  ) {
    memory.radarContactId = null;
    memory.radarContactPosition = null;
  }
};

const ownTeam = (team: Team): Exclude<Team, 'neutral'> | null => (team === 'neutral' ? null : team);

const opposingTeam = (team: Exclude<Team, 'neutral'>): Exclude<Team, 'neutral'> =>
  team === 'aurora' ? 'nova' : 'aurora';

const weaponReplacementIndex = (player: PlayerState, weaponId: WeaponId): number => {
  if (player.inventory.length < 2) return player.inventory.length;
  let weakestIndex = 0;
  for (let index = 1; index < player.inventory.length; index += 1) {
    const candidate = player.inventory[index];
    const weakest = player.inventory[weakestIndex];
    if (candidate && weakest && WEAPON_PICKUP_RATING[candidate.id] < WEAPON_PICKUP_RATING[weakest.id]) {
      weakestIndex = index;
    }
  }
  return WEAPON_PICKUP_RATING[weaponId] > WEAPON_PICKUP_RATING[player.inventory[weakestIndex]?.id ?? weaponId] + 0.45
    ? weakestIndex
    : -1;
};

/** Returns zero when pursuing the pickup cannot improve this bot's current state. */
export const botPickupUtility = (player: PlayerState, pickup: PickupState): number => {
  if (!pickup.available) return 0;
  if (pickup.kind === 'grenade') {
    return player.grenades < MAX_GRENADES ? 11 + (MAX_GRENADES - player.grenades) * 5 : 0;
  }
  if (pickup.kind === 'overshield') {
    if (player.isJuggernaut || player.maxShield <= 0 || player.shield > 150) return 0;
    return 13 + Math.min(75, 175 - player.shield) * 0.14;
  }
  if (pickup.kind === 'ammo') {
    let missingMagazines = 0;
    for (const weapon of player.inventory) {
      const definition = WEAPONS[weapon.id];
      missingMagazines += (definition.maxReserve - weapon.reserve) / Math.max(1, definition.magazineSize);
    }
    return missingMagazines > 0 ? 7 + Math.min(13, missingMagazines * 2.3) : 0;
  }
  if (pickup.kind !== 'weapon' || !pickup.weaponId) return 0;

  const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
  if (existing) {
    const definition = WEAPONS[existing.id];
    const missing = definition.maxReserve - existing.reserve;
    return missing > 0 ? 8 + Math.min(10, missing / Math.max(1, definition.magazineSize) * 3) : 0;
  }

  const replacementIndex = weaponReplacementIndex(player, pickup.weaponId);
  if (replacementIndex < 0) return 0;
  const replaced = player.inventory[replacementIndex];
  const upgrade = replaced ? WEAPON_PICKUP_RATING[pickup.weaponId] - WEAPON_PICKUP_RATING[replaced.id] : 1;
  return 16 + WEAPON_PICKUP_RATING[pickup.weaponId] * 2 + upgrade * 5;
};

const blacklistPickup = (memory: BotMemory, pickupId: string, elapsed: number): void => {
  memory.pickupBlacklist = memory.pickupBlacklist
    .filter((entry) => entry.pickupId !== pickupId && entry.retryAt > elapsed)
    .slice(-(MAX_PICKUP_BLACKLIST - 1));
  memory.pickupBlacklist.push({ pickupId, retryAt: elapsed + PICKUP_RETRY_DELAY });
  if (memory.pickupTargetId === pickupId) memory.pickupTargetId = null;
};

const nearestAvailablePickup = (state: MatchState, player: PlayerState): PickupState | null => {
  const memory = player.bot!;
  memory.pickupBlacklist = memory.pickupBlacklist.filter((entry) => entry.retryAt > state.elapsed);
  const ignoredIds = new Set(memory.pickupBlacklist.map((entry) => entry.pickupId));
  let selected: PickupState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const pickup of state.pickups) {
    if (!pickup.available || ignoredIds.has(pickup.id)) continue;
    const pickupDistance = horizontalDistance(player.position, pickup.position);
    const value = botPickupUtility(player, pickup);
    if (value <= 0) continue;
    const score = pickupDistance - value;
    if (score < bestScore) {
      selected = pickup;
      bestScore = score;
    }
  }
  return selected;
};

const ctfPlan = (state: MatchState, player: PlayerState, map: MapDefinition): ObjectivePlan => {
  const team = ownTeam(player.team);
  if (!team) return { goal: null, urgent: false };
  const enemyTeam = opposingTeam(team);
  const ownFlag = state.flags.find((flag) => flag.team === team);
  const enemyFlag = state.flags.find((flag) => flag.team === enemyTeam);

  if (player.carryingFlagTeam === enemyTeam) {
    player.bot!.objective = 'flag';
    return { goal: map.flagBases[team], urgent: true };
  }

  if (ownFlag?.carrierId) {
    const carrier = state.players[ownFlag.carrierId];
    if (carrier?.alive) {
      player.bot!.objective = 'flag';
      return { goal: carrier.position, urgent: true };
    }
  }

  if (enemyFlag?.carrierId) {
    const carrier = state.players[enemyFlag.carrierId];
    if (carrier?.alive && carrier.team === team) {
      player.bot!.objective = 'defend';
      return { goal: carrier.position, urgent: true };
    }
  }

  const defender = hashString(player.id) % 4 === 0;
  if (defender) {
    player.bot!.objective = 'defend';
    return { goal: ownFlag?.position ?? map.flagBases[team], urgent: false };
  }

  player.bot!.objective = 'flag';
  // A flag run is the primary CTF objective. Treating it as non-urgent made
  // attackers spend too long strafing in incidental fights on the larger map,
  // so entire bot teams could interact with a flag without ever converting a
  // capture. They still aim and shoot, but navigation now keeps forward intent.
  return { goal: enemyFlag?.position ?? map.flagBases[enemyTeam], urgent: true };
};

const juggernautPlan = (state: MatchState, player: PlayerState): ObjectivePlan => {
  const juggernaut = state.juggernautId ? state.players[state.juggernautId] : undefined;
  if (!juggernaut?.alive) return { goal: null, urgent: false };

  if (juggernaut.id === player.id) {
    const pickup = nearestAvailablePickup(state, player);
    player.bot!.objective = pickup ? 'pickup' : 'attack';
    return { goal: pickup?.position ?? null, urgent: false, pickupId: pickup?.id };
  }

  player.bot!.objective = 'attack';
  return { goal: juggernaut.position, urgent: true };
};

const isOnTowerDeck = (state: MatchState, player: PlayerState, map: MapDefinition): boolean =>
  player.position.y >= map.towerZone.controlMinY &&
  horizontalDistance(player.position, state.tower.center) <= state.tower.radius + 0.75;

/**
 * Produces a risk appetite from public objective state, health and score. The
 * bot does not count hidden enemies or read their health: it only knows whether
 * its team owns the hill, the same scoreboard a human sees, and its own status.
 */
export const botTowerCommitment = (state: MatchState, player: PlayerState): number => {
  if (state.config.mode !== 'towah-of-powah') return 0;
  const team = ownTeam(player.team);
  if (!team) return 0.5;

  let commitment = state.tower.controllingTeam === team
    ? 0.42
    : state.tower.controllingTeam === 'neutral'
      ? 0.82
      : 0.96;
  const enemyTeam = opposingTeam(team);
  if (state.teamScores[team] < state.teamScores[enemyTeam]) commitment += 0.08;
  if (player.health >= 70) commitment += 0.08;
  else if (player.health <= 35) commitment -= state.tower.controllingTeam === team ? 0.2 : 0.1;
  if (state.elapsed - player.lastDamageAt < 0.8) commitment -= 0.06;
  return clamp(commitment, 0.28, 1);
};

const nearestTowerPad = (player: PlayerState, map: MapDefinition) => {
  const preferredSide = player.position.x < -0.5
    ? -1
    : player.position.x > 0.5
      ? 1
      : hashString(player.id) % 2 === 0 ? -1 : 1;
  return map.jumpPads.find((pad) => Math.sign(pad.center.x) === preferredSide) ?? map.jumpPads[0] ?? null;
};

const towahPlan = (state: MatchState, player: PlayerState, map: MapDefinition): ObjectivePlan => {
  player.bot!.objective = 'tower';
  const commitment = botTowerCommitment(state, player);
  const teamOwnsTower = state.tower.controllingTeam === player.team;
  const urgent = commitment >= 0.64;
  const pad = nearestTowerPad(player, map);

  if (!isOnTowerDeck(state, player, map)) {
    if (!pad) return { goal: state.tower.center, urgent: true };
    // Once a launch has begun, keep steering toward the deck instead of asking
    // the airborne bot to turn back toward the pad it just left.
    if (player.position.y > 1.8 && !player.grounded) {
      const landingSide = Math.sign(pad.center.x);
      return {
        goal: {
          x: state.tower.center.x + landingSide * map.towerZone.patrolRadius,
          y: state.tower.center.y,
          z: state.tower.center.z,
        },
        urgent: true,
      };
    }
    return {
      goal: { x: pad.center.x, y: pad.center.y + 0.05, z: pad.center.z },
      urgent: true,
    };
  }

  const slot = hashString(player.id) % 8;
  const direction = player.team === 'nova' ? -1 : 1;
  // A neutral/enemy hill must be cleared. Advancing the ring slot prevents the
  // old stalemate where both teams stopped forever on opposite sides of the
  // opaque turret cap. Defenders rotate more slowly and keep useful coverage.
  const stepSeconds = teamOwnsTower ? TOWER_PATROL_STEP_SECONDS * 3 : TOWER_PATROL_STEP_SECONDS;
  const phase = Math.floor(state.elapsed / stepSeconds);
  const angle = (slot + direction * phase) * Math.PI / 4;
  return {
    goal: {
      x: state.tower.center.x + Math.cos(angle) * map.towerZone.patrolRadius,
      y: state.tower.center.y,
      z: state.tower.center.z + Math.sin(angle) * map.towerZone.patrolRadius,
    },
    urgent,
  };
};

const objectivePlan = (state: MatchState, player: PlayerState, map: MapDefinition): ObjectivePlan => {
  if (state.config.mode === 'capture-the-flag') return ctfPlan(state, player, map);
  if (state.config.mode === 'juggernaut') return juggernautPlan(state, player);
  if (state.config.mode === 'towah-of-powah') return towahPlan(state, player, map);

  const pickup = nearestAvailablePickup(state, player);
  if (pickup && horizontalDistance(player.position, pickup.position) <= 30) {
    player.bot!.objective = 'pickup';
    return { goal: pickup.position, urgent: false, pickupId: pickup.id };
  }
  player.bot!.objective = 'attack';
  return { goal: null, urgent: false };
};

const pickupPlanHasStalled = (
  state: MatchState,
  player: PlayerState,
  plan: ObjectivePlan,
): boolean => {
  const memory = player.bot!;
  if (!plan.pickupId || !plan.goal) {
    memory.pickupTargetId = null;
    memory.pickupBestDistance = 1_000_000;
    memory.pickupProgressAt = state.elapsed;
    return false;
  }

  const currentDistance = distance(player.position, plan.goal);
  if (memory.pickupTargetId !== plan.pickupId) {
    memory.pickupTargetId = plan.pickupId;
    memory.pickupBestDistance = currentDistance;
    memory.pickupProgressAt = state.elapsed;
    return false;
  }

  if (currentDistance <= memory.pickupBestDistance - PICKUP_PROGRESS_EPSILON) {
    memory.pickupBestDistance = currentDistance;
    memory.pickupProgressAt = state.elapsed;
    return false;
  }

  const timeout = currentDistance <= 1.8 ? PICKUP_INTERACTION_TIMEOUT : PICKUP_PROGRESS_TIMEOUT;
  if (state.elapsed - memory.pickupProgressAt <= timeout) return false;
  blacklistPickup(memory, plan.pickupId, state.elapsed);
  memory.pickupBestDistance = 1_000_000;
  memory.pickupProgressAt = state.elapsed;
  return true;
};

interface NavigationSelection {
  target: Vec3;
  traversal: NavigationTraversal;
}

interface NavigationEdge {
  to: number;
  traversal: NavigationTraversal;
  cost: number;
}

const navigationAdjacency = (map: MapDefinition): NavigationEdge[][] => {
  const adjacency = Array.from({ length: map.waypoints.length }, () => [] as NavigationEdge[]);
  for (const link of map.waypointLinks ?? []) {
    const from = map.waypoints[link.from];
    const to = map.waypoints[link.to];
    if (!from || !to || link.from === link.to) continue;
    const cost = distance(from, to) + (link.traversal === 'launch' ? 1.5 : 0);
    adjacency[link.from]!.push({ to: link.to, traversal: link.traversal, cost });
    if (link.bidirectional) {
      adjacency[link.to]!.push({ to: link.from, traversal: link.traversal, cost });
    }
  }
  return adjacency;
};

const NAVIGATION_ADJACENCY_CACHE = new WeakMap<MapDefinition, NavigationEdge[][]>();
const NAVIGATION_ROUTE_CACHE = new WeakMap<MapDefinition, Map<number, readonly number[]>>();

const cachedNavigationAdjacency = (map: MapDefinition): NavigationEdge[][] => {
  let adjacency = NAVIGATION_ADJACENCY_CACHE.get(map);
  if (!adjacency) {
    adjacency = navigationAdjacency(map);
    NAVIGATION_ADJACENCY_CACHE.set(map, adjacency);
  }
  return adjacency;
};

const shortestNavigationRoute = (
  map: MapDefinition,
  adjacency: NavigationEdge[][],
  start: number,
  destination: number,
): number[] => {
  const nodeCount = map.waypoints.length;
  const costs = Array.from({ length: nodeCount }, () => Number.POSITIVE_INFINITY);
  const previous = Array.from({ length: nodeCount }, () => -1);
  const visited = new Set<number>();
  costs[start] = 0;

  while (visited.size < nodeCount) {
    let current = -1;
    let currentCost = Number.POSITIVE_INFINITY;
    for (let index = 0; index < nodeCount; index += 1) {
      if (!visited.has(index) && costs[index]! < currentCost) {
        current = index;
        currentCost = costs[index]!;
      }
    }
    if (current < 0 || current === destination) break;
    visited.add(current);
    for (const edge of adjacency[current] ?? []) {
      const candidateCost = currentCost + edge.cost;
      if (candidateCost >= costs[edge.to]!) continue;
      costs[edge.to] = candidateCost;
      previous[edge.to] = current;
    }
  }

  if (start !== destination && previous[destination]! < 0) return [];
  const route = [destination];
  while (route[0] !== start) {
    const parent = previous[route[0]!]!;
    if (parent < 0) return [];
    route.unshift(parent);
  }
  return route;
};

const cachedShortestNavigationRoute = (
  map: MapDefinition,
  start: number,
  destination: number,
): number[] => {
  let routes = NAVIGATION_ROUTE_CACHE.get(map);
  if (!routes) {
    routes = new Map();
    NAVIGATION_ROUTE_CACHE.set(map, routes);
  }
  const key = start * map.waypoints.length + destination;
  let route = routes.get(key);
  if (!route) {
    route = shortestNavigationRoute(map, cachedNavigationAdjacency(map), start, destination);
    routes.set(key, route);
  }
  // Bot memory is part of the mutable simulation snapshot. Keep the cached
  // canonical route private so reconciliation or a test cannot mutate it.
  return route.slice();
};

const closestGraphWaypoint = (
  player: PlayerState,
  map: MapDefinition,
  hasLineOfSight: LineOfSightTest,
): number => {
  const eye = eyePosition(player);
  let selected = -1;
  let selectedScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < map.waypoints.length; index += 1) {
    const waypoint = map.waypoints[index];
    if (!waypoint || Math.abs(waypoint.y - player.position.y) > 1.25) continue;
    const approach = horizontalDistance(player.position, waypoint);
    if (approach > 2.2 && !hasLineOfSight(eye, raisedPoint(waypoint))) continue;
    const score = approach + Math.abs(waypoint.y - player.position.y) * 3;
    if (score < selectedScore) {
      selected = index;
      selectedScore = score;
    }
  }
  return selected;
};

const traversalBetween = (
  map: MapDefinition,
  from: number,
  to: number,
): NavigationTraversal => cachedNavigationAdjacency(map)[from]
  ?.find((edge) => edge.to === to)?.traversal ?? 'walk';

const selectGraphWaypoint = (
  player: PlayerState,
  memory: BotMemory,
  goal: Vec3,
  map: MapDefinition,
  hasLineOfSight: LineOfSightTest,
): NavigationSelection | null => {
  if (!map.waypointLinks?.length || map.waypoints.length === 0) return null;

  let destination = 0;
  let destinationScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < map.waypoints.length; index += 1) {
    const waypoint = map.waypoints[index]!;
    const score = horizontalDistance(waypoint, goal) + Math.abs(waypoint.y - goal.y) * 4;
    if (score < destinationScore) {
      destination = index;
      destinationScore = score;
    }
  }

  memory.navigationRoute ??= [];
  memory.navigationCursor ??= 0;
  memory.navigationGoalIndex ??= null;
  const currentRouteNode = memory.navigationRoute[memory.navigationCursor];
  let start = -1;
  let routeIsStale = memory.navigationGoalIndex !== destination
    || currentRouteNode === undefined
    || !map.waypoints[currentRouteNode];
  if (!routeIsStale && memory.navigationCursor === 0) {
    // The route's first edge depends on the player's current graph entry.
    // Once the cursor advances, the previous route node fully determines that
    // traversal and the expensive closest-node LOS scan is unnecessary.
    start = closestGraphWaypoint(player, map, hasLineOfSight);
    if (start < 0) return null;
  }
  if (
    !routeIsStale
    && currentRouteNode !== undefined
    && horizontalDistance(player.position, map.waypoints[currentRouteNode]!) > 18
  ) {
    if (start < 0) start = closestGraphWaypoint(player, map, hasLineOfSight);
    if (start < 0) return null;
    let routeContainsStart = false;
    for (let index = Math.max(0, memory.navigationCursor - 1); index < memory.navigationRoute.length; index += 1) {
      if (memory.navigationRoute[index] === start) {
        routeContainsStart = true;
        break;
      }
    }
    routeIsStale = !routeContainsStart;
  }
  if (routeIsStale) {
    if (start < 0) start = closestGraphWaypoint(player, map, hasLineOfSight);
    if (start < 0) return null;
    memory.navigationRoute = cachedShortestNavigationRoute(map, start, destination);
    memory.navigationGoalIndex = destination;
    memory.navigationCursor = memory.navigationRoute[0] === start
      && horizontalDistance(player.position, map.waypoints[start]!) <= 2.2
      && Math.abs(player.position.y - map.waypoints[start]!.y) <= 1.25
      ? Math.min(1, Math.max(0, memory.navigationRoute.length - 1))
      : 0;
  }
  if (memory.navigationRoute.length === 0) return null;

  while (memory.navigationCursor < memory.navigationRoute.length - 1) {
    const nodeIndex = memory.navigationRoute[memory.navigationCursor]!;
    const waypoint = map.waypoints[nodeIndex]!;
    if (
      horizontalDistance(player.position, waypoint) > 1.65
      || Math.abs(player.position.y - waypoint.y) > 1.25
    ) break;
    memory.navigationCursor += 1;
  }

  const nodeIndex = memory.navigationRoute[memory.navigationCursor]!;
  const previousIndex = memory.navigationCursor > 0
    ? memory.navigationRoute[memory.navigationCursor - 1]!
    : start >= 0 ? start : nodeIndex;
  const node = map.waypoints[nodeIndex]!;
  memory.waypointIndex = nodeIndex;
  if (
    nodeIndex === destination
    && horizontalDistance(player.position, node) <= 2.2
    && Math.abs(player.position.y - goal.y) <= DIRECT_NAVIGATION_HEIGHT
    && hasLineOfSight(eyePosition(player), raisedPoint(goal))
  ) {
    return { target: goal, traversal: 'walk' };
  }
  return { target: node, traversal: traversalBetween(map, previousIndex, nodeIndex) };
};

const selectWaypoint = (
  player: PlayerState,
  memory: BotMemory,
  goal: Vec3,
  map: MapDefinition,
  hasLineOfSight: LineOfSightTest,
): NavigationSelection => {
  if (
    horizontalDistance(player.position, goal) <= 2.2
    && Math.abs(player.position.y - goal.y) <= DIRECT_NAVIGATION_HEIGHT
  ) return { target: goal, traversal: 'walk' };
  const from = eyePosition(player);
  const directVerticalDifference = Math.abs(goal.y - player.position.y);
  if (
    directVerticalDifference <= DIRECT_NAVIGATION_HEIGHT
    && hasLineOfSight(from, raisedPoint(goal))
  ) return { target: goal, traversal: 'walk' };

  const graphSelection = selectGraphWaypoint(player, memory, goal, map, hasLineOfSight);
  if (graphSelection) return graphSelection;

  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < map.waypoints.length; index += 1) {
    const waypoint = map.waypoints[index];
    if (!waypoint || horizontalDistance(player.position, waypoint) < 1.2) continue;
    if (!hasLineOfSight(from, raisedPoint(waypoint))) continue;
    const progress = horizontalDistance(waypoint, goal);
    const approach = horizontalDistance(player.position, waypoint);
    const heightCost = Math.max(0, waypoint.y - player.position.y) * 0.6;
    const continuityBonus = index === memory.waypointIndex ? 1.5 : 0;
    const score = approach * 0.55 + progress + heightCost - continuityBonus;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex < 0) return { target: goal, traversal: 'walk' };
  memory.waypointIndex = bestIndex;
  return { target: map.waypoints[bestIndex] ?? goal, traversal: 'walk' };
};

const weaponUsable = (weapon: WeaponState): boolean => weapon.magazine > 0 || weapon.reserve > 0;

const weaponScore = (weapon: WeaponState, range: number): number => {
  if (!weaponUsable(weapon)) return -1000;
  const preference = WEAPON_RANGE[weapon.id];
  const distanceFromIdeal = Math.abs(range - preference.ideal);
  let score = 80 - distanceFromIdeal;
  if (range < preference.minimum) score -= (preference.minimum - range) * 8;
  if (range > preference.maximum) score -= (range - preference.maximum) * 3;
  if (weapon.magazine === 0) score -= 24;
  if (weapon.id === 'rocket-launcher' && range < 7) score -= 90;
  if (weapon.id === 'shotgun' && range <= 7) score += 38;
  if (weapon.id === 'sniper' && range >= 28) score += 26;
  return score;
};

const selectWeaponIndex = (player: PlayerState, targetRange: number): number => {
  if (player.carryingFlagTeam) {
    const sidearm = player.inventory.findIndex((weapon) => weapon.id === 'sidearm' && weaponUsable(weapon));
    if (sidearm >= 0) return sidearm;
  }

  let bestIndex = player.activeWeapon;
  // A modest active-weapon bonus prevents oscillation when a target crosses an
  // arbitrary ideal-range boundary, without trapping the bot on an empty gun.
  let bestScore = player.inventory[player.activeWeapon]
    ? weaponScore(player.inventory[player.activeWeapon]!, targetRange) + 7
    : Number.NEGATIVE_INFINITY;
  for (let index = 0; index < player.inventory.length; index += 1) {
    const weapon = player.inventory[index];
    if (!weapon) continue;
    if (index === player.activeWeapon) continue;
    const score = weaponScore(weapon, targetRange);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
};

const movementToLocalInput = (direction: Vec3, yaw: number): Pick<PlayerInput, 'moveX' | 'moveZ'> => {
  const normalized = normalize({ x: direction.x, y: 0, z: direction.z });
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  return {
    moveX: clamp(normalized.x * rightX + normalized.z * rightZ, -1, 1),
    moveZ: clamp(normalized.x * forwardX + normalized.z * forwardZ, -1, 1),
  };
};

const combatMovement = (
  state: MatchState,
  player: PlayerState,
  target: PlayerState,
  navigationDirection: Vec3,
  objectiveIsUrgent: boolean,
): Vec3 => {
  const toTarget = normalize(subtract(target.position, player.position));
  const targetRange = horizontalDistance(player.position, target.position);
  const preferred = player.bot?.preferredRange ?? 18;
  const strafeSign = player.bot?.aimError.z && player.bot.aimError.z < 0 ? -1 : 1;
  const strafe = { x: -toTarget.z * strafeSign, y: 0, z: toTarget.x * strafeSign };

  let radial = vec3();
  if (state.config.mode === 'towah-of-powah') {
    const commitment = botTowerCommitment(state, player);
    if (targetRange > 5.5) radial = {
      x: toTarget.x * commitment,
      y: 0,
      z: toTarget.z * commitment,
    };
    else if (targetRange < 2.5 && commitment < 0.72) radial = {
      x: -toTarget.x * (0.72 - commitment),
      y: 0,
      z: -toTarget.z * (0.72 - commitment),
    };
    return normalize({
      x: radial.x * 0.9 + strafe.x * 0.42 + navigationDirection.x * (0.95 + commitment),
      y: 0,
      z: radial.z * 0.9 + strafe.z * 0.42 + navigationDirection.z * (0.95 + commitment),
    });
  }
  if (targetRange > preferred * 1.18) radial = toTarget;
  else if (targetRange < preferred * 0.72) radial = { x: -toTarget.x, y: 0, z: -toTarget.z };

  const objectiveWeight = objectiveIsUrgent ? 1.2 : 0.35;
  return normalize({
    x: radial.x * 0.8 + strafe.x * 0.72 + navigationDirection.x * objectiveWeight,
    y: 0,
    z: radial.z * 0.8 + strafe.z * 0.72 + navigationDirection.z * objectiveWeight,
  });
};

const avoidNearbyExplosives = (state: MatchState, player: PlayerState, intended: Vec3): Vec3 => {
  let dangerX = 0;
  let dangerZ = 0;
  for (const projectile of state.projectiles) {
    if (projectile.kind === 'bullet') continue;
    if (!projectile.alive || (projectile.ownerId === player.id && projectile.kind !== 'grenade')) continue;
    const range = horizontalDistance(player.position, projectile.position);
    if (range > projectile.blastRadius + 3 || range < 0.01) continue;
    const away = normalize(subtract(player.position, projectile.position));
    const weight = 1 - range / (projectile.blastRadius + 3);
    dangerX += away.x * weight;
    dangerZ += away.z * weight;
  }
  return normalize({ x: intended.x + dangerX * 1.8, y: 0, z: intended.z + dangerZ * 1.8 });
};

const avoidFriendlyCrowding = (
  state: MatchState,
  player: PlayerState,
  intended: Vec3,
  players: readonly PlayerState[] = orderedPlayers(state),
): Vec3 => {
  if (!isTeamGameMode(state.config.mode) || player.team === 'neutral') return intended;
  let separationX = 0;
  let separationZ = 0;
  for (const ally of players) {
    if (ally.id === player.id || !ally.alive || ally.team !== player.team) continue;
    const range = horizontalDistance(player.position, ally.position);
    if (range >= 1.8) continue;
    const away = range <= 0.01
      ? {
          x: Math.cos((hashString(`${player.id}:${ally.id}`) % 628) / 100),
          y: 0,
          z: Math.sin((hashString(`${player.id}:${ally.id}`) % 628) / 100),
        }
      : normalize(subtract(player.position, ally.position));
    const weight = 1 - range / 1.8;
    separationX += away.x * weight;
    separationZ += away.z * weight;
  }
  return normalize({
    x: intended.x + separationX * 1.15,
    y: 0,
    z: intended.z + separationZ * 1.15,
  });
};

export const isBotGrenadeSafe = (
  state: MatchState,
  player: PlayerState,
  target: PlayerState,
  players: readonly PlayerState[] = orderedPlayers(state),
): boolean => {
  const targetRange = horizontalDistance(player.position, target.position);
  if (targetRange < 8.5 || targetRange > 25 || player.carryingFlagTeam) return false;
  if (!isTeamGameMode(state.config.mode) || player.team === 'neutral') return true;
  return players.every((ally) =>
    ally.id === player.id ||
    !ally.alive ||
    ally.team !== player.team ||
    horizontalDistance(ally.position, target.position) > 6.2,
  );
};

const canBotUseTowerTurret = (state: MatchState, player: PlayerState): boolean =>
  state.config.mode === 'towah-of-powah' &&
  horizontalDistance(player.position, state.tower.center) <= 6.4 &&
  Math.abs(player.position.y - state.tower.center.y) <= 2.2;

const updatePerception = (
  state: MatchState,
  player: PlayerState,
  profile: DifficultyProfile,
  hasLineOfSight: LineOfSightTest,
  decisionDue: boolean,
  players: readonly PlayerState[],
): PlayerState | null => {
  const memory = player.bot!;
  const previous = memory.targetId ? state.players[memory.targetId] : undefined;
  const previousVisible = previous?.alive && isEnemy(state, player, previous)
    ? canSeePlayer(player, previous, profile, hasLineOfSight)
    : false;

  let target = previousVisible ? previous ?? null : null;
  if (decisionDue) target = acquireVisibleTarget(state, player, profile, hasLineOfSight, players) ?? target;

  if (target) {
    const hadRecentSight = state.elapsed - memory.lastSeenAt <= Math.max(0.05, profile.decisionInterval * 1.5);
    if (target.id !== memory.targetId || !hadRecentSight) {
      memory.reactionTimer = randomRange(state, profile.reaction * 0.85, profile.reaction * 1.15);
    }
    memory.targetId = target.id;
    memory.lastSeenPosition = { ...target.position };
    memory.lastSeenAt = state.elapsed;
    return target;
  }

  if (memory.targetId && state.elapsed - memory.lastSeenAt > profile.memorySeconds) {
    memory.targetId = null;
    memory.lastSeenPosition = null;
  }
  return null;
};

export const createBotMemory = (difficulty: Difficulty): BotMemory => ({
  difficulty,
  decisionTimer: 0,
  targetId: null,
  lastSeenPosition: null,
  // Keep the initial value JSON-safe because BotMemory travels in snapshots.
  lastSeenAt: -1_000_000,
  // Do not grant instant knowledge on spawn. Better bots take their first
  // glance sooner, but even Legend has a perceptible delay.
  radarGlanceTimer: BOT_DIFFICULTY_PROFILES[difficulty].radarGlanceInterval?.[0] ?? 0,
  radarContactId: null,
  radarContactPosition: null,
  radarContactAt: -1_000_000,
  waypointIndex: 0,
  navigationRoute: [],
  navigationCursor: 0,
  navigationGoalIndex: null,
  reactionTimer: 0,
  aimError: vec3(0, 0, 1),
  preferredRange: WEAPON_RANGE['pulse-rifle'].ideal,
  objective: 'attack',
  lastPosition: null,
  stuckTimer: 0,
  unstickTimer: 0,
  pickupTargetId: null,
  pickupBestDistance: 1_000_000,
  pickupProgressAt: 0,
  pickupBlacklist: [],
});

export const updateBotInputs = (
  state: MatchState,
  map: MapDefinition,
  dt: number,
  hasLineOfSight: LineOfSightTest,
): void => {
  const safeDt = Math.max(0, dt);
  const players = orderedPlayers(state);
  for (const player of players) {
    if (player.kind !== 'bot') continue;
    player.bot ??= createBotMemory(state.config.difficulty);
    const memory = player.bot;
    const profile = BOT_DIFFICULTY_PROFILES[memory.difficulty];
    const input = emptyInput();
    input.sequence = player.input.sequence + 1;

    memory.decisionTimer = Math.max(0, memory.decisionTimer - safeDt);
    memory.reactionTimer = Math.max(0, memory.reactionTimer - safeDt);
    memory.unstickTimer = Math.max(0, memory.unstickTimer - safeDt);
    // Nullish fallback keeps older peer snapshots compatible with this build.
    memory.radarGlanceTimer = Math.max(0, (memory.radarGlanceTimer ?? 0) - safeDt);
    memory.radarContactId ??= null;
    memory.radarContactPosition ??= null;
    memory.radarContactAt ??= -1_000_000;
    expireMotionRadarContact(state, memory, profile);

    if (!player.alive || state.phase !== 'playing') {
      input.yaw = player.yaw;
      input.pitch = player.pitch;
      player.input = input;
      continue;
    }

    const decisionDue = memory.decisionTimer <= 0;
    if (decisionDue) {
      if (memory.lastPosition) {
        const wasTryingToMove = Math.hypot(player.input.moveX, player.input.moveZ) > 0.35;
        const moved = distance(player.position, memory.lastPosition);
        memory.stuckTimer = wasTryingToMove && moved < 0.12
          ? memory.stuckTimer + profile.decisionInterval
          : Math.max(0, memory.stuckTimer - profile.decisionInterval * 1.5);
      }
      memory.lastPosition = { ...player.position };
      if (memory.stuckTimer >= 0.6) {
        if (memory.objective === 'pickup' && memory.pickupTargetId) {
          blacklistPickup(memory, memory.pickupTargetId, state.elapsed);
          memory.pickupBestDistance = 1_000_000;
          memory.pickupProgressAt = state.elapsed;
        }
        memory.stuckTimer = 0;
        memory.unstickTimer = 1.1;
        memory.aimError.z *= -1;
        memory.waypointIndex = (memory.waypointIndex + 3) % Math.max(1, map.waypoints.length);
        memory.navigationRoute = [];
        memory.navigationCursor = 0;
        memory.navigationGoalIndex = null;
      }
      memory.decisionTimer = randomRange(state, profile.decisionInterval * 0.85, profile.decisionInterval * 1.15);
      memory.aimError.x = randomRange(state, -profile.aimError, profile.aimError);
      memory.aimError.y = randomRange(state, -profile.aimError * 0.7, profile.aimError * 0.7);
      if (random01(state) < 0.22) memory.aimError.z *= -1;
    }

    const operatingTurret = state.config.mode === 'towah-of-powah' && state.tower.turretOwnerId === player.id;
    const perceptionProfile = operatingTurret
      ? turretProfileFor(profile)
      : profile;
    const visibleTarget = updatePerception(state, player, perceptionProfile, hasLineOfSight, decisionDue, players);
    if (decisionDue && memory.radarGlanceTimer <= 0) {
      takeMotionRadarGlance(state, player, profile, players);
    }
    let plan = objectivePlan(state, player, map);
    if (pickupPlanHasStalled(state, player, plan)) plan = objectivePlan(state, player, map);
    const rememberedGoal = memory.lastSeenPosition && state.elapsed - memory.lastSeenAt <= profile.memorySeconds
      ? memory.lastSeenPosition
      : null;
    const radarGoal = memory.radarContactPosition &&
      state.elapsed - memory.radarContactAt <= profile.radarMemorySeconds
      ? memory.radarContactPosition
      : null;
    // Flag runs, juggernaut hunts and tower assaults remain authoritative.
    // Outside an urgent objective, recent sight wins, followed by a briefly
    // remembered radar bearing and then the ordinary plan.
    const awarenessGoal = rememberedGoal ?? radarGoal;
    const strategicGoal = plan.urgent && plan.goal
      ? plan.goal
      : awarenessGoal ?? plan.goal;
    const fallbackWaypoint = map.waypoints[memory.waypointIndex % Math.max(1, map.waypoints.length)] ?? player.position;
    const goal = strategicGoal ?? fallbackWaypoint;
    const navigation = selectWaypoint(player, memory, goal, map, hasLineOfSight);
    const navigationTarget = navigation.target;
    let navigationDirection = normalize(subtract(navigationTarget, player.position));

    if (!strategicGoal && horizontalDistance(player.position, fallbackWaypoint) < 2.2 && map.waypoints.length > 0) {
      const stride = 1 + Math.floor(random01(state) * Math.min(4, map.waypoints.length));
      memory.waypointIndex = (memory.waypointIndex + stride) % map.waypoints.length;
      const next = map.waypoints[memory.waypointIndex] ?? player.position;
      navigationDirection = normalize(subtract(next, player.position));
    }

    const targetRange = visibleTarget ? horizontalDistance(player.position, visibleTarget.position) : memory.preferredRange;
    const desiredWeaponIndex = selectWeaponIndex(player, targetRange);
    const activeWeapon = player.inventory[player.activeWeapon];
    const desiredWeapon = player.inventory[desiredWeaponIndex];
    if (desiredWeapon) memory.preferredRange = WEAPON_RANGE[desiredWeapon.id].ideal;

    if (visibleTarget && !player.carryingFlagTeam) {
      navigationDirection = combatMovement(state, player, visibleTarget, navigationDirection, plan.urgent);
    }
    if (memory.unstickTimer > 0) {
      const sign = memory.aimError.z < 0 ? -1 : 1;
      navigationDirection = normalize({
        x: navigationDirection.x * 0.15 - navigationDirection.z * sign,
        y: 0,
        z: navigationDirection.z * 0.15 + navigationDirection.x * sign,
      });
    }
    navigationDirection = avoidNearbyExplosives(state, player, navigationDirection);
    navigationDirection = avoidFriendlyCrowding(state, player, navigationDirection, players);

    const precisionFinisher = visibleTarget !== null &&
      visibleTarget.shield <= 0 &&
      (desiredWeapon?.id === 'sidearm' || desiredWeapon?.id === 'battle-rifle');
    const aimPoint = visibleTarget
      ? {
          x: visibleTarget.position.x,
          y: visibleTarget.position.y + visibleTarget.height *
            (desiredWeapon?.id === 'sniper' || precisionFinisher ? 0.86 : 0.58),
          z: visibleTarget.position.z,
        }
      : awarenessGoal ?? navigationTarget;
    const aimOrigin = operatingTurret
      ? {
          x: state.tower.center.x,
          y: state.tower.center.y + TOWER_TURRET_LAYOUT.firingOriginOffset,
          z: state.tower.center.z,
        }
      : eyePosition(player);
    const exactYaw = yawTo(aimOrigin, aimPoint);
    const exactPitch = pitchTo(aimOrigin, aimPoint);
    const desiredYaw = exactYaw + (visibleTarget ? memory.aimError.x : 0);
    const desiredPitch = exactPitch + (visibleTarget ? memory.aimError.y : 0);
    input.yaw = wrapAngle(moveAngleToward(player.yaw, desiredYaw, profile.turnRate * safeDt));
    input.pitch = clamp(
      moveAngleToward(player.pitch, desiredPitch, profile.turnRate * 0.72 * safeDt),
      -PLAYER_PITCH_LIMIT,
      PLAYER_PITCH_LIMIT,
    );

    const localMovement = movementToLocalInput(navigationDirection, input.yaw);
    const combatMovementScale = visibleTarget && !plan.urgent ? profile.combatMovementScale : 1;
    input.moveX = localMovement.moveX * combatMovementScale;
    input.moveZ = localMovement.moveZ * combatMovementScale;
    input.crouch = state.config.mode === 'towah-of-powah' &&
      player.grounded &&
      isOnTowerDeck(state, player, map) &&
      state.tower.controllingTeam === player.team &&
      visibleTarget === null &&
      player.health <= 45;

    if (desiredWeaponIndex !== player.activeWeapon && desiredWeapon && weaponUsable(desiredWeapon)) {
      input.swap = true;
    } else if (activeWeapon) {
      const definition = WEAPONS[activeWeapon.id];
      const exactYawError = Math.abs(wrapAngle(exactYaw - input.yaw));
      const exactPitchError = Math.abs(wrapAngle(exactPitch - input.pitch));
      const angularTargetSize = visibleTarget ? Math.atan2(visibleTarget.radius, Math.max(1, targetRange)) : 0;
      const aligned = exactYawError <= profile.fireTolerance + angularTargetSize &&
        exactPitchError <= profile.fireTolerance * 0.8 + angularTargetSize;
      const withinWeaponRange = targetRange <= definition.range && targetRange <= WEAPON_RANGE[activeWeapon.id].maximum;
      const safeRocketRange = activeWeapon.id !== 'rocket-launcher' || targetRange >= WEAPON_RANGE['rocket-launcher'].minimum;

      input.aim = visibleTarget !== null &&
        ((activeWeapon.id === 'sniper' && targetRange > 16) ||
          (activeWeapon.id === 'battle-rifle' && targetRange > 24) ||
          (activeWeapon.id === 'sidearm' && targetRange > 30));
      input.melee = decisionDue &&
        visibleTarget !== null &&
        memory.reactionTimer <= 0 &&
        targetRange <= 1.75 &&
        player.meleeCooldown <= 0;
      input.fire = visibleTarget !== null &&
        !input.melee &&
        decisionDue &&
        memory.reactionTimer <= 0 &&
        activeWeapon.magazine > 0 &&
        activeWeapon.reloadTimer <= 0 &&
        activeWeapon.cooldown <= 0 &&
        aligned &&
        withinWeaponRange &&
        safeRocketRange;
      input.reload = activeWeapon.reloadTimer <= 0 &&
        activeWeapon.reserve > 0 &&
        (activeWeapon.magazine === 0 || (!visibleTarget && activeWeapon.magazine < definition.magazineSize * 0.45));

      if (
        decisionDue &&
        visibleTarget &&
        memory.reactionTimer <= 0 &&
        player.grenades > 0 &&
        player.grenadeCooldown <= 0 &&
        isBotGrenadeSafe(state, player, visibleTarget, players) &&
        random01(state) < profile.grenadeChance
      ) {
        input.grenade = true;
        input.fire = false;
      }
    }

    if (operatingTurret) {
      const angularTargetSize = visibleTarget ? Math.atan2(visibleTarget.radius, Math.max(1, targetRange)) : 0;
      const aligned = visibleTarget !== null &&
        Math.abs(wrapAngle(exactYaw - input.yaw)) <= profile.fireTolerance + angularTargetSize &&
        Math.abs(wrapAngle(exactPitch - input.pitch)) <= profile.fireTolerance * 0.8 + angularTargetSize;
      input.moveX = 0;
      input.moveZ = 0;
      input.swap = false;
      input.reload = false;
      input.aim = false;
      input.melee = false;
      input.grenade = false;
      input.crouch = false;
      input.fire = aligned && memory.reactionTimer <= 0;
    } else if (
      decisionDue &&
      state.config.mode === 'towah-of-powah' &&
      state.tower.turretOwnerId === null &&
      canBotUseTowerTurret(state, player)
    ) {
      input.use = true;
    } else if (decisionDue && plan.pickupId) {
      const pickup = state.pickups.find((candidate) => candidate.id === plan.pickupId);
      if (
        pickup?.available &&
        pickup.kind === 'weapon' &&
        pickup.weaponId &&
        distance(player.position, pickup.position) <= 1.45 &&
        botPickupUtility(player, pickup) > 0
      ) {
        const existing = player.inventory.find((weapon) => weapon.id === pickup.weaponId);
        const replacementIndex = existing || player.inventory.length < 2
          ? player.activeWeapon
          : weaponReplacementIndex(player, pickup.weaponId);
        if (replacementIndex >= 0 && player.inventory.length >= 2 && !existing && player.activeWeapon !== replacementIndex) {
          input.swap = true;
          input.use = false;
        } else {
          input.use = true;
        }
      }
    }

    if (decisionDue && player.grounded) {
      const needsVerticalMovement = navigationTarget.y > player.position.y + 0.65 &&
        horizontalDistance(player.position, navigationTarget) < 8;
      input.jump = navigation.traversal === 'drop'
        ? false
        : memory.unstickTimer > 0
          || navigation.traversal === 'jump'
          || navigation.traversal === 'launch'
          || needsVerticalMovement
          || random01(state) < profile.jumpChance;
    }

    player.input = input;
  }
};
