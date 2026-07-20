import { canonicalFormatForMode, rulesForMode } from '../game/modeRules';
import { CROUCHED_PLAYER_HEIGHT, STANDING_PLAYER_HEIGHT } from '../game/playerMovement';
import { PLAYER_PITCH_LIMIT, type GameMode, type MatchState } from '../game/types';
import { isValidPlayerInput } from './playerInputProtocol';

type UnknownRecord = Record<string, unknown>;

const GAME_MODES = new Set(['deathmatch', 'team-deathmatch', 'capture-the-flag', 'juggernaut', 'towah-of-powah']);
const MATCH_FORMATS = new Set(['duel', 'squads']);
const DIFFICULTIES = new Set(['recruit', 'veteran', 'legend']);
const TEAMS = new Set(['aurora', 'nova', 'neutral']);
const FLAG_TEAMS = new Set(['aurora', 'nova']);
const PLAYER_KINDS = new Set(['human', 'bot', 'remote']);
const WEAPON_IDS = new Set(['pulse-rifle', 'sidearm', 'battle-rifle', 'sniper', 'shotgun', 'rocket-launcher']);
const PICKUP_KINDS = new Set(['weapon', 'overshield', 'ammo', 'grenade']);
const EVENT_TYPES = new Set([
  'shot',
  'hit',
  'shield-break',
  'shield-recharge-start',
  'shield-recharge-complete',
  'kill',
  'respawn',
  'pickup',
  'reload',
  'flag',
  'score',
  'explosion',
  'melee',
  'match-end',
]);
const FLAG_ACTIONS = new Set(['taken', 'dropped', 'returned', 'captured']);
const FLAG_STATUSES = new Set(['home', 'carried', 'dropped']);
const BOT_OBJECTIVES = new Set(['attack', 'defend', 'pickup', 'flag', 'tower']);
const MATCH_PHASES = new Set(['countdown', 'playing', 'finished']);

const MAX_PLAYERS = 8;
const MAX_PROJECTILES = 512;
const MAX_PICKUPS = 128;
const MAX_EVENTS = 512;
const MAX_ID_LENGTH = 128;
const MAX_WORLD_COORDINATE = 1_000_000;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEnumValue = (values: ReadonlySet<string>, value: unknown): value is string =>
  typeof value === 'string' && values.has(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNonNegativeNumber = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0;

const isSafeNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_ID_LENGTH
  && value.trim() === value
  && !/[\u0000-\u001f\u007f]/.test(value);

const isOptionalIdentifier = (value: unknown): boolean =>
  value === undefined || isIdentifier(value);

const isNullableIdentifier = (value: unknown): boolean =>
  value === null || isIdentifier(value);

const isVec3 = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isFiniteNumber(value.x) && Math.abs(value.x) <= MAX_WORLD_COORDINATE
    && isFiniteNumber(value.y) && Math.abs(value.y) <= MAX_WORLD_COORDINATE
    && isFiniteNumber(value.z) && Math.abs(value.z) <= MAX_WORLD_COORDINATE;
};

const isPlayerMovementMemory = (value: unknown): boolean => {
  if (!isRecord(value) || !isNonNegativeNumber(value.jumpPadReadyAt)) return false;
  if (value.jumpPadMomentum === null) return true;
  return isRecord(value.jumpPadMomentum)
    && isVec3(value.jumpPadMomentum.direction)
    && isNonNegativeNumber(value.jumpPadMomentum.minimumSpeed);
};

const isWeaponState = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isEnumValue(WEAPON_IDS, value.id)
    && isSafeNonNegativeInteger(value.magazine)
    && isSafeNonNegativeInteger(value.reserve)
    && isNonNegativeNumber(value.cooldown)
    && isNonNegativeNumber(value.reloadTimer)
    && isFiniteNumber(value.bloom) && value.bloom >= 0 && value.bloom <= 1.001
    && isSafeNonNegativeInteger(value.burstRemaining) && value.burstRemaining <= 8
    && isSafeNonNegativeInteger(value.burstRoundIndex) && value.burstRoundIndex <= 8
    && isNonNegativeNumber(value.burstTimer);
};

