import { clamp, emptyInput, wrapAngle } from '../game/math';
import type { PlayerInput } from '../game/types';

type ButtonKey = 'fire' | 'aim' | 'jump' | 'reload' | 'swap' | 'melee' | 'grenade';

export class InputController {
  private readonly keys = new Set<string>();
  private readonly buttons: Record<ButtonKey, boolean> = {
    fire: false,
    aim: false,
    jump: false,
    reload: false,
    swap: false,
    melee: false,
    grenade: false,
  };
  private yaw = 0;
  private pitch = 0;
  private enabled = true;
  private disposed = false;
  private readonly sensitivity = 0.0021;

  public constructor(public readonly element: HTMLElement, private readonly onLockChange?: (locked: boolean) => void) {
    element.tabIndex = 0;
    element.addEventListener('click', this.requestLock);
    element.addEventListener('contextmenu', this.preventDefault);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    window.addEventListener('blur', this.clear);
  }

  public setAngles(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, -1.48, 1.48);
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  public sample(sequence: number): PlayerInput {
    if (!this.enabled) return { ...emptyInput(), sequence, yaw: this.yaw, pitch: this.pitch };
    let moveX = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    let moveZ = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    let fire = this.buttons.fire;
    let aim = this.buttons.aim;
    let jump = this.buttons.jump || this.keys.has('Space');
    let reload = this.buttons.reload || this.keys.has('KeyR');
    let swap = this.buttons.swap || this.keys.has('KeyQ') || this.keys.has('Digit1') || this.keys.has('Digit2');
    let melee = this.buttons.melee || this.keys.has('KeyF');
    let grenade = this.buttons.grenade || this.keys.has('KeyG');

    const gamepad = navigator.getGamepads?.()[0];
    if (gamepad) {
      const deadzone = (value: number): number => (Math.abs(value) < 0.14 ? 0 : value);
      moveX = clamp(moveX + deadzone(gamepad.axes[0] ?? 0), -1, 1);
      moveZ = clamp(moveZ - deadzone(gamepad.axes[1] ?? 0), -1, 1);
      this.yaw = wrapAngle(this.yaw - deadzone(gamepad.axes[2] ?? 0) * 0.045);
      this.pitch = clamp(this.pitch - deadzone(gamepad.axes[3] ?? 0) * 0.035, -1.48, 1.48);
      fire ||= (gamepad.buttons[7]?.value ?? 0) > 0.4;
      aim ||= (gamepad.buttons[6]?.value ?? 0) > 0.4;
      jump ||= gamepad.buttons[0]?.pressed ?? false;
      reload ||= gamepad.buttons[2]?.pressed ?? false;
      swap ||= gamepad.buttons[3]?.pressed ?? false;
      melee ||= gamepad.buttons[5]?.pressed ?? false;
      grenade ||= gamepad.buttons[4]?.pressed ?? false;
    }

    return { sequence, moveX, moveZ, yaw: this.yaw, pitch: this.pitch, fire, aim, jump, reload, swap, melee, grenade };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.element.removeEventListener('click', this.requestLock);
    this.element.removeEventListener('contextmenu', this.preventDefault);
    document.removeEventListener('keydown', this.handleKeyDown);
    document.removeEventListener('keyup', this.handleKeyUp);
    document.removeEventListener('mousedown', this.handleMouseDown);
    document.removeEventListener('mouseup', this.handleMouseUp);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    window.removeEventListener('blur', this.clear);
  }

  private requestLock = (): void => {
    if (!this.disposed && document.pointerLockElement !== this.element) void this.element.requestPointerLock();
  };

  private preventDefault = (event: Event): void => event.preventDefault();

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    this.keys.add(event.code);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.element) return;
    if (event.button === 0) this.buttons.fire = true;
    if (event.button === 2) this.buttons.aim = true;
    if (event.button === 1) this.buttons.swap = true;
  };

  private handleMouseUp = (event: MouseEvent): void => {
    if (event.button === 0) this.buttons.fire = false;
    if (event.button === 2) this.buttons.aim = false;
    if (event.button === 1) this.buttons.swap = false;
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.element) return;
    this.yaw = wrapAngle(this.yaw - event.movementX * this.sensitivity);
    this.pitch = clamp(this.pitch - event.movementY * this.sensitivity, -1.48, 1.48);
  };

  private handleLockChange = (): void => {
    this.onLockChange?.(document.pointerLockElement === this.element);
  };

  private clear = (): void => {
    this.keys.clear();
    for (const key of Object.keys(this.buttons) as ButtonKey[]) this.buttons[key] = false;
  };
}
