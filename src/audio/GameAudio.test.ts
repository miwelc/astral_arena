import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GameEvent, WeaponId } from '../game/types';
import {
  COMBAT_FEEDBACK_SOUND_PROFILE,
  GameAudio,
  hitMarkerKindFor,
  killConfirmationKindFor,
  MOVEMENT_SOUND_PROFILE,
  SHIELD_RECHARGE_SOUND_PROFILE,
  shieldRechargeCueWasInterrupted,
  WEAPON_SOUND_PROFILES,
} from './GameAudio';

const weaponIds: WeaponId[] = [
  'pulse-rifle',
  'sidearm',
  'battle-rifle',
  'sniper',
  'shotgun',
  'rocket-launcher',
];

describe('procedural weapon sound profiles', () => {
  it('defines safe attack, body, tail and mechanism layers for every weapon', () => {
    expect(Object.keys(WEAPON_SOUND_PROFILES).sort()).toEqual([...weaponIds].sort());
    for (const profile of Object.values(WEAPON_SOUND_PROFILES)) {
      for (const layer of [profile.attack, profile.body, profile.tail, profile.mechanism]) {
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.duration).toBeLessThan(0.5);
        expect(layer.volume).toBeGreaterThan(0);
        expect(layer.volume).toBeLessThanOrEqual(1);
        expect(layer.from).toBeGreaterThanOrEqual(20);
        expect(layer.to).toBeGreaterThanOrEqual(20);
      }
    }
  });

  it('gives every weapon a distinct spectral and temporal signature', () => {
    const signatures = weaponIds.map((id) => {
      const profile = WEAPON_SOUND_PROFILES[id];
      return [
        profile.attack.duration,
        profile.attack.from,
        profile.body.from,
        profile.body.to,
        profile.tail.duration,
        profile.mechanism.delay,
      ].join(':');
    });
    expect(new Set(signatures).size).toBe(weaponIds.length);
  });

  it('uses a heavier low-frequency body for rockets and shotguns', () => {
    const rifle = WEAPON_SOUND_PROFILES['pulse-rifle'];
    const shotgun = WEAPON_SOUND_PROFILES.shotgun;
    const rocket = WEAPON_SOUND_PROFILES['rocket-launcher'];
    expect(shotgun.body.to).toBeLessThan(rifle.body.to);
    expect(rocket.body.from).toBeLessThan(shotgun.body.from);
    expect(rocket.tail.duration).toBeGreaterThan(shotgun.tail.duration);
  });
});

