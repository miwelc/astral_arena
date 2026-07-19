import {
  clamp,
  distance,
  emptyInput,
  hashString,
  horizontalDistance,
  normalize,
  pitchTo,
  random01,
  randomRange,
  subtract,
  vec3,
  wrapAngle,
  yawTo,
} from './math';
import type {
  BotMemory,
  Difficulty,
  MapDefinition,
  MatchState,
  PickupState,
  PlayerInput,
  PlayerState,
  Team,
  Vec3,
  WeaponId,
  WeaponState,
} from './types';
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
}

interface ObjectivePlan {
  goal: Vec3 | null;
  urgent: boolean;
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
  },
};

const WEAPON_RANGE: Record<WeaponId, { ideal: number; minimum: number; maximum: number }> = {
  'pulse-rifle': { ideal: 18, minimum: 3, maximum: 46 },
  sidearm: { ideal: 25, minimum: 5, maximum: 62 },
  'battle-rifle': { ideal: 31, minimum: 8, maximum: 76 },
  sniper: { ideal: 48, minimum: 15, maximum: 150 },
  shotgun: { ideal: 5.5, minimum: 0, maximum: 15 },
  'rocket-launcher': { ideal: 22, minimum: 7, maximum: 78 },
};

const POWER_WEAPONS = new Set<WeaponId>(['sniper', 'shotgun', 'rocket-launcher', 'battle-rifle']);
const TEAM_MODES = new Set(['team-deathmatch', 'capture-the-flag', 'juggernaut', 'towah-of-powah']);

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
  if (!TEAM_MODES.has(state.config.mode)) return true;
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
): PlayerState | null => {
  let best: PlayerState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of orderedPlayers(state)) {
    if (!isEnemy(state, observer, candidate) || !canSeePlayer(observer, candidate, profile, hasLineOfSight)) continue;
    const score = targetPriority(state, observer, candidate, observer.bot?.targetId ?? null);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
};

const ownTeam = (team: Team): Exclude<Team, 'neutral'> | null => (team === 'neutral' ? null : team);

const opposingTeam = (team: Exclude<Team, 'neutral'>): Exclude<Team, 'neutral'> =>
  team === 'aurora' ? 'nova' : 'aurora';

const nearestAvailablePickup = (state: MatchState, player: PlayerState): PickupState | null => {
  const inventoryIds = new Set(player.inventory.map((weapon) => weapon.id));
  let selected: PickupState | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const pickup of state.pickups) {
    if (!pickup.available) continue;
    const pickupDistance = horizontalDistance(player.position, pickup.position);
    let value = 0;
    if (pickup.kind === 'weapon' && pickup.weaponId) {
      value = POWER_WEAPONS.has(pickup.weaponId) && !inventoryIds.has(pickup.weaponId) ? 22 : 8;
    } else if (pickup.kind === 'overshield') {
      value = player.shield < player.maxShield * 0.7 ? 24 : 10;
    } else if (pickup.kind === 'ammo') {
      const active = player.inventory[player.activeWeapon];
      value = active && active.reserve < WEAPONS[active.id].magazineSize ? 14 : 4;
    } else if (pickup.kind === 'grenade') {
      value = player.grenades === 0 ? 12 : 3;
    }
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
    return { goal: pickup?.position ?? null, urgent: false };
  }

  if (juggernaut.team === player.team && player.team !== 'neutral') {
    player.bot!.objective = 'defend';
    return { goal: juggernaut.position, urgent: true };
  }

  player.bot!.objective = 'attack';
  return { goal: juggernaut.position, urgent: true };
};

const objectivePlan = (state: MatchState, player: PlayerState, map: MapDefinition): ObjectivePlan => {
  if (state.config.mode === 'capture-the-flag') return ctfPlan(state, player, map);
  if (state.config.mode === 'juggernaut') return juggernautPlan(state, player);
  if (state.config.mode === 'towah-of-powah') {
    player.bot!.objective = 'tower';
    const angle = (hashString(player.id) % 628) / 100;
    return {
      goal: {
        x: state.tower.center.x + Math.cos(angle) * 4.4,
        y: state.tower.center.y,
        z: state.tower.center.z + Math.sin(angle) * 4.4,
      },
      urgent: state.tower.controllingTeam !== player.team,
    };
  }

  const pickup = nearestAvailablePickup(state, player);
  if (pickup && horizontalDistance(player.position, pickup.position) <= 30) {
    player.bot!.objective = 'pickup';
    return { goal: pickup.position, urgent: false };
  }
  player.bot!.objective = 'attack';
  return { goal: null, urgent: false };
};

const selectWaypoint = (
  player: PlayerState,
  memory: BotMemory,
  goal: Vec3,
  map: MapDefinition,
  hasLineOfSight: LineOfSightTest,
): Vec3 => {
  if (horizontalDistance(player.position, goal) <= 2.2) return goal;
  const from = eyePosition(player);
  const directVerticalDifference = Math.abs(goal.y - player.position.y);
  if (directVerticalDifference < 1.8 && hasLineOfSight(from, raisedPoint(goal))) return goal;

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

  if (bestIndex < 0) return goal;
  memory.waypointIndex = bestIndex;
  return map.waypoints[bestIndex] ?? goal;
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
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < player.inventory.length; index += 1) {
    const weapon = player.inventory[index];
    if (!weapon) continue;
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

const moveAngleToward = (current: number, desired: number, maximumDelta: number): number =>
  current + clamp(wrapAngle(desired - current), -maximumDelta, maximumDelta);

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
    if (!projectile.alive || projectile.ownerId === player.id) continue;
    const range = horizontalDistance(player.position, projectile.position);
    if (range > projectile.blastRadius + 3 || range < 0.01) continue;
    const away = normalize(subtract(player.position, projectile.position));
    const weight = 1 - range / (projectile.blastRadius + 3);
    dangerX += away.x * weight;
    dangerZ += away.z * weight;
  }
  return normalize({ x: intended.x + dangerX * 1.8, y: 0, z: intended.z + dangerZ * 1.8 });
};

