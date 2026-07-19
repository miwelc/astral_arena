import type { MatchState } from '../game/types';

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
  return [value.x, value.y, value.z].every(
    (coordinate) => isFiniteNumber(coordinate) && Math.abs(coordinate) <= MAX_WORLD_COORDINATE,
  );
};

const isPlayerInput = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.sequence)
    && isFiniteNumber(value.moveX) && Math.abs(value.moveX) <= 1
    && isFiniteNumber(value.moveZ) && Math.abs(value.moveZ) <= 1
    && isFiniteNumber(value.yaw) && Math.abs(value.yaw) <= Math.PI + 0.001
    && isFiniteNumber(value.pitch) && Math.abs(value.pitch) <= 1.481
    && [value.fire, value.aim, value.jump, value.reload, value.swap, value.melee, value.grenade]
      .every((button) => typeof button === 'boolean');
};

const isWeaponState = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isEnumValue(WEAPON_IDS, value.id)
    && isSafeNonNegativeInteger(value.magazine)
    && isSafeNonNegativeInteger(value.reserve)
    && isNonNegativeNumber(value.cooldown)
    && isNonNegativeNumber(value.reloadTimer);
};

const isBotMemory = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isEnumValue(DIFFICULTIES, value.difficulty)
    && isNonNegativeNumber(value.decisionTimer)
    && isNullableIdentifier(value.targetId)
    && (value.lastSeenPosition === null || isVec3(value.lastSeenPosition))
    && isFiniteNumber(value.lastSeenAt)
    && isSafeNonNegativeInteger(value.waypointIndex)
    && isNonNegativeNumber(value.reactionTimer)
    && isVec3(value.aimError)
    && isNonNegativeNumber(value.preferredRange)
    && isEnumValue(BOT_OBJECTIVES, value.objective)
    && (value.lastPosition === null || isVec3(value.lastPosition))
    && isNonNegativeNumber(value.stuckTimer)
    && isNonNegativeNumber(value.unstickTimer);
};

const isPlayerState = (value: unknown, recordId: string): boolean => {
  if (!isRecord(value) || value.id !== recordId || !isIdentifier(value.id)) return false;
  if (typeof value.name !== 'string' || value.name.length === 0 || value.name.length > 18) return false;
  if (!isEnumValue(PLAYER_KINDS, value.kind) || !isEnumValue(TEAMS, value.team)) return false;
  if (!isVec3(value.position) || !isVec3(value.velocity)) return false;

  const finiteFields = [value.yaw, value.pitch, value.radius, value.height, value.lastDamageAt];
  const nonNegativeFields = [
    value.health,
    value.shield,
    value.maxShield,
    value.overshieldDecayDelay,
    value.respawnTimer,
    value.spawnProtection,
    value.meleeCooldown,
    value.grenadeCooldown,
  ];
  if (!finiteFields.every(isFiniteNumber) || !nonNegativeFields.every(isNonNegativeNumber)) return false;
  if (Math.abs(value.yaw as number) > Math.PI + 0.001 || Math.abs(value.pitch as number) > 1.481) return false;
  if ((value.radius as number) <= 0 || (value.height as number) <= 0) return false;
  if (typeof value.grounded !== 'boolean' || typeof value.alive !== 'boolean' || typeof value.isJuggernaut !== 'boolean') return false;

  if (!Array.isArray(value.inventory) || value.inventory.length === 0 || value.inventory.length > 2) return false;
  const weaponIds = new Set<string>();
  for (const weapon of value.inventory) {
    if (!isWeaponState(weapon) || !isRecord(weapon) || weaponIds.has(weapon.id as string)) return false;
    weaponIds.add(weapon.id as string);
  }
  if (!isSafeNonNegativeInteger(value.activeWeapon) || value.activeWeapon >= value.inventory.length) return false;

  const integerFields = [value.grenades, value.lastProcessedInput, value.kills, value.deaths, value.assists, value.score, value.streak];
  if (!integerFields.every(isSafeNonNegativeInteger) || !isPlayerInput(value.input)) return false;
  if (!(value.carryingFlagTeam === null || isEnumValue(TEAMS, value.carryingFlagTeam))) return false;
  if (value.bot !== undefined && !isBotMemory(value.bot)) return false;
  return value.kind !== 'bot' || isBotMemory(value.bot);
};

const isMatchConfig = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isEnumValue(GAME_MODES, value.mode)
    && isEnumValue(MATCH_FORMATS, value.format)
    && isEnumValue(DIFFICULTIES, value.difficulty)
    && isSafeNonNegativeInteger(value.scoreLimit) && value.scoreLimit > 0 && value.scoreLimit <= 10_000
    && isSafeNonNegativeInteger(value.timeLimitSeconds) && value.timeLimitSeconds > 0 && value.timeLimitSeconds <= 86_400
    && typeof value.botFill === 'boolean'
    && typeof value.playerName === 'string' && value.playerName.length > 0 && value.playerName.length <= 64
    && value.mapId === 'crater-ridge';
};

const isProjectile = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return isIdentifier(value.id)
    && (value.kind === 'rocket' || value.kind === 'grenade')
    && isIdentifier(value.ownerId)
    && isEnumValue(TEAMS, value.team)
    && isVec3(value.position)
    && isVec3(value.velocity)
    && isFiniteNumber(value.radius) && value.radius > 0
    && isFiniteNumber(value.damage) && value.damage >= 0
    && isFiniteNumber(value.blastRadius) && value.blastRadius >= 0
    && isFiniteNumber(value.fuse)
    && typeof value.alive === 'boolean';
};

const isPickup = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (!isIdentifier(value.id) || !isEnumValue(PICKUP_KINDS, value.kind) || !isVec3(value.position)) return false;
  if (value.kind === 'weapon') {
    if (!isEnumValue(WEAPON_IDS, value.weaponId)) return false;
  } else if (value.weaponId !== undefined) {
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
  if (!(value.impact === undefined || typeof value.impact === 'boolean')) return false;
  if (!(value.message === undefined || (typeof value.message === 'string' && value.message.length <= 512))) return false;
  if (!(value.amount === undefined || isNonNegativeNumber(value.amount))) return false;
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
  const playerIds = Object.keys(value.players);
  if (playerIds.length > MAX_PLAYERS) return false;
  for (const playerId of playerIds) {
    if (!isIdentifier(playerId) || !isPlayerState(value.players[playerId], playerId)) return false;
  }

  if (!(value.winner === null || isEnumValue(TEAMS, value.winner) || isIdentifier(value.winner))) return false;
  if (!(value.juggernautId === null || (isIdentifier(value.juggernautId) && value.players[value.juggernautId] !== undefined))) return false;

  if (!Array.isArray(value.projectiles) || !hasUniqueValidItems(value.projectiles, MAX_PROJECTILES, isProjectile)) return false;
  if (!Array.isArray(value.pickups) || !hasUniqueValidItems(value.pickups, MAX_PICKUPS, isPickup)) return false;
  if (!Array.isArray(value.flags) || value.flags.length !== 2 || !value.flags.every(isFlag)) return false;
  const flagTeams = new Set(value.flags.map((flag) => (flag as UnknownRecord).team));
  if (flagTeams.size !== 2 || !flagTeams.has('aurora') || !flagTeams.has('nova')) return false;
  for (const flag of value.flags as UnknownRecord[]) {
    if (flag.carrierId !== null && value.players[flag.carrierId as string] === undefined) return false;
  }

  if (!isTower(value.tower)) return false;
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
