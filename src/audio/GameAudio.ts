import type { GameEvent, WeaponId } from '../game/types';

export class GameAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private seenEvent = 0;

  public async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.18;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  public beginSession(): void {
    this.seenEvent = 0;
  }

  public consume(events: GameEvent[], localPlayerId: string | null): void {
    if (!this.context || !this.master) return;
    for (const event of events) {
      if (event.id <= this.seenEvent) continue;
      this.seenEvent = Math.max(this.seenEvent, event.id);
      const local = event.actorId === localPlayerId || event.targetId === localPlayerId;
      switch (event.type) {
        case 'shot':
          this.shot(event.weaponId, local ? 0.9 : 0.32);
          break;
        case 'hit':
          if (event.actorId === localPlayerId) this.beep(560, 0.035, 'sine', 0.18);
          break;
        case 'shield-break':
          if (event.targetId === localPlayerId) this.sweep(780, 120, 0.22, 0.36);
          break;
        case 'kill':
          if (event.actorId === localPlayerId) {
            this.beep(330, 0.08, 'triangle', 0.35);
            window.setTimeout(() => this.beep(495, 0.12, 'triangle', 0.3), 60);
          }
          break;
        case 'explosion':
          this.noise(0.32, local ? 0.75 : 0.4);
          this.sweep(95, 35, 0.34, local ? 0.55 : 0.25);
          break;
        case 'pickup':
          if (event.actorId === localPlayerId) this.sweep(310, 680, 0.16, 0.25);
          break;
        case 'flag':
        case 'score':
          this.sweep(220, 660, 0.35, 0.28);
          break;
        case 'melee':
          this.noise(0.08, 0.35);
          break;
        default:
          break;
      }
    }
  }

  public uiConfirm(): void {
    void this.unlock().then(() => this.sweep(180, 420, 0.11, 0.18));
  }

  public dispose(): void {
    void this.context?.close();
    this.context = null;
    this.master = null;
  }

  private shot(weapon: WeaponId | undefined, volume: number): void {
    if (weapon === 'rocket-launcher') {
      this.noise(0.16, volume);
      this.sweep(130, 55, 0.22, volume);
      return;
    }
    if (weapon === 'sniper') {
      this.noise(0.09, volume * 0.7);
      this.sweep(380, 85, 0.12, volume);
      return;
    }
    if (weapon === 'shotgun') {
      this.noise(0.12, volume);
      this.sweep(190, 70, 0.11, volume * 0.8);
      return;
    }
    this.sweep(weapon === 'sidearm' ? 260 : 180, 95, weapon === 'sidearm' ? 0.07 : 0.045, volume * 0.5);
  }

  private beep(frequency: number, duration: number, type: OscillatorType, volume: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private sweep(from: number, to: number, duration: number, volume: number): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(from, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, to), now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  private noise(duration: number, volume: number): void {
    if (!this.context || !this.master) return;
    const samples = Math.ceil(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, samples, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < samples; index += 1) data[index] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    gain.gain.setValueAtTime(volume, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + duration);
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(this.master);
    source.start();
  }
}
