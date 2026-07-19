import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GameEvent, WeaponId } from '../game/types';
import { GameAudio, SHIELD_RECHARGE_SOUND_PROFILE, shieldRechargeCueWasInterrupted, WEAPON_SOUND_PROFILES } from './GameAudio';

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
