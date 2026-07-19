import { canOccupyCapsule, moveCapsule } from './collision';
import { isJumpPad } from './map';
import { add, clamp, dot, scale, subtract, vec3 } from './math';
import type {
  MapDefinition,
  MatchState,
  PlayerInput,
  PlayerMovementMemory,
  PlayerState,
} from './types';

export const STANDING_PLAYER_HEIGHT = 1.8;
export const CROUCHED_PLAYER_HEIGHT = 1.22;

export const PLAYER_MOVEMENT_TUNING = Object.freeze({
  moveSpeed: 6.35,
  groundAcceleration: 28,
  groundDeceleration: 35,
  airAcceleration: 4.8,
  gravity: 15.5,
  jumpVelocity: 6.85,
  crouchSpeedScale: 0.56,
});

const JUMP_PAD_APEX_CLEARANCE = 1.75;
const JUMP_PAD_RETRIGGER_DELAY = 0.85;

export interface PlayerMovementContext {
  map: MapDefinition;
  tower: Pick<MatchState['tower'], 'center' | 'radius'>;
  elapsed: number;
}

export const createPlayerMovementMemory = (): PlayerMovementMemory => ({
  jumpPadReadyAt: 0,
  jumpPadMomentum: null,
});

/**
 * Advances the movement-only portion of a player tick.
 *
 * The authoritative simulation and guest-side prediction deliberately share
 * this function. Keeping collision, acceleration, crouching and jump-pad
 * behaviour identical prevents reconciliation from correcting avoidable
 * client/server drift every time a snapshot arrives.
 */
export const advancePlayerMovement = (
  player: PlayerState,
  input: PlayerInput,
  context: PlayerMovementContext,
  memory: PlayerMovementMemory,
  dt: number,
  jumpPressed: boolean,
): void => {
  updateCrouchStance(player, input, context.map);

  const sinYaw = Math.sin(player.yaw);
  const cosYaw = Math.cos(player.yaw);
  let wishX = cosYaw * input.moveX - sinYaw * input.moveZ;
  let wishZ = -sinYaw * input.moveX - cosYaw * input.moveZ;
  let wishLengthSquared = wishX * wishX + wishZ * wishZ;
  if (wishLengthSquared > 1) {
    const inverseWishLength = 1 / Math.sqrt(wishLengthSquared);
    wishX *= inverseWishLength;
    wishZ *= inverseWishLength;
    wishLengthSquared = 1;
  }

  const speedModifier = (player.isJuggernaut ? 0.95 : 1)
    * (player.carryingFlagTeam ? 0.95 : 1)
    * (player.crouched ? PLAYER_MOVEMENT_TUNING.crouchSpeedScale : 1);
  const hasMovementInput = wishLengthSquared >= 0.01;
  const desiredSpeed = PLAYER_MOVEMENT_TUNING.moveSpeed * speedModifier;
  const desiredX = wishX * desiredSpeed;
  const desiredZ = wishZ * desiredSpeed;

  if (player.grounded || hasMovementInput) {
    const acceleration = player.grounded
      ? (hasMovementInput
          ? PLAYER_MOVEMENT_TUNING.groundAcceleration
          : PLAYER_MOVEMENT_TUNING.groundDeceleration)
      : PLAYER_MOVEMENT_TUNING.airAcceleration;
    const changeX = desiredX - player.velocity.x;
    const changeZ = desiredZ - player.velocity.z;
    const changeLength = Math.hypot(changeX, changeZ);
    const maxChange = acceleration * dt;
    if (changeLength <= maxChange || changeLength < 0.0001) {
      player.velocity.x = desiredX;
      player.velocity.z = desiredZ;
    } else {
      const changeScale = maxChange / changeLength;
      player.velocity.x += changeX * changeScale;
      player.velocity.z += changeZ * changeScale;
    }
  }

  if (memory.jumpPadMomentum && !player.grounded) {
    const inwardSpeed = dot(player.velocity, memory.jumpPadMomentum.direction);
    if (inwardSpeed < memory.jumpPadMomentum.minimumSpeed) {
      const correction = scale(
        memory.jumpPadMomentum.direction,
        memory.jumpPadMomentum.minimumSpeed - inwardSpeed,
      );
      player.velocity.x += correction.x;
      player.velocity.z += correction.z;
    }
  }

  const launchedFromPad = tryLaunchFromJumpPad(player, context, memory);
  if (!launchedFromPad && jumpPressed && player.grounded) {
    player.velocity.y = PLAYER_MOVEMENT_TUNING.jumpVelocity;
    player.grounded = false;
  }

  player.velocity.y -= PLAYER_MOVEMENT_TUNING.gravity * dt;
  const movement = moveCapsule(player, context.map, dt);
  player.position = movement.position;
  player.velocity = movement.velocity;
  player.grounded = movement.grounded;
  if (movement.grounded) memory.jumpPadMomentum = null;
};