const isPickupBlacklist = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length > 4) return false;
  if (value.length === 0) return true;
  const pickupIds = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || !isIdentifier(entry.pickupId) || !isNonNegativeNumber(entry.retryAt)) return false;
    if (pickupIds.has(entry.pickupId)) return false;
    pickupIds.add(entry.pickupId);
  }
  return true;
};

const isBotMemory = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  // Radar memory was added after the original P2P snapshot shape. Missing
  // fields remain valid for an older peer, but present fields must never let
  // NaN, oversized coordinates or malformed player ids enter bot steering.
  const validOptionalRadarMemory =
    (value.radarGlanceTimer === undefined || isNonNegativeNumber(value.radarGlanceTimer))
    && (value.radarContactId === undefined || isNullableIdentifier(value.radarContactId))
    && (
      value.radarContactPosition === undefined
      || value.radarContactPosition === null
      || isVec3(value.radarContactPosition)
    )
    && (value.radarContactAt === undefined || isFiniteNumber(value.radarContactAt));
  const validOptionalNavigationMemory = (() => {
    if (
      value.navigationRoute === undefined
      && value.navigationCursor === undefined
      && value.navigationGoalIndex === undefined
    ) return true;
    if (!Array.isArray(value.navigationRoute) || value.navigationRoute.length > 128) return false;
    for (const entry of value.navigationRoute) {
      if (!isSafeNonNegativeInteger(entry) || entry >= 512) return false;
    }
    if (!isSafeNonNegativeInteger(value.navigationCursor)) return false;
    if (
      (value.navigationRoute.length === 0 && value.navigationCursor !== 0)
      || (value.navigationRoute.length > 0 && value.navigationCursor >= value.navigationRoute.length)
    ) return false;
    return value.navigationGoalIndex === null
      || (isSafeNonNegativeInteger(value.navigationGoalIndex) && value.navigationGoalIndex < 512);
  })();
  return isEnumValue(DIFFICULTIES, value.difficulty)
    && isNonNegativeNumber(value.decisionTimer)
    && isNullableIdentifier(value.targetId)
    && (value.lastSeenPosition === null || isVec3(value.lastSeenPosition))
    && isFiniteNumber(value.lastSeenAt)
    && validOptionalRadarMemory
    && validOptionalNavigationMemory
    && isSafeNonNegativeInteger(value.waypointIndex)
    && isNonNegativeNumber(value.reactionTimer)
    && isVec3(value.aimError)
    && isNonNegativeNumber(value.preferredRange)
    && isEnumValue(BOT_OBJECTIVES, value.objective)
    && (value.lastPosition === null || isVec3(value.lastPosition))
    && isNonNegativeNumber(value.stuckTimer)
    && isNonNegativeNumber(value.unstickTimer)
    && isNullableIdentifier(value.pickupTargetId)
    && isNonNegativeNumber(value.pickupBestDistance)
    && isNonNegativeNumber(value.pickupProgressAt)
    && isPickupBlacklist(value.pickupBlacklist);
};

