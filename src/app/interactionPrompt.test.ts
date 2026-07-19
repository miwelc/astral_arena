import { describe, expect, it } from 'vitest';

import { createDefaultConfig, GameSimulation } from '../game/simulation';
import { WEAPONS } from '../game/weapons';
import { interactionPromptFor } from './interactionPrompt';

const fixture = (mode: 'deathmatch' | 'towah-of-powah' = 'deathmatch') => {
  const simulation = new GameSimulation(
    createDefaultConfig({ mode, botFill: false }),
    [{ id: 'local', name: 'Local' }],
  );
  simulation.state.phase = 'playing';
  simulation.state.countdown = 0;
  const player = simulation.state.players.local!;
  return { simulation, player };
};

describe('context interaction presentation', () => {
  it('offers E and explains which equipped weapon will be replaced', () => {
    const { simulation, player } = fixture();
    const pickup = simulation.state.pickups.find(
      (candidate) => candidate.kind === 'weapon' && !player.inventory.some((weapon) => weapon.id === candidate.weaponId),
    );
    expect(pickup).toBeDefined();
    player.position = { ...pickup!.position };

    expect(interactionPromptFor(simulation.state, player)).toMatchObject({
      action: 'pickup-weapon',
      key: 'E',
      detail: `SUSTITUYE ${WEAPONS[player.inventory[player.activeWeapon]!.id].label.toUpperCase()}`,
    });
  });

  it('does not invite a player to take ammo they cannot use', () => {
    const { simulation, player } = fixture();
    const carried = player.inventory[0]!;
    const pickup = simulation.state.pickups.find((candidate) => candidate.weaponId === carried.id);
    expect(pickup).toBeDefined();
    carried.reserve = WEAPONS[carried.id].maxReserve;
    player.position = { ...pickup!.position };

    expect(interactionPromptFor(simulation.state, player)).toBeNull();
  });

  it('prioritizes entering and exiting the manual Towah turret', () => {
    const { simulation, player } = fixture('towah-of-powah');
    player.position = { ...simulation.state.tower.center };

    expect(interactionPromptFor(simulation.state, player)?.action).toBe('enter-turret');
    simulation.state.tower.turretOwnerId = player.id;
    expect(interactionPromptFor(simulation.state, player)?.action).toBe('exit-turret');
  });
});
