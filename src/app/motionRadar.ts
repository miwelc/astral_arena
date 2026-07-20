import type { MatchState, PlayerState, Team } from '../game/types';
import { isTeamGameMode } from '../game/modeRules';

export type MotionRadarRelation = 'ally' | 'enemy';
export type MotionRadarElevation = 'above' | 'level' | 'below';

export interface MotionRadarOptions {
  /** Horizontal detection radius, expressed in world metres. */
  radius?: number;
  /** Targets moving slower than this many metres per second are hidden. */
  motionThreshold?: number;
  /** Height difference at which the UI should show an up/down indicator. */
  elevationThreshold?: number;
  /** Opacity retained by a contact at the outer edge of the radar. */
  minimumOpacity?: number;
  /** Stationary shooters remain revealed for this many seconds after firing. */
  revealAfterShotSeconds?: number;
}

export interface MotionRadarContact {
  playerId: string;
  name: string;
  team: Team;
  relation: MotionRadarRelation;
  elevation: MotionRadarElevation;
  /** Normalized radar-space coordinate. -1 is left and +1 is right. */
  x: number;
  /** Normalized radar-space coordinate. -1 is forward/top and +1 is behind/bottom. */
  y: number;
  distance: number;
  normalizedDistance: number;
  verticalDelta: number;
  speed: number;
  opacity: number;
  revealedBy: 'motion' | 'fire';
}

export const DEFAULT_MOTION_RADAR_OPTIONS = Object.freeze({
  radius: 25,
  motionThreshold: 0.55,
  elevationThreshold: 2.4,
  minimumOpacity: 0.42,
  revealAfterShotSeconds: 0.8,
});

const EMPTY_MOTION_RADAR_OPTIONS: MotionRadarOptions = Object.freeze({});

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

const relationToLocal = (
  teamMode: boolean,
  local: PlayerState,
  target: PlayerState,
): MotionRadarRelation =>
  teamMode && local.team !== 'neutral' && target.team === local.team ? 'ally' : 'enemy';

/**
 * Produces presentation-ready movement contacts in local-player radar space.
 *
 * Contacts outside the radius, dead players and targets that are neither
 * moving nor firing are omitted. Results are ordered far-to-near so near
 * contacts can naturally paint over distant ones in a DOM or canvas HUD.
 */
export const buildMotionRadarContacts = (
  state: MatchState,
  localPlayerId: string,
  options: MotionRadarOptions = EMPTY_MOTION_RADAR_OPTIONS,
): MotionRadarContact[] => {
  const local = state.players[localPlayerId];
  if (!local || !local.alive) return [];

  const radius = Math.max(0.001, finiteOr(options.radius, DEFAULT_MOTION_RADAR_OPTIONS.radius));
  const motionThreshold = Math.max(
    0,
    finiteOr(options.motionThreshold, DEFAULT_MOTION_RADAR_OPTIONS.motionThreshold),
  );
  const elevationThreshold = Math.max(
    0,
    finiteOr(options.elevationThreshold, DEFAULT_MOTION_RADAR_OPTIONS.elevationThreshold),
  );
  const minimumOpacity = clamp(
    finiteOr(options.minimumOpacity, DEFAULT_MOTION_RADAR_OPTIONS.minimumOpacity),
    0,
    1,
  );
  const revealAfterShotSeconds = Math.max(
    0,
    finiteOr(options.revealAfterShotSeconds, DEFAULT_MOTION_RADAR_OPTIONS.revealAfterShotSeconds),
  );

  if (
    !Number.isFinite(local.position.x)
    || !Number.isFinite(local.position.y)
    || !Number.isFinite(local.position.z)
    || !Number.isFinite(local.yaw)
  ) return [];

  let recentlyFiring: Set<string> | null = null;
  for (const event of state.events) {
    if (
      event.type === 'shot'
      && event.actorId
      && state.elapsed >= event.time
      && state.elapsed - event.time <= revealAfterShotSeconds
    ) (recentlyFiring ??= new Set<string>()).add(event.actorId);
  }
  const forwardX = -Math.sin(local.yaw);
  const forwardZ = -Math.cos(local.yaw);
  const rightX = Math.cos(local.yaw);
  const rightZ = -Math.sin(local.yaw);
  const teamMode = isTeamGameMode(state.config.mode);
  const contacts: MotionRadarContact[] = [];

  for (const targetId in state.players) {
    const target = state.players[targetId];
    if (!target) continue;
    if (target.id === local.id || !target.alive) continue;
    if (
      !Number.isFinite(target.position.x)
      || !Number.isFinite(target.position.y)
      || !Number.isFinite(target.position.z)
      || !Number.isFinite(target.velocity.x)
      || !Number.isFinite(target.velocity.y)
      || !Number.isFinite(target.velocity.z)
    ) {
      continue;
    }

    const speed = Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z);
    const firedRecently = recentlyFiring?.has(target.id) ?? false;
    // Like Halo's motion tracker, a crouch-walking contact stays hidden. Firing
    // still reveals it briefly so stealth has a clear, readable counterplay.
    if (target.crouched && !firedRecently) continue;
    if (speed < motionThreshold && !firedRecently) continue;

    const deltaX = target.position.x - local.position.x;
    const deltaZ = target.position.z - local.position.z;
    const distance = Math.hypot(deltaX, deltaZ);
    if (distance > radius) continue;

    const normalizedDistance = clamp(distance / radius, 0, 1);
    const localRight = deltaX * rightX + deltaZ * rightZ;
    const localForward = deltaX * forwardX + deltaZ * forwardZ;
    let x = localRight / radius;
    let y = -localForward / radius;
    const coordinateLength = Math.hypot(x, y);
    if (coordinateLength > 1) {
      x /= coordinateLength;
      y /= coordinateLength;
    }
    x = clamp(x, -1, 1);
    y = clamp(y, -1, 1);

    const verticalDelta = target.position.y - local.position.y;
    const elevation: MotionRadarElevation = verticalDelta > elevationThreshold
      ? 'above'
      : verticalDelta < -elevationThreshold
        ? 'below'
        : 'level';

    contacts.push({
      playerId: target.id,
      name: target.name,
      team: target.team,
      relation: relationToLocal(teamMode, local, target),
      elevation,
      x,
      y,
      distance,
      normalizedDistance,
      verticalDelta,
      speed,
      opacity: minimumOpacity + (1 - minimumOpacity) * (1 - normalizedDistance),
      revealedBy: speed >= motionThreshold ? 'motion' : 'fire',
    });
  }

  contacts.sort((left, right) => right.distance - left.distance || left.playerId.localeCompare(right.playerId));
  return contacts;
};