const updateCrouchStance = (
  player: PlayerState,
  input: PlayerInput,
  map: MapDefinition,
): void => {
  if (input.crouch) {
    player.crouched = true;
    player.height = CROUCHED_PLAYER_HEIGHT;
    return;
  }
  if (!player.crouched) {
    player.height = STANDING_PLAYER_HEIGHT;
    return;
  }
  if (canOccupyCapsule(player.position, player.radius, STANDING_PLAYER_HEIGHT, map)) {
    player.crouched = false;
    player.height = STANDING_PLAYER_HEIGHT;
  } else {
    player.height = CROUCHED_PLAYER_HEIGHT;
  }
};

const tryLaunchFromJumpPad = (
  player: PlayerState,
  context: PlayerMovementContext,
  memory: PlayerMovementMemory,
): boolean => {
  if (
    !player.grounded
    || !isJumpPad(player.position, context.map)
    || context.elapsed < memory.jumpPadReadyAt
  ) {
    return false;
  }

  const towerDelta = subtract(context.tower.center, player.position);
  const towerDistance = Math.hypot(towerDelta.x, towerDelta.z);
  const towardTower = towerDistance > 0.001
    ? { x: towerDelta.x / towerDistance, y: 0, z: towerDelta.z / towerDistance }
    : vec3();
  const landingRadius = Math.max(1.5, context.tower.radius - 1.2);
  const landingDistance = Math.max(0, towerDistance - landingRadius);
  const targetHeight = Math.max(context.tower.center.y, player.position.y + 3.5);
  const heightDelta = targetHeight - player.position.y;
  const launchVelocityY = Math.sqrt(
    2 * PLAYER_MOVEMENT_TUNING.gravity * (heightDelta + JUMP_PAD_APEX_CLEARANCE),
  );
  const descendingTime = (
    launchVelocityY
    + Math.sqrt(Math.max(
      0,
      launchVelocityY ** 2 - 2 * PLAYER_MOVEMENT_TUNING.gravity * heightDelta,
    ))
  ) / PLAYER_MOVEMENT_TUNING.gravity;
  const targetHorizontalSpeed = clamp(
    landingDistance / Math.max(0.1, descendingTime),
    3.2,
    9.5,
  );
  const currentHorizontal = { x: player.velocity.x, y: 0, z: player.velocity.z };
  const targetHorizontal = scale(towardTower, targetHorizontalSpeed);
  const blendedHorizontal = add(
    scale(targetHorizontal, 0.82),
    scale(currentHorizontal, 0.18),
  );

  player.velocity.x = blendedHorizontal.x;
  player.velocity.z = blendedHorizontal.z;
  player.velocity.y = Math.max(player.velocity.y, launchVelocityY);
  player.grounded = false;
  memory.jumpPadReadyAt = context.elapsed + JUMP_PAD_RETRIGGER_DELAY;
  memory.jumpPadMomentum = {
    direction: towardTower,
    minimumSpeed: Math.max(0, dot(blendedHorizontal, towardTower)),
  };
  return true;
};
