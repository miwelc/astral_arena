import type { GameEvent, WeaponId } from '../game/types';

type NoiseFilter = 'lowpass' | 'highpass' | 'bandpass';

interface NoiseLayer {
  duration: number;
  volume: number;
  filter: NoiseFilter;
  from: number;
  to: number;
  q: number;
  delay?: number;
}

interface ToneLayer {
  duration: number;
  volume: number;
  type: OscillatorType;
  from: number;
  to: number;
  delay?: number;
  detune?: number;
}

export interface WeaponSoundProfile {
  attack: NoiseLayer;
  body: ToneLayer;
  tail: NoiseLayer;
  mechanism: ToneLayer;
}

/** Public, immutable tuning data keeps every weapon audibly recognisable. */
export const WEAPON_SOUND_PROFILES: Readonly<Record<WeaponId, WeaponSoundProfile>> = {
  'pulse-rifle': {
    attack: { duration: 0.026, volume: 0.72, filter: 'highpass', from: 2400, to: 1250, q: 0.8 },
    body: { duration: 0.075, volume: 0.42, type: 'sawtooth', from: 205, to: 92 },
    tail: { duration: 0.11, volume: 0.17, filter: 'bandpass', from: 980, to: 430, q: 1.1, delay: 0.012 },
    mechanism: { duration: 0.023, volume: 0.12, type: 'square', from: 1680, to: 920, delay: 0.034 },
  },
  sidearm: {
    attack: { duration: 0.021, volume: 0.66, filter: 'highpass', from: 3100, to: 1700, q: 0.7 },
    body: { duration: 0.09, volume: 0.38, type: 'triangle', from: 330, to: 118 },
    tail: { duration: 0.14, volume: 0.14, filter: 'bandpass', from: 1350, to: 540, q: 1.4, delay: 0.008 },
    mechanism: { duration: 0.026, volume: 0.16, type: 'square', from: 2200, to: 1280, delay: 0.047 },
  },
  'battle-rifle': {
    attack: { duration: 0.032, volume: 0.8, filter: 'highpass', from: 2700, to: 1050, q: 0.75 },
    body: { duration: 0.105, volume: 0.52, type: 'sawtooth', from: 245, to: 72 },
    tail: { duration: 0.17, volume: 0.2, filter: 'bandpass', from: 1050, to: 350, q: 0.95, delay: 0.01 },
    mechanism: { duration: 0.029, volume: 0.15, type: 'square', from: 1780, to: 760, delay: 0.052 },
  },
  sniper: {
    attack: { duration: 0.052, volume: 1, filter: 'highpass', from: 3900, to: 1450, q: 0.65 },
    body: { duration: 0.185, volume: 0.7, type: 'sawtooth', from: 430, to: 64 },
    tail: { duration: 0.32, volume: 0.31, filter: 'bandpass', from: 1160, to: 260, q: 0.8, delay: 0.014 },
    mechanism: { duration: 0.044, volume: 0.2, type: 'square', from: 1420, to: 520, delay: 0.095 },
  },
  shotgun: {
    attack: { duration: 0.075, volume: 1, filter: 'highpass', from: 2300, to: 640, q: 0.55 },
    body: { duration: 0.165, volume: 0.78, type: 'sawtooth', from: 265, to: 43 },
    tail: { duration: 0.27, volume: 0.34, filter: 'lowpass', from: 1250, to: 210, q: 0.7, delay: 0.012 },
    mechanism: { duration: 0.055, volume: 0.24, type: 'square', from: 980, to: 330, delay: 0.12 },
  },
  'rocket-launcher': {
    attack: { duration: 0.12, volume: 0.88, filter: 'bandpass', from: 1450, to: 370, q: 0.72 },
    body: { duration: 0.29, volume: 0.72, type: 'sawtooth', from: 118, to: 34 },
    tail: { duration: 0.38, volume: 0.32, filter: 'lowpass', from: 920, to: 145, q: 0.65, delay: 0.025 },
    mechanism: { duration: 0.06, volume: 0.16, type: 'square', from: 720, to: 260, delay: 0.065 },
  },
};

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private seenEvent = 0;

  public async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.compressor = this.context.createDynamicsCompressor();
      this.master.gain.value = 0.2;
      this.compressor.threshold.value = -12;
      this.compressor.knee.value = 14;
      this.compressor.ratio.value = 7;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.16;
      this.master.connect(this.compressor).connect(this.context.destination);
      this.noiseBuffer = this.createNoiseBuffer(1.25);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  public beginSession(initialEventSequence = 0): void {
    this.seenEvent = Math.max(0, Math.trunc(initialEventSequence));
  }

  public consume(events: GameEvent[], localPlayerId: string | null): void {
    if (!this.context || !this.master) return;
    for (const event of events) {
      if (event.id <= this.seenEvent) continue;
      this.seenEvent = Math.max(this.seenEvent, event.id);
      const actorLocal = event.actorId === localPlayerId;
      const targetLocal = event.targetId === localPlayerId;
      const locallyRelevant = actorLocal || targetLocal;
      switch (event.type) {
        case 'shot':
          this.shot(event.weaponId ?? 'pulse-rifle', actorLocal ? 0.9 : 0.27);
          break;
        case 'hit': {
          const damageWeight = Math.min(1, Math.max(0.35, (event.amount ?? 18) / 38));
          if (actorLocal) this.hitMarker(0.16 + damageWeight * 0.08);
          if (locallyRelevant) this.bulletImpact(targetLocal ? 0.42 * damageWeight : 0.14);
          break;
        }
        case 'shield-break':
          if (locallyRelevant) this.shieldBreak(targetLocal ? 0.62 : 0.24);
          break;
        case 'kill':
          if (actorLocal) {
            this.tone(330, 330, 0.085, 'triangle', 0.3);
            this.tone(495, 495, 0.13, 'triangle', 0.27, 0.065);
          }
          break;
        case 'explosion':
          this.explosion(locallyRelevant ? 0.78 : 0.36);
          break;
        case 'pickup':
          if (actorLocal) {
            this.tone(310, 690, 0.17, 'sine', 0.22);
            this.tone(620, 880, 0.1, 'triangle', 0.1, 0.055);
          }
          break;
        case 'reload':
          if (actorLocal) this.reloadMechanism(event.weaponId);
          break;
        case 'flag':
        case 'score':
          this.tone(220, 660, 0.36, 'sawtooth', 0.22);
          this.tone(440, 880, 0.24, 'triangle', 0.1, 0.11);
          break;
        case 'melee':
          this.melee(locallyRelevant ? 0.42 : 0.16);
          break;
        default:
          break;
      }
    }
  }

  public uiConfirm(): void {
    void this.unlock().then(() => {
      this.tone(180, 420, 0.11, 'sine', 0.16);
      this.tone(360, 620, 0.075, 'triangle', 0.08, 0.04);
    });
  }

  public dispose(): void {
    this.master?.disconnect();
    this.compressor?.disconnect();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.compressor = null;
    this.noiseBuffer = null;
  }

  private shot(weapon: WeaponId, volume: number): void {
    const profile = WEAPON_SOUND_PROFILES[weapon];
    this.noise(profile.attack, volume);
    this.toneLayer(profile.body, volume);
    this.noise(profile.tail, volume);
    // Mechanical detail belongs to the weapon in the player's hands. Omitting
    // it remotely also keeps an eight-player automatic firefight inexpensive.
    if (volume > 0.5) this.toneLayer(profile.mechanism, volume);

    if (weapon === 'rocket-launcher') {
      this.noise(
        { duration: 0.18, volume: 0.2, filter: 'highpass', from: 3600, to: 850, q: 0.55, delay: 0.01 },
        volume,
      );
    } else if (weapon === 'sniper') {
      this.tone(1180, 410, 0.045, 'square', volume * 0.11, 0.004);
    }
  }

  private hitMarker(volume: number): void {
    this.tone(920, 720, 0.034, 'sine', volume);
    this.tone(1380, 1040, 0.025, 'triangle', volume * 0.48, 0.004);
  }

  private bulletImpact(volume: number): void {
    this.noise(
      { duration: 0.055, volume: 0.65, filter: 'highpass', from: 2900, to: 1050, q: 1.1 },
      volume,
    );
    this.tone(410, 145, 0.075, 'triangle', volume * 0.42);
  }

  private shieldBreak(volume: number): void {
    this.noise(
      { duration: 0.2, volume: 0.75, filter: 'highpass', from: 4200, to: 780, q: 0.9 },
      volume,
    );
    this.tone(940, 115, 0.24, 'sawtooth', volume * 0.65);
    this.tone(1460, 520, 0.12, 'square', volume * 0.21, 0.018, 7);
  }

  private explosion(volume: number): void {
    this.noise(
      { duration: 0.42, volume: 1, filter: 'lowpass', from: 1850, to: 105, q: 0.65 },
      volume,
    );
    this.noise(
      { duration: 0.095, volume: 0.55, filter: 'highpass', from: 3200, to: 720, q: 0.7 },
      volume,
    );
    this.tone(108, 31, 0.39, 'sawtooth', volume * 0.78);
  }

  private melee(volume: number): void {
    this.noise(
      { duration: 0.095, volume: 0.75, filter: 'bandpass', from: 1700, to: 420, q: 0.82 },
      volume,
    );
    this.tone(230, 82, 0.11, 'triangle', volume * 0.55, 0.014);
  }

  private reloadMechanism(weapon: WeaponId | undefined): void {
    const heavy = weapon === 'shotgun' || weapon === 'rocket-launcher';
    this.tone(heavy ? 620 : 980, heavy ? 260 : 430, 0.05, 'square', heavy ? 0.15 : 0.11);
    this.noise(
      {
        duration: heavy ? 0.075 : 0.045,
        volume: 0.38,
        filter: 'highpass',
        from: heavy ? 1650 : 2500,
        to: heavy ? 520 : 920,
        q: 1.3,
        delay: 0.045,
      },
      0.24,
    );
  }

  private toneLayer(layer: ToneLayer, scale: number): void {
    this.tone(
      layer.from,
      layer.to,
      layer.duration,
      layer.type,
      layer.volume * scale,
      layer.delay ?? 0,
      layer.detune ?? 0,
    );
  }

  private tone(
    from: number,
    to: number,
    duration: number,
    type: OscillatorType,
    volume: number,
    delay = 0,
    detune = 0,
  ): void {
    if (!this.context || !this.master || duration <= 0 || volume <= 0) return;
    const start = this.context.currentTime + Math.max(0, delay);
    const end = start + duration;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.detune.value = detune;
    oscillator.frequency.setValueAtTime(Math.max(1, from), start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), end);
    this.envelope(gain.gain, start, end, volume, Math.min(0.004, duration * 0.18));
    oscillator.connect(gain).connect(this.master);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(end + 0.008);
  }

  private noise(layer: NoiseLayer, scale: number): void {
    if (!this.context || !this.master || !this.noiseBuffer || layer.duration <= 0 || scale <= 0) return;
    const start = this.context.currentTime + Math.max(0, layer.delay ?? 0);
    const end = start + layer.duration;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const maxOffset = Math.max(0, this.noiseBuffer.duration - layer.duration - 0.002);
    const offset = maxOffset > 0 ? Math.random() * maxOffset : 0;
    source.buffer = this.noiseBuffer;
    filter.type = layer.filter;
    filter.Q.value = layer.q;
    filter.frequency.setValueAtTime(Math.max(20, layer.from), start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, layer.to), end);
    this.envelope(gain.gain, start, end, layer.volume * scale, Math.min(0.003, layer.duration * 0.12));
    source.connect(filter).connect(gain).connect(this.master);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    source.start(start, offset, Math.min(layer.duration + 0.004, this.noiseBuffer.duration - offset));
  }

  private envelope(
    parameter: AudioParam,
    start: number,
    end: number,
    volume: number,
    attack: number,
  ): void {
    parameter.setValueAtTime(0.0001, start);
    parameter.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + attack);
    parameter.exponentialRampToValueAtTime(0.0001, end);
  }

  private createNoiseBuffer(duration: number): AudioBuffer {
    if (!this.context) throw new Error('Audio context must exist before creating a noise buffer.');
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    // A tiny one-pole high-pass removes DC drift from the reusable buffer.
    let previous = 0;
    for (let index = 0; index < samples; index += 1) {
      const white = Math.random() * 2 - 1;
      data[index] = (white - previous * 0.985) * 0.5;
      previous = white;
    }
    return buffer;
  }
}
