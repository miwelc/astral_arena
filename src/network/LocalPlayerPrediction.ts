import { MAPS, TOWER_TURRET_LAYOUT } from '../game/map';
import { clamp, distance, moveAngleToward, vec3 } from '../game/math';
import {
  advancePlayerMovement,
  STANDING_PLAYER_HEIGHT,
} from '../game/playerMovement';
import { towerTurretOperatorPosition } from '../game/simulation';
import type {
  MatchState,
  PlayerInput,
  PlayerState,
  Vec3,
} from '../game/types';
import { PLAYER_PITCH_LIMIT } from '../game/types';
import { DIGITAL_INPUT_KEYS } from './playerInputProtocol';

const MAX_PENDING_INPUTS = 300;
const SNAP_CORRECTION_DISTANCE = 3;
const CORRECTION_DECAY_PER_SECOND = 14;
const MAX_QUEUED_TRANSITIONS = 32;

interface PendingInput {
  input: PlayerInput;
  dt: number;
}

/**
 * Predicts only the locally controlled guest's movement.
 *
 * Combat, damage, pickups and scoring remain fully authoritative. On every
 * host snapshot we rewind to the acknowledged pose, discard processed inputs,
 * replay the remaining commands and decay the resulting visual correction.
 */
export class LocalPlayerPrediction {
  private player: PlayerState | null = null;
  private matchId: string | null = null;
  private readonly pending: PendingInput[] = [];
  private previousInput: PlayerInput | null = null;
  private readonly queuedTransitions: PlayerInput[] = [];
  private readonly visualCorrection: Vec3 = vec3();

  public reset(): void {
    this.player = null;
    this.matchId = null;
    this.pending.length = 0;
    this.previousInput = null;
    this.queuedTransitions.length = 0;
    this.visualCorrection.x = 0;
    this.visualCorrection.y = 0;
    this.visualCorrection.z = 0;
  }

  /** Applies one unacknowledged fixed input tick immediately on the guest. */
  public advance(state: MatchState, playerId: string, input: PlayerInput, dt: number): void {
    this.ensureInitialized(state, playerId);
    if (!this.player) return;

    const transition = this.queuedTransitions.shift();
    const effectiveInput = transition
      ? {
          ...transition,
          sequence: input.sequence,
          moveX: input.moveX,
          moveZ: input.moveZ,
          yaw: input.yaw,
          pitch: input.pitch,
        }
      : input;
    const command = { input: effectiveInput, dt };
    this.pending.push(command);
    if (this.pending.length > MAX_PENDING_INPUTS) {
      this.pending.splice(0, this.pending.length - MAX_PENDING_INPUTS);
    }
    this.advanceCommand(state, command, 0);
  }

  /** Queues a short digital edge for one future prediction tick. */
  public observeEdge(state: MatchState, playerId: string, input: PlayerInput): void {
    this.ensureInitialized(state, playerId);
    const previous = this.queuedTransitions.at(-1) ?? this.previousInput;
    const changed = !previous
      || DIGITAL_INPUT_KEYS.some((key) => previous[key] !== input[key]);
    if (!changed) return;
    this.queuedTransitions.push({ ...input });
    if (this.queuedTransitions.length > MAX_QUEUED_TRANSITIONS) {
      this.queuedTransitions.splice(0, this.queuedTransitions.length - MAX_QUEUED_TRANSITIONS);
    }
  }

  /** Keeps mouse look latency-free between fixed prediction ticks. */
  public setLook(state: MatchState, playerId: string, input: PlayerInput): void {
    this.ensureInitialized(state, playerId);
    if (!this.player?.alive) return;
    const operatingTurret = state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === playerId;
    // Mounted yaw is rate-limited in fixed prediction ticks below. Applying it
    // again on every render frame would make turn speed refresh-rate dependent.
    if (!operatingTurret) this.player.yaw = input.yaw;
    this.player.pitch = clamp(input.pitch, -PLAYER_PITCH_LIMIT, PLAYER_PITCH_LIMIT);
  }

