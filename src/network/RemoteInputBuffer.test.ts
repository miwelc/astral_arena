import { describe, expect, it } from 'vitest';

import { emptyInput } from '../game/math';
import { createDefaultConfig, GameSimulation } from '../game/simulation';
import { RemoteInputBuffer } from './RemoteInputBuffer';

describe('RemoteInputBuffer', () => {
  it('keeps a quick down/up tap alive for two host ticks', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1 });
    buffer.push('guest', { ...emptyInput(), sequence: 2, fire: true });
    buffer.push('guest', { ...emptyInput(), sequence: 3, fire: false });

    expect(buffer.next('guest')).toMatchObject({ sequence: 3, fire: true });
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

    expect(Array.from({ length: 4 }, () => buffer.next('guest'))).toEqual([
      expect.objectContaining({ sequence: 4, fire: true }),
      expect.objectContaining({ sequence: 4, fire: false }),
      expect.objectContaining({ sequence: 4, fire: true }),
      expect.objectContaining({ sequence: 4, fire: false }),
    ]);
  });

  it('preserves quick crouch transitions for authoritative stance and radar state', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1 });
    buffer.push('guest', { ...emptyInput(), sequence: 2, crouch: true });
    buffer.push('guest', { ...emptyInput(), sequence: 3, crouch: false });

    expect(buffer.next('guest')).toMatchObject({ sequence: 3, crouch: true });
    expect(buffer.next('guest')).toMatchObject({ sequence: 3, crouch: false });
  });

  it('combines queued button edges with the freshest movement and look', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 1, fire: true, moveZ: 0.2, yaw: 0.1 });
    buffer.push('guest', { ...emptyInput(), sequence: 2, fire: false, moveZ: 1, yaw: 0.8 });
    buffer.push('guest', { ...emptyInput(), sequence: 3, moveX: 0.5, moveZ: 0.9, yaw: 1.1 });

    expect(buffer.next('guest')).toMatchObject({
      sequence: 3,
      fire: true,
      moveX: 0.5,
      moveZ: 0.9,
      yaw: 1.1,
    });
    expect(buffer.next('guest')).toMatchObject({
      sequence: 3,
      fire: false,
      moveX: 0.5,
      moveZ: 0.9,
      yaw: 1.1,
    });
  });

  it('ignores stale or duplicate sequences', () => {
    const buffer = new RemoteInputBuffer();
    buffer.push('guest', { ...emptyInput(), sequence: 4, moveZ: 1 });
    buffer.push('guest', { ...emptyInput(), sequence: 3, fire: true, moveZ: -1 });
    buffer.push('guest', { ...emptyInput(), sequence: 4, fire: true, moveZ: -1 });

    expect(buffer.next('guest')).toMatchObject({ sequence: 4, fire: false, moveZ: 1 });
  });

  it('applies every queued edge even when continuous acknowledgement sequences are equal', () => {
    const buffer = new RemoteInputBuffer();
    const simulation = new GameSimulation(
      createDefaultConfig({ mode: 'deathmatch', botFill: false }),
      [{ id: 'guest', name: 'Guest', kind: 'remote' }],
    );
    simulation.state.phase = 'playing';
    simulation.state.countdown = 0;
    const player = simulation.state.players.guest;
    if (!player) throw new Error('Missing guest fixture');

    buffer.push('guest', { ...emptyInput(), sequence: 1, crouch: true });
    buffer.push('guest', { ...emptyInput(), sequence: 2, crouch: false });
    buffer.push('guest', { ...emptyInput(), sequence: 3, crouch: true });
    buffer.push('guest', { ...emptyInput(), sequence: 4, crouch: false });

    const observed = Array.from({ length: 4 }, () => {
      const next = buffer.next('guest');
      if (!next) throw new Error('Missing buffered transition');
      simulation.setInput('guest', next);
      simulation.step(0);
      return { sequence: player.lastProcessedInput, crouched: player.crouched };
    });

    expect(observed).toEqual([
      { sequence: 4, crouched: true },
      { sequence: 4, crouched: false },
      { sequence: 4, crouched: true },
      { sequence: 4, crouched: false },
    ]);
  });
});
