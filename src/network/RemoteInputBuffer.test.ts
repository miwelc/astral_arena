import { describe, expect, it } from 'vitest';

import { emptyInput } from '../game/math';
import { RemoteInputBuffer } from './RemoteInputBuffer';

describe('RemoteInputBuffer', () => {
  it('keeps a quick down/up tap alive for two host ticks', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1 });
    buffer.push('guest', { ...emptyInput(), sequence: 2, fire: true });
    buffer.push('guest', { ...emptyInput(), sequence: 3, fire: false });

    expect(buffer.next('guest')).toMatchObject({ sequence: 2, fire: true });
    expect(buffer.next('guest')).toMatchObject({ sequence: 3, fire: false });
  });

  it('does not queue periodic movement/look-only samples', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1, moveZ: 0.4 });
    buffer.push('guest', { ...emptyInput(), sequence: 2, moveZ: 1, yaw: 0.8 });

    expect(buffer.next('guest')).toMatchObject({ sequence: 2, moveZ: 1, yaw: 0.8 });
    expect(buffer.next('guest')).toMatchObject({ sequence: 2, moveZ: 1, yaw: 0.8 });
  });

  it('preserves the release between consecutive semi-automatic clicks', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1, fire: true });
    buffer.push('guest', { ...emptyInput(), sequence: 2 });
    buffer.push('guest', { ...emptyInput(), sequence: 3, fire: true });
    buffer.push('guest', { ...emptyInput(), sequence: 4 });

    expect(Array.from({ length: 4 }, () => buffer.next('guest')?.fire)).toEqual([true, false, true, false]);
  });
});