  /** Rewinds to host truth and replays commands the host has not acknowledged. */
  public reconcile(state: MatchState, playerId: string, acknowledgedInput: number): void {
    const authoritative = state.players[playerId];
    if (!authoritative) {
      this.reset();
      return;
    }

    const sameMatch = this.matchId === state.matchId;
    const previousAlive = this.player?.alive ?? authoritative.alive;
    const previouslyPresented = this.player
      ? {
          x: this.player.position.x + this.visualCorrection.x,
          y: this.player.position.y + this.visualCorrection.y,
          z: this.player.position.z + this.visualCorrection.z,
        }
      : { ...authoritative.position };

    if (!sameMatch || !previousAlive || !authoritative.alive) {
      this.pending.length = 0;
      this.queuedTransitions.length = 0;
    } else {
      let acknowledgedCount = 0;
      while (
        acknowledgedCount < this.pending.length
        && this.pending[acknowledgedCount]!.input.sequence <= acknowledgedInput
      ) {
        acknowledgedCount += 1;
      }
      if (acknowledgedCount > 0) this.pending.splice(0, acknowledgedCount);
      // The acknowledgement covers the freshest continuous sample applied by
      // the host, not every digital edge still waiting behind it. Keep locally
      // queued edges until fixed prediction ticks consume them in order.
    }

    this.matchId = state.matchId;
    this.player = structuredClone(authoritative);
    this.previousInput = { ...authoritative.input };

    let replayElapsed = 0;
    for (const command of this.pending) {
      this.advanceCommand(state, command, replayElapsed);
      replayElapsed += command.dt;
    }

    const correctionDistance = distance(previouslyPresented, this.player.position);
    const shouldSmooth = sameMatch
      && previousAlive
      && authoritative.alive
      && correctionDistance <= SNAP_CORRECTION_DISTANCE;
    this.visualCorrection.x = shouldSmooth ? previouslyPresented.x - this.player.position.x : 0;
    this.visualCorrection.y = shouldSmooth ? previouslyPresented.y - this.player.position.y : 0;
    this.visualCorrection.z = shouldSmooth ? previouslyPresented.z - this.player.position.z : 0;
  }

  /** Publishes the predicted pose into the render snapshot. */
  public applyTo(state: MatchState, playerId: string, frameDt: number): void {
    if (!this.player || this.matchId !== state.matchId) return;
    const target = state.players[playerId];
    if (!target) return;

    const decay = Math.exp(-CORRECTION_DECAY_PER_SECOND * Math.max(0, frameDt));
    this.visualCorrection.x *= decay;
    this.visualCorrection.y *= decay;
    this.visualCorrection.z *= decay;

    target.position.x = this.player.position.x + this.visualCorrection.x;
    target.position.y = this.player.position.y + this.visualCorrection.y;
    target.position.z = this.player.position.z + this.visualCorrection.z;
    target.velocity.x = this.player.velocity.x;
    target.velocity.y = this.player.velocity.y;
    target.velocity.z = this.player.velocity.z;
    target.yaw = this.player.yaw;
    target.pitch = this.player.pitch;
    target.height = this.player.height;
    target.crouched = this.player.crouched;
    target.grounded = this.player.grounded;
    Object.assign(target.input, this.player.input);
  }

  public pendingInputCount(): number {
    return this.pending.length;
  }

  private ensureInitialized(state: MatchState, playerId: string): void {
    if (this.player && this.matchId === state.matchId && this.player.id === playerId) return;
    const authoritative = state.players[playerId];
    if (!authoritative) return;
    this.matchId = state.matchId;
    this.player = structuredClone(authoritative);
    this.previousInput = { ...authoritative.input };
    this.pending.length = 0;
    this.queuedTransitions.length = 0;
    this.visualCorrection.x = 0;
    this.visualCorrection.y = 0;
    this.visualCorrection.z = 0;
  }

  private advanceCommand(state: MatchState, command: PendingInput, elapsedOffset: number): void {
    const player = this.player;
    if (!player) return;
    const input = command.input;

    if (!player.alive) {
      this.previousInput = input;
      return;
    }

    const operatingTurret = state.config.mode === 'towah-of-powah'
      && state.tower.turretOwnerId === player.id;
    player.yaw = operatingTurret
      ? moveAngleToward(
          player.yaw,
          input.yaw,
          TOWER_TURRET_LAYOUT.turnRate * command.dt,
        )
      : input.yaw;
    player.pitch = clamp(input.pitch, -PLAYER_PITCH_LIMIT, PLAYER_PITCH_LIMIT);
    player.input = input;
    player.lastProcessedInput = Math.max(player.lastProcessedInput, input.sequence);

    if (state.phase === 'playing') {
      if (operatingTurret) {
        player.position = towerTurretOperatorPosition(state.tower.center, player.yaw);
        player.velocity = vec3();
        player.height = STANDING_PLAYER_HEIGHT;
        player.crouched = false;
        player.grounded = true;
      } else {
        advancePlayerMovement(
          player,
          input,
          {
            map: MAPS[state.config.mapId],
            tower: state.tower,
            elapsed: state.elapsed + elapsedOffset,
          },
          player.movementMemory,
          command.dt,
          !this.previousInput?.jump && input.jump,
        );
      }
    }
    this.previousInput = input;
  }
}