const isPlayerState = (value: unknown, recordId: string): boolean => {
  if (!isRecord(value) || value.id !== recordId || !isIdentifier(value.id)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 18) return false;
  if (!isEnumValue(PLAYER_KINDS, value.kind) || !isEnumValue(TEAMS, value.team)) return false;
  if (!isVec3(value.position) || !isVec3(value.velocity)) return false;

  if (
    !isFiniteNumber(value.yaw)
    || !isFiniteNumber(value.pitch)
    || !isFiniteNumber(value.radius)
    || !isFiniteNumber(value.height)
    || !isFiniteNumber(value.lastDamageAt)
    || !isNonNegativeNumber(value.health)
    || !isNonNegativeNumber(value.shield)
    || !isNonNegativeNumber(value.maxShield)
    || !isNonNegativeNumber(value.overshieldDecayDelay)
    || !isNonNegativeNumber(value.respawnTimer)
    || !isNonNegativeNumber(value.spawnProtection)
    || !isNonNegativeNumber(value.meleeCooldown)
    || !isNonNegativeNumber(value.grenadeCooldown)
    || !isNonNegativeNumber(value.equipTimer)
  ) return false;
  if (
    Math.abs(value.yaw as number) > Math.PI + 0.001
    || Math.abs(value.pitch as number) > PLAYER_PITCH_LIMIT + 0.001
  ) return false;
  if ((value.radius as number) <= 0 || (value.height as number) <= 0) return false;
  if (typeof value.grounded !== 'boolean'
    || typeof value.crouched !== 'boolean'
    || typeof value.alive !== 'boolean'
    || typeof value.isJuggernaut !== 'boolean'
    || typeof value.aimSuppressed !== 'boolean') return false;
  const expectedHeight = value.crouched ? CROUCHED_PLAYER_HEIGHT : STANDING_PLAYER_HEIGHT;
  if (Math.abs((value.height as number) - expectedHeight) > 0.001) return false;

  if (!Array.isArray(value.inventory) || value.inventory.length === 0 || value.inventory.length > 2) return false;
  let firstWeaponId: string | undefined;
  for (const weapon of value.inventory) {
    if (!isWeaponState(weapon) || !isRecord(weapon)) return false;
    const weaponId = weapon.id as string;
    if (weaponId === firstWeaponId) return false;
    firstWeaponId ??= weaponId;
  }
  if (!isSafeNonNegativeInteger(value.activeWeapon) || value.activeWeapon >= value.inventory.length) return false;

  if (
    !isSafeNonNegativeInteger(value.grenades)
    || !isSafeNonNegativeInteger(value.lastProcessedInput)
    || !isSafeNonNegativeInteger(value.kills)
    || !isSafeNonNegativeInteger(value.deaths)
    || !isSafeNonNegativeInteger(value.assists)
    || !isSafeNonNegativeInteger(value.score)
    || !isSafeNonNegativeInteger(value.streak)
    || !isValidPlayerInput(value.input)
    || !isPlayerMovementMemory(value.movementMemory)
  ) return false;
  if (!(value.carryingFlagTeam === null || isEnumValue(TEAMS, value.carryingFlagTeam))) return false;
  // BotMemory is host-authority state and is intentionally omitted from the
  // guest snapshot DTO. If present it must still be fully valid.
  return value.bot === undefined || isBotMemory(value.bot);
};

const isMatchConfig = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isEnumValue(GAME_MODES, value.mode) || !isEnumValue(MATCH_FORMATS, value.format)) return false;
  if (value.format !== canonicalFormatForMode(value.mode as GameMode)) return false;
  if (!isSafeNonNegativeInteger(value.playerCount) || value.playerCount < 2 || value.playerCount > MAX_PLAYERS) return false;
  if (value.mode !== 'deathmatch' && value.playerCount !== rulesForMode(value.mode as GameMode).maxPlayers) return false;
  return isEnumValue(DIFFICULTIES, value.difficulty)
    && isSafeNonNegativeInteger(value.scoreLimit) && value.scoreLimit > 0 && value.scoreLimit <= 10_000
    && isSafeNonNegativeInteger(value.timeLimitSeconds) && value.timeLimitSeconds > 0 && value.timeLimitSeconds <= 86_400
    && typeof value.botFill === 'boolean'
    && typeof value.playerName === 'string' && value.playerName.length > 0 && value.playerName.length <= 64
    && (value.mapId === 'crater-ridge' || value.mapId === 'umbra-station');
};

const isProjectile = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isIdentifier(value.id)
    && (value.kind === 'rocket' || value.kind === 'grenade' || value.kind === 'bullet')
    && isIdentifier(value.ownerId)
    && isEnumValue(TEAMS, value.team)
    && (value.kind === 'bullet'
      ? isEnumValue(WEAPON_IDS, value.weaponId)
      : value.weaponId === undefined)
    && isVec3(value.position)
    && isVec3(value.velocity)
    && isFiniteNumber(value.radius) && value.radius > 0
    && isFiniteNumber(value.damage) && value.damage >= 0
    && isFiniteNumber(value.blastRadius) && value.blastRadius >= 0
    && typeof value.armed === 'boolean'
    && isFiniteNumber(value.fuse)
    && typeof value.alive === 'boolean';
};

