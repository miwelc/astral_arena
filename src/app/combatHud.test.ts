import { describe, expect, it } from 'vitest';

import type { GameEvent } from '../game/types';
import { directionalDamagePresentation, latestDamageEventAfter, selectCombatWarning } from './combatHud';

describe('combat HUD warnings', () => {
  it('prioritizes an empty weapon over secondary inventory warnings', () => {
    expect(selectCombatWarning({ magazine: 0, reserve: 0, reloadTimer: 0 }, 32, 0)).toEqual({
      label: 'SIN MUNICIÓN',
      tone: 'critical',
    });
    expect(selectCombatWarning({ magazine: 0, reserve: 64, reloadTimer: 0 }, 32, 0)).toEqual({
      label: 'RECARGAR',
      tone: 'critical',
    });
  });

  it('warns at twenty percent of a magazine and does not ask to reload while reloading', () => {
    expect(selectCombatWarning({ magazine: 6, reserve: 64, reloadTimer: 0 }, 32, 2)?.label).toBe('POCAS BALAS');
    expect(selectCombatWarning({ magazine: 7, reserve: 64, reloadTimer: 0 }, 32, 2)).toBeNull();
    expect(selectCombatWarning({ magazine: 0, reserve: 64, reloadTimer: 0.7 }, 32, 2)).toBeNull();
  });

  it('shows the grenade warning only while an empty throw is attempted', () => {
    expect(selectCombatWarning({ magazine: 20, reserve: 64, reloadTimer: 0 }, 32, 0)).toBeNull();
    expect(selectCombatWarning({ magazine: 20, reserve: 64, reloadTimer: 0 }, 32, 0, true)).toEqual({
      label: 'SIN GRANADAS',
      tone: 'utility',
    });
  });
});

describe('directional damage presentation', () => {
  const target = { position: { x: 0, y: 0, z: 0 }, yaw: 0, maxShield: 100 };

  it('maps world sources to player-relative HUD directions', () => {
    expect(directionalDamagePresentation({ amount: 20, sourcePosition: { x: 0, y: 0, z: -5 } }, target).angleDegrees).toBeCloseTo(0);
    expect(directionalDamagePresentation({ amount: 20, sourcePosition: { x: 5, y: 0, z: 0 } }, target).angleDegrees).toBeCloseTo(90);
    expect(Math.abs(directionalDamagePresentation({ amount: 20, sourcePosition: { x: 0, y: 0, z: 5 } }, target).angleDegrees)).toBeCloseTo(180);
  });

  it('uses cyan for shield-only impacts and red as soon as health is damaged', () => {
    expect(directionalDamagePresentation({ shieldDamage: 18, healthDamage: 0 }, target).tone).toBe('shield');
    expect(directionalDamagePresentation({ shieldDamage: 4, healthDamage: 9 }, target).tone).toBe('health');
  });
});

describe('incremental damage event scan', () => {
  it('returns only the newest unseen local hit as the cursor advances', () => {
    const events: GameEvent[] = [
      { id: 1, time: 1, type: 'hit', targetId: 'local', amount: 5 },
      { id: 2, time: 2, type: 'hit', targetId: 'other', amount: 7 },
      { id: 3, time: 3, type: 'shot', actorId: 'other' },
      { id: 4, time: 4, type: 'hit', targetId: 'local', amount: 11 },
    ];

    let cursor = 0;
    expect(latestDamageEventAfter(events, 'local', cursor)?.id).toBe(4);
    cursor = events.at(-1)!.id;
    expect(latestDamageEventAfter(events, 'local', cursor)).toBeUndefined();

    events.push({ id: 5, time: 5, type: 'score', actorId: 'other' });
    expect(latestDamageEventAfter(events, 'local', cursor)).toBeUndefined();
    cursor = events.at(-1)!.id;

    events.push({ id: 6, time: 6, type: 'hit', targetId: 'local', amount: 13 });
    expect(latestDamageEventAfter(events, 'local', cursor)?.id).toBe(6);
  });
});
