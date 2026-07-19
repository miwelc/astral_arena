import { describe, expect, it } from 'vitest';

import { UMBRA_STATION } from './map';
import { createDefaultConfig, GameSimulation } from './simulation';
import type { GameMode, PlayerState } from './types';
import { isValidMatchState } from '../network/matchStateValidation';

const start = (mode: GameMode, botFill = true): GameSimulation => {
  const simulation = new GameSimulation(
    createDefaultConfig({
      mode,
      mapId: 'umbra-station',
      botFill,
      playerCount: mode === 'deathmatch' ? 8 : undefined,
    }),
    [{ id: 'local', name: 'Local' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  return simulation;
};

const localPlayer = (simulation: GameSimulation): PlayerState => {
  const player = simulation.state.players.local;
  if (!player) throw new Error('Missing local player');
  return player;
};

describe('Umbra Station simulation integration', () => {
  it.each<GameMode>([
    'deathmatch',
    'team-deathmatch',
    'capture-the-flag',
    'juggernaut',
    'towah-of-powah',
  ])('runs authoritative %s play with bot fill on the new map', (mode) => {
    const simulation = start(mode);
    for (let tick = 0; tick < 240; tick += 1) simulation.step(1 / 60);

    expect(simulation.map).toBe(UMBRA_STATION);
    expect(simulation.state.config.mapId).toBe('umbra-station');
    expect(Object.keys(simulation.state.players)).toHaveLength(8);
    expect(simulation.state.tower.radius).toBe(UMBRA_STATION.towerZone.radius);
    expect(Object.values(simulation.state.players).every((player) =>
      Number.isFinite(player.position.x)
      && Number.isFinite(player.position.y)
      && Number.isFinite(player.position.z),
    )).toBe(true);
    expect(isValidMatchState(simulation.state)).toBe(true);
  });

  it('preserves the selected map in default config overrides and CTF objectives', () => {
    const config = createDefaultConfig({ mode: 'capture-the-flag', mapId: 'umbra-station' });
    const simulation = new GameSimulation(config, []);

    expect(config.mapId).toBe('umbra-station');
    expect(simulation.state.flags.find((flag) => flag.team === 'aurora')?.basePosition)
      .toEqual(UMBRA_STATION.flagBases.aurora);
    expect(simulation.state.flags.find((flag) => flag.team === 'nova')?.basePosition)
      .toEqual(UMBRA_STATION.flagBases.nova);
  });

  it('does not award Towah control to a player directly below the raised deck', () => {
    const simulation = start('towah-of-powah', false);
    const player = localPlayer(simulation);
    player.team = 'aurora';
    player.position = {
      x: simulation.state.tower.center.x + 6,
      y: 0,
      z: simulation.state.tower.center.z,
    };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.grounded = true;

    simulation.step(1 / 60);
    expect(simulation.state.tower.controllingTeam).toBe('neutral');

    player.position.y = UMBRA_STATION.towerZone.controlMinY + 0.15;
    player.velocity = { x: 0, y: 0, z: 0 };
    player.grounded = true;
    simulation.step(1 / 60);
    expect(simulation.state.tower.controllingTeam).toBe('aurora');
  });

  it('launches from Umbra pads without activating a pad from another map', () => {
    const simulation = start('deathmatch', false);
    const player = localPlayer(simulation);
    const pad = UMBRA_STATION.jumpPads[0]!;
    player.position = { ...pad.center, y: UMBRA_STATION.bounds.floorY };
    player.velocity = { x: 0, y: 0, z: 0 };
    player.grounded = true;

    simulation.step(1 / 60);

    expect(player.velocity.y).toBeGreaterThan(10);
    expect(player.grounded).toBe(false);
    expect(player.velocity.x).toBeGreaterThan(0);
  });
});