describe('combat confirmation audio', () => {
  it('discards silent event history instead of replaying it after audio unlocks', () => {
    const audio = new GameAudio();
    const pastShot: GameEvent = {
      id: 7,
      time: 1,
      type: 'shot',
      actorId: 'local',
      weaponId: 'battle-rifle',
    };
    audio.consume([pastShot], 'local');

    let playedShots = 0;
    Object.assign(audio, {
      context: {} as AudioContext,
      master: {} as GainNode,
      shot: () => { playedShots += 1; },
    });
    audio.consume([pastShot], 'local');
    expect(playedShots).toBe(0);

    audio.consume([
      pastShot,
      { ...pastShot, id: 8, time: 1.1 },
    ], 'local');
    expect(playedShots).toBe(1);
  });

  it('uses one kill confirmation instead of stacking ordinary cues on a fatal shield break', () => {
    const audio = new GameAudio();
    const hitMarker = vi.fn();
    const bulletImpact = vi.fn();
    const shieldBreak = vi.fn();
    const killConfirmed = vi.fn();
    Object.assign(audio, {
      context: {} as AudioContext,
      master: {} as GainNode,
      hitMarker,
      bulletImpact,
      shieldBreak,
      killConfirmed,
    });
    const events: GameEvent[] = [
      {
        id: 1,
        time: 2,
        type: 'hit',
        actorId: 'local',
        targetId: 'enemy',
        fatal: true,
        headshot: true,
        shieldDamage: 8,
        healthDamage: 70,
      },
      { id: 2, time: 2, type: 'shield-break', actorId: 'local', targetId: 'enemy' },
      { id: 3, time: 2, type: 'kill', actorId: 'local', targetId: 'enemy', fatal: true, headshot: true },
    ];

    audio.consume(events, 'local');

    expect(hitMarker).not.toHaveBeenCalled();
    expect(bulletImpact).not.toHaveBeenCalled();
    expect(shieldBreak).not.toHaveBeenCalled();
    expect(killConfirmed).toHaveBeenCalledOnce();
    expect(killConfirmed).toHaveBeenCalledWith('headshot');
  });

  it('selects shield, exposed-health and mixed hit confirmations from authoritative damage', () => {
    expect(hitMarkerKindFor({ shieldDamage: 13, healthDamage: 0 })).toBe('shield');
    expect(hitMarkerKindFor({ shieldDamage: 0, healthDamage: 13 })).toBe('health');
    expect(hitMarkerKindFor({ shieldDamage: 4, healthDamage: 9 })).toBe('mixed');
    expect(hitMarkerKindFor({})).toBe('generic');
  });

  it('keeps shield contact brighter than the exposed-armour confirmation', () => {
    const shieldFloor = Math.min(...COMBAT_FEEDBACK_SOUND_PROFILE.shieldHit.map((tone) => tone.from));
    const healthCeiling = Math.max(...COMBAT_FEEDBACK_SOUND_PROFILE.healthHit.map((tone) => tone.from));
    expect(shieldFloor).toBeGreaterThan(healthCeiling);
    expect(COMBAT_FEEDBACK_SOUND_PROFILE.shieldHit).not.toEqual(COMBAT_FEEDBACK_SOUND_PROFILE.healthHit);
  });

  it('reserves the distinct headshot cue for a confirmed lethal head hit', () => {
    expect(killConfirmationKindFor({ headshot: true, fatal: true })).toBe('headshot');
    expect(killConfirmationKindFor({ headshot: true, fatal: false })).toBe('standard');
    expect(killConfirmationKindFor({ headshot: false, fatal: true })).toBe('standard');

    const headshot = COMBAT_FEEDBACK_SOUND_PROFILE.headshotConfirmed;
    const standard = COMBAT_FEEDBACK_SOUND_PROFILE.killConfirmed;
    expect(headshot).not.toEqual(standard);
    expect(Math.max(...headshot.map((tone) => tone.from))).toBeGreaterThan(
      Math.max(...standard.map((tone) => tone.from)),
    );
  });

  it('keeps every combat confirmation short and within safe gain bounds', () => {
    for (const profile of Object.values(COMBAT_FEEDBACK_SOUND_PROFILE)) {
      for (const tone of profile) {
        expect(tone.duration).toBeGreaterThan(0);
        expect(tone.duration).toBeLessThan(0.2);
        expect(tone.volume).toBeGreaterThan(0);
        expect(tone.volume).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('shield and announcer audio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses distinct, audible-safe rising signatures for recharge start and completion', () => {
    const { start, complete } = SHIELD_RECHARGE_SOUND_PROFILE;
    expect(start.duration).toBeGreaterThan(complete.duration);
    expect(start.from).toBeLessThan(start.to);
    expect(complete.from).toBeLessThan(complete.to);
    expect(`${start.from}:${start.to}:${start.duration}`).not.toBe(`${complete.from}:${complete.to}:${complete.duration}`);
    for (const cue of [start, complete]) {
      expect(cue.duration).toBeGreaterThan(0);
      expect(cue.duration).toBeLessThan(1);
      expect(cue.volume).toBeGreaterThan(0);
      expect(cue.volume).toBeLessThanOrEqual(1);
    }
  });

  it('suppresses a recharge cue when damage interrupts it in the same simulation beat', () => {
    const recharge: GameEvent = {
      id: 10,
      time: 4,
      type: 'shield-recharge-complete',
      targetId: 'local',
    };
    expect(shieldRechargeCueWasInterrupted(recharge, [
      recharge,
      { id: 11, time: 4.05, type: 'hit', targetId: 'local' },
    ])).toBe(true);
    expect(shieldRechargeCueWasInterrupted(recharge, [
      recharge,
      { id: 12, time: 4.2, type: 'hit', targetId: 'local' },
    ])).toBe(false);
  });

  it('falls back silently when browser speech synthesis is unavailable', () => {
    expect(new GameAudio().announce('Bandera enemiga capturada')).toBe('unavailable');
  });

  it('configures a restrained Spanish announcer voice when speech synthesis is available', () => {
    const speak = vi.fn();
    const cancel = vi.fn();
    const spanishVoice = { lang: 'es-ES', default: false } as SpeechSynthesisVoice;
    class FakeUtterance {
      public lang = '';
      public rate = 1;
      public pitch = 1;
      public volume = 1;
      public voice: SpeechSynthesisVoice | null = null;
      public constructor(public readonly text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('window', {
      speechSynthesis: {
        getVoices: () => [spanishVoice],
        speak,
        cancel,
      },
    });

    expect(new GameAudio().announce('  Bandera enemiga capturada  ', true)).toBe('spoken');
    expect(cancel).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledOnce();
    const utterance = speak.mock.calls[0]?.[0] as FakeUtterance;
    expect(utterance.text).toBe('Bandera enemiga capturada');
    expect(utterance.lang).toBe('es-ES');
    expect(utterance.rate).toBeLessThan(1);
    expect(utterance.pitch).toBeLessThan(1);
    expect(utterance.voice).toBe(spanishVoice);
  });

  it('reports a busy announcer so objective speech can be retried', () => {
    class FakeUtterance {
      public constructor(public readonly text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('window', {
      speechSynthesis: {
        speaking: true,
        pending: false,
        getVoices: () => [],
        speak: vi.fn(),
        cancel: vi.fn(),
      },
    });

    expect(new GameAudio().announce('Bandera perdida')).toBe('busy');
  });
});

describe('movement audio', () => {
  it('defines distinct short cues for jumping and landing', () => {
    expect(MOVEMENT_SOUND_PROFILE.jump.from).toBeLessThan(MOVEMENT_SOUND_PROFILE.jump.to);
    expect(MOVEMENT_SOUND_PROFILE.land.from).toBeGreaterThan(MOVEMENT_SOUND_PROFILE.land.to);
    expect(MOVEMENT_SOUND_PROFILE.jump.duration).toBeLessThan(0.3);
    expect(MOVEMENT_SOUND_PROFILE.land.duration).toBeLessThan(0.3);
  });

  it('is safe before browser audio has been unlocked', () => {
    const audio = new GameAudio();
    expect(() => audio.movement('jump')).not.toThrow();
    expect(() => audio.movement('land', 0.8)).not.toThrow();
  });
});
