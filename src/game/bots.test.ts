import { describe, expect, it } from 'vitest';

import { BOT_DIFFICULTY_PROFILES, createBotMemory } from './bots';

describe('bot difficulty profiles', () => {
  it('keeps reaction, tracking and perception progressive without instant aim', () => {
    const { recruit, veteran, legend } = BOT_DIFFICULTY_PROFILES;

    expect(recruit.reaction).toBeGreaterThan(veteran.reaction);
    expect(veteran.reaction).toBeGreaterThan(legend.reaction);
    expect(legend.reaction).toBeGreaterThanOrEqual(0.28);

    expect(recruit.aimError).toBeGreaterThan(veteran.aimError);
    expect(veteran.aimError).toBeGreaterThan(legend.aimError);
    expect(legend.aimError * 180 / Math.PI).toBeGreaterThanOrEqual(2.5);

    expect(recruit.turnRate).toBeLessThan(veteran.turnRate);
    expect(veteran.turnRate).toBeLessThan(legend.turnRate);
    expect(legend.turnRate * 180 / Math.PI).toBeLessThanOrEqual(225);

    expect(recruit.visionRange).toBeLessThan(veteran.visionRange);
    expect(veteran.visionRange).toBeLessThan(legend.visionRange);
  });

  it('reduces combat movement and special-action pressure on every tier', () => {
    const { recruit, veteran, legend } = BOT_DIFFICULTY_PROFILES;

    expect(recruit.combatMovementScale).toBeLessThan(veteran.combatMovementScale);
    expect(veteran.combatMovementScale).toBeLessThan(legend.combatMovementScale);
    expect(legend.combatMovementScale).toBeLessThan(1);

    expect(recruit.grenadeChance).toBeLessThan(veteran.grenadeChance);
    expect(veteran.grenadeChance).toBeLessThan(legend.grenadeChance);
    expect(legend.grenadeChance).toBeLessThanOrEqual(0.05);
    expect(legend.jumpChance).toBeLessThanOrEqual(0.04);
    expect(recruit.decisionInterval).toBeGreaterThan(veteran.decisionInterval);
    expect(veteran.decisionInterval).toBeGreaterThan(legend.decisionInterval);
  });

  it('instantiates each requested difficulty without sharing mutable memory', () => {
    const recruit = createBotMemory('recruit');
    const veteran = createBotMemory('veteran');
    const legend = createBotMemory('legend');

    expect([recruit.difficulty, veteran.difficulty, legend.difficulty]).toEqual(['recruit', 'veteran', 'legend']);
    recruit.aimError.x = 99;
    expect(veteran.aimError.x).toBe(0);
    expect(legend.aimError.x).toBe(0);
  });
});
