import type { PlayerInput } from '../game/types';

const DIGITAL_INPUT_KEYS = [
  'fire',
  'aim',
  'jump',
  'reload',
  'swap',
  'melee',
  'grenade',
  'crouch',
  'use',
] as const satisfies readonly (keyof PlayerInput)[];

/**
 * Converts an arbitrarily timed WebRTC input stream into one digital
 * transition per authoritative tick. Continuous movement/look samples may be
 * replaced by newer data; button edges may not.
 */
export class RemoteInputBuffer {
  private readonly latest = new Map<string, PlayerInput>();
  private readonly transitions = new Map<string, PlayerInput[]>();

  public constructor(private readonly maximumQueuedTransitions = 32) {}

  public push(peerId: string, input: PlayerInput): void {
    const snapshot = { ...input };
    const previous = this.latest.get(peerId);
    this.latest.set(peerId, snapshot);
    const digitalChanged = previous
      ? DIGITAL_INPUT_KEYS.some((key) => previous[key] !== snapshot[key])
      : DIGITAL_INPUT_KEYS.some((key) => snapshot[key] === true);
    if (!digitalChanged) return;
    const queue = this.transitions.get(peerId) ?? [];
    queue.push(snapshot);
    if (queue.length > this.maximumQueuedTransitions) {
      queue.splice(0, queue.length - this.maximumQueuedTransitions);
    }
    this.transitions.set(peerId, queue);
  }

  public next(peerId: string): PlayerInput | null {
    const latest = this.latest.get(peerId);
    if (!latest) return null;
    const queue = this.transitions.get(peerId);
    const input = queue?.shift() ?? latest;
    if (queue?.length === 0) this.transitions.delete(peerId);
    return input;
  }

  public peerIds(): IterableIterator<string> {
    return this.latest.keys();
  }

  public delete(peerId: string): void {
    this.latest.delete(peerId);
    this.transitions.delete(peerId);
  }

  public clear(): void {
    this.latest.clear();
    this.transitions.clear();
  }
}