const isPickup = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isIdentifier(value.id) || !isEnumValue(PICKUP_KINDS, value.kind) || !isVec3(value.position)) return false;
  if (value.kind === 'weapon') {
    if (!isEnumValue(WEAPON_IDS, value.weaponId)) return false;
    if (!(value.weaponState === undefined || (
      isWeaponState(value.weaponState)
      && isRecord(value.weaponState)
      && value.weaponState.id === value.weaponId
    ))) return false;
  } else if (value.weaponId !== undefined) {
    return false;
  } else if (value.weaponState !== undefined) {
    return false;
  }
  if (!isSafeNonNegativeInteger(value.amount)) return false;
  if (value.kind === 'grenade' ? value.amount < 1 || value.amount > 2 : value.amount !== 1) return false;
  if (typeof value.temporary !== 'boolean' || !isNonNegativeNumber(value.despawnTimer)) return false;
  if (value.temporary) {
    if (!value.available || value.despawnTimer <= 0 || value.despawnTimer > 60 || value.respawnTimer !== 0) return false;
  } else if (value.despawnTimer !== 0 || value.weaponState !== undefined) {
    return false;
  }
  return typeof value.available === 'boolean'
    && isNonNegativeNumber(value.respawnTimer)
    && isFiniteNumber(value.respawnSeconds) && value.respawnSeconds > 0;
};

const isFlag = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isEnumValue(FLAG_TEAMS, value.team) || !isVec3(value.basePosition) || !isVec3(value.position)) return false;
  if (!isEnumValue(FLAG_STATUSES, value.status) || !isNullableIdentifier(value.carrierId)) return false;
  if (value.status === 'carried' ? value.carrierId === null : value.carrierId !== null) return false;
  return isNonNegativeNumber(value.returnTimer);
};

const isTower = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isVec3(value.center)
    && isFiniteNumber(value.radius) && value.radius > 0
    && isEnumValue(TEAMS, value.controllingTeam)
    && isNullableIdentifier(value.turretOwnerId)
    && isFiniteNumber(value.turretYaw) && Math.abs(value.turretYaw) <= Math.PI + 0.001
    && isFiniteNumber(value.turretPitch) && value.turretPitch >= -0.601 && value.turretPitch <= 0.851
    && isNonNegativeNumber(value.turretCooldown);
};

const isGameEvent = (value: unknown, elapsed: number, eventSequence: number): value is UnknownRecord => {
  if (!isRecord(value)) return false;
  if (!isSafeNonNegativeInteger(value.id) || value.id === 0 || value.id > eventSequence) return false;
  if (!isNonNegativeNumber(value.time) || value.time > elapsed + 0.001) return false;
  if (!isEnumValue(EVENT_TYPES, value.type)) return false;
  if (!isOptionalIdentifier(value.actorId) || !isOptionalIdentifier(value.targetId)) return false;
  if (!(value.actorTeam === undefined || isEnumValue(TEAMS, value.actorTeam))) return false;
  if (!(value.weaponId === undefined || isEnumValue(WEAPON_IDS, value.weaponId))) return false;
  if (!(value.position === undefined || isVec3(value.position))) return false;
  if (!(value.sourcePosition === undefined || isVec3(value.sourcePosition))) return false;
  if (!(value.impact === undefined || typeof value.impact === 'boolean')) return false;
  if (value.traces !== undefined) {
    if (!Array.isArray(value.traces) || value.traces.length === 0 || value.traces.length > 12) return false;
    for (const trace of value.traces) {
      if (!isVec3(trace)) return false;
    }
  }
  if (!(value.message === undefined || (typeof value.message === 'string' && value.message.length <= 512))) return false;
  if (!(value.amount === undefined || isNonNegativeNumber(value.amount))) return false;
  if (!(value.shieldDamage === undefined || isNonNegativeNumber(value.shieldDamage))) return false;
  if (!(value.healthDamage === undefined || isNonNegativeNumber(value.healthDamage))) return false;
  if (!(value.headshot === undefined || typeof value.headshot === 'boolean')) return false;
  if (!(value.fatal === undefined || typeof value.fatal === 'boolean')) return false;
  if (!(value.backStrike === undefined || typeof value.backStrike === 'boolean')) return false;
  if (!(value.explosionKind === undefined || value.explosionKind === 'rocket' || value.explosionKind === 'grenade')) return false;
  if (!(value.radius === undefined || isNonNegativeNumber(value.radius))) return false;
  if ((value.explosionKind !== undefined || value.radius !== undefined) && value.type !== 'explosion') return false;
  if (!(value.flagTeam === undefined || isEnumValue(FLAG_TEAMS, value.flagTeam))) return false;
  if (!(value.flagAction === undefined || isEnumValue(FLAG_ACTIONS, value.flagAction))) return false;
  if ((value.flagTeam !== undefined || value.flagAction !== undefined) && value.type !== 'flag') return false;
  return true;
};