const updatePerception = (
  state: MatchState,
  player: PlayerState,
  profile: DifficultyProfile,
  hasLineOfSight: LineOfSightTest,
  decisionDue: boolean,
): PlayerState | null => {
  const memory = player.bot!;
  const previous = memory.targetId ? state.players[memory.targetId] : undefined;
  const previousVisible = previous?.alive && isEnemy(state, player, previous)
    ? canSeePlayer(player, previous, profile, hasLineOfSight)
    : false;

  let target = previousVisible ? previous ?? null : null;
  if (decisionDue) target = acquireVisibleTarget(state, player, profile, hasLineOfSight) ?? target;

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
  waypointIndex: 0,
  reactionTimer: 0,
  aimError: vec3(0, 0, 1),
  preferredRange: WEAPON_RANGE['pulse-rifle'].ideal,
  objective: 'attack',
  lastPosition: null,
  stuckTimer: 0,
  unstickTimer: 0,
});

export const updateBotInputs = (
  state: MatchState,
  map: MapDefinition,
  dt: number,
  hasLineOfSight: LineOfSightTest,
): void => {
  const safeDt = Math.max(0, dt);
  for (const player of orderedPlayers(state)) {
    if (player.kind !== 'bot') continue;
    player.bot ??= createBotMemory(state.config.difficulty);
    const memory = player.bot;
    const profile = BOT_DIFFICULTY_PROFILES[memory.difficulty];
    const input = emptyInput();
    input.sequence = player.input.sequence + 1;

    memory.decisionTimer = Math.max(0, memory.decisionTimer - safeDt);
    memory.reactionTimer = Math.max(0, memory.reactionTimer - safeDt);
    memory.unstickTimer = Math.max(0, memory.unstickTimer - safeDt);

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
        const moved = horizontalDistance(player.position, memory.lastPosition);
        memory.stuckTimer = wasTryingToMove && moved < 0.12
          ? memory.stuckTimer + profile.decisionInterval
          : Math.max(0, memory.stuckTimer - profile.decisionInterval * 1.5);
      }
      memory.lastPosition = { ...player.position };
      if (memory.stuckTimer >= 0.6) {
        memory.stuckTimer = 0;
        memory.unstickTimer = 1.1;
        memory.aimError.z *= -1;
        memory.waypointIndex = (memory.waypointIndex + 3) % Math.max(1, map.waypoints.length);
      }
      memory.decisionTimer = randomRange(state, profile.decisionInterval * 0.85, profile.decisionInterval * 1.15);
      memory.aimError.x = randomRange(state, -profile.aimError, profile.aimError);
      memory.aimError.y = randomRange(state, -profile.aimError * 0.7, profile.aimError * 0.7);
      if (random01(state) < 0.22) memory.aimError.z *= -1;
    }

    const visibleTarget = updatePerception(state, player, profile, hasLineOfSight, decisionDue);
    const plan = objectivePlan(state, player, map);
    const rememberedGoal = memory.lastSeenPosition && state.elapsed - memory.lastSeenAt <= profile.memorySeconds
      ? memory.lastSeenPosition
      : null;
    const strategicGoal = plan.goal ?? rememberedGoal;
    const fallbackWaypoint = map.waypoints[memory.waypointIndex % Math.max(1, map.waypoints.length)] ?? player.position;
    const goal = strategicGoal ?? fallbackWaypoint;
    const navigationTarget = selectWaypoint(player, memory, goal, map, hasLineOfSight);
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
    } else if (
      state.config.mode === 'towah-of-powah' &&
      horizontalDistance(player.position, state.tower.center) <= Math.max(1, state.tower.radius * 0.7) &&
      player.position.y >= 5.15
    ) {
      navigationDirection = vec3();
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
      : rememberedGoal ?? navigationTarget;
    const exactYaw = yawTo(eyePosition(player), aimPoint);
    const exactPitch = pitchTo(eyePosition(player), aimPoint);
    const desiredYaw = exactYaw + (visibleTarget ? memory.aimError.x : 0);
    const desiredPitch = exactPitch + (visibleTarget ? memory.aimError.y : 0);
    input.yaw = moveAngleToward(player.yaw, desiredYaw, profile.turnRate * safeDt);
    input.pitch = clamp(
      moveAngleToward(player.pitch, desiredPitch, profile.turnRate * 0.72 * safeDt),
      -Math.PI * 0.48,
      Math.PI * 0.48,
    );

    const localMovement = movementToLocalInput(navigationDirection, input.yaw);
    const combatMovementScale = visibleTarget && !plan.urgent ? profile.combatMovementScale : 1;
    input.moveX = localMovement.moveX * combatMovementScale;
    input.moveZ = localMovement.moveZ * combatMovementScale;

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
        targetRange >= 8 &&
        targetRange <= 25 &&
        random01(state) < profile.grenadeChance
      ) {
        input.grenade = true;
        input.fire = false;
      }
    }

    if (decisionDue && player.grounded) {
      const needsVerticalMovement = navigationTarget.y > player.position.y + 0.65 &&
        horizontalDistance(player.position, navigationTarget) < 8;
      input.jump = memory.unstickTimer > 0 || needsVerticalMovement || random01(state) < profile.jumpChance;
    }

    player.input = input;
  }
};
