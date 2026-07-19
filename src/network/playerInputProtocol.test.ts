import { describe, expect, it } from 'vitest';

import { emptyInput } from '../game/math';
import { PLAYER_PITCH_LIMIT } from '../game/types';
import { DIGITAL_INPUT_KEYS, isValidPlayerInput } from './playerInputProtocol';

describe('isValidPlayerInput', () => {
  it('accepts valid inputs at their numeric boundaries', () => {
    const cases = [
      emptyInput(),
      {
        ...emptyInput(),
        sequence: Number.MAX_SAFE_INTEGER,
        moveX: -1,
        moveZ: 1,
        yaw: Math.PI,
        pitch: PLAYER_PITCH_LIMIT,
      },
      {
        ...emptyInput(),
        moveX: 1,
        moveZ: -1,
        yaw: -Math.PI,
        pitch: -PLAYER_PITCH_LIMIT,
      },
    ];

    for (const value of cases) expect(isValidPlayerInput(value)).toBe(true);
  });

  it('rejects unsafe sequences, non-finite values, and values outside gameplay ranges', () => {
    const cases: Array<{ label: string; patch: Record<string, unknown> }> = [
      { label: 'negative sequence', patch: { sequence: -1 } },
      { label: 'fractional sequence', patch: { sequence: 1.5 } },
      { label: 'unsafe sequence', patch: { sequence: Number.MAX_SAFE_INTEGER + 1 } },
      { label: 'moveX above one', patch: { moveX: 1.000_001 } },
      { label: 'moveZ below minus one', patch: { moveZ: -1.000_001 } },
      { label: 'infinite movement', patch: { moveX: Number.POSITIVE_INFINITY } },
      { label: 'NaN movement', patch: { moveZ: Number.NaN } },
      { label: 'yaw outside tolerance', patch: { yaw: Math.PI + 0.001_001 } },
      { label: 'infinite yaw', patch: { yaw: Number.NEGATIVE_INFINITY } },
      { label: 'pitch outside tolerance', patch: { pitch: PLAYER_PITCH_LIMIT + 0.001_001 } },
      { label: 'NaN pitch', patch: { pitch: Number.NaN } },
    ];

    for (const { label, patch } of cases) {
      expect(isValidPlayerInput({ ...emptyInput(), ...patch }), label).toBe(false);
    }
  });

  it.each(DIGITAL_INPUT_KEYS)('requires %s to be a real boolean', (key) => {
    expect(isValidPlayerInput({ ...emptyInput(), [key]: true })).toBe(true);
    expect(isValidPlayerInput({ ...emptyInput(), [key]: 1 })).toBe(false);

    const missing = { ...emptyInput() } as Record<string, unknown>;
    delete missing[key];
    expect(isValidPlayerInput(missing)).toBe(false);
  });
});