const hasUniqueValidItems = (
  values: unknown[],
  maxLength: number,
  validator: (value: unknown) => boolean,
): boolean => {
  if (values.length > maxLength) return false;
  if (values.length === 0) return true;
  const ids = new Set<string>();
  for (const value of values) {
    if (!validator(value) || !isRecord(value) || !isIdentifier(value.id) || ids.has(value.id)) return false;
    ids.add(value.id);
  }
  return true;
};

const validateMatchState = (value: unknown): boolean => {
  if (!isRecord(value) || value.version !== 1 || !isIdentifier(value.matchId) || !isMatchConfig(value.config)) return false;
  if (!isSafeNonNegativeInteger(value.tick) || !isNonNegativeNumber(value.elapsed)) return false;
  if (!isNonNegativeNumber(value.timeRemaining) || !isEnumValue(MATCH_PHASES, value.phase) || !isNonNegativeNumber(value.countdown)) return false;
  if (!isSafeNonNegativeInteger(value.randomState) || value.randomState > 0xffff_ffff) return false;

  if (!isRecord(value.players)) return false;
  const config = value.config as UnknownRecord;
  let playerCount = 0;
  for (const playerId in value.players) {
    if (!Object.hasOwn(value.players, playerId)) continue;
    playerCount += 1;
    if (playerCount > MAX_PLAYERS || playerCount > (config.playerCount as number)) return false;
    if (!isIdentifier(playerId) || !isPlayerState(value.players[playerId], playerId)) return false;
  }

  if (!(value.winner === null || isEnumValue(TEAMS, value.winner) || isIdentifier(value.winner))) return false;
  if (!(value.juggernautId === null || (isIdentifier(value.juggernautId) && value.players[value.juggernautId] !== undefined))) return false;

  if (!Array.isArray(value.projectiles) || !hasUniqueValidItems(value.projectiles, MAX_PROJECTILES, isProjectile)) return false;
  if (!Array.isArray(value.pickups) || !hasUniqueValidItems(value.pickups, MAX_PICKUPS, isPickup)) return false;
  if (!Array.isArray(value.flags) || value.flags.length !== 2) return false;
  const firstFlag = value.flags[0];
  const secondFlag = value.flags[1];
  if (!isFlag(firstFlag) || !isFlag(secondFlag)) return false;
  const firstFlagTeam = (firstFlag as UnknownRecord).team;
  const secondFlagTeam = (secondFlag as UnknownRecord).team;
  if (
    firstFlagTeam === secondFlagTeam
    || (firstFlagTeam !== 'aurora' && secondFlagTeam !== 'aurora')
    || (firstFlagTeam !== 'nova' && secondFlagTeam !== 'nova')
  ) return false;
  for (const flag of value.flags as UnknownRecord[]) {
    if (flag.carrierId !== null && value.players[flag.carrierId as string] === undefined) return false;
  }

  if (!isTower(value.tower)) return false;
  const tower = value.tower as UnknownRecord;
  if (tower.turretOwnerId !== null && value.players[tower.turretOwnerId as string] === undefined) return false;
  if (config.mode !== 'towah-of-powah' && tower.turretOwnerId !== null) return false;
  if (!isRecord(value.teamScores)
    || !isSafeNonNegativeInteger(value.teamScores.aurora)
    || !isSafeNonNegativeInteger(value.teamScores.nova)) return false;

  if (!isSafeNonNegativeInteger(value.eventSequence) || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) return false;
  let previousEventId = 0;
  for (const event of value.events) {
    if (!isGameEvent(event, value.elapsed, value.eventSequence) || (event.id as number) <= previousEventId) return false;
    previousEventId = event.id as number;
  }
  return true;
};

/**
 * Runtime boundary for authoritative state received from a P2P host.
 * It performs bounded, allocation-light structural checks and never throws.
 */
export const isValidMatchState = (value: unknown): value is MatchState => {
  try {
    return validateMatchState(value);
  } catch {
    return false;
  }
};
