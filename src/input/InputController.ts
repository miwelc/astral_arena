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
  private lookSensitivityScale = 1;

  public constructor(
    public readonly element: HTMLElement,
    private readonly onLockChange?: (locked: boolean) => void,
    private readonly onZoomStep?: (direction: -1 | 1) => void,
    /**
     * Notifies the network layer immediately when a digital combat control
     * changes. Periodic input snapshots alone can miss a click shorter than
     * their send interval.
     */
    private readonly onActionChange?: () => void,
  ) {
    element.tabIndex = 0;
    element.addEventListener('click', this.requestLock);
    element.addEventListener('contextmenu', this.preventDefault);
    document.addEventListener('keydown', this.handleKeyDown);
    document.addEventListener('keyup', this.handleKeyUp);
    document.addEventListener('mousedown', this.handleMouseDown);
    document.addEventListener('mouseup', this.handleMouseUp);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('wheel', this.handleWheel, { passive: false });
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

  public setLookSensitivityScale(scale: number): void {
    this.lookSensitivityScale = clamp(scale, 0.05, 1);
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
    let use = this.keys.has('KeyE');

    const gamepad = navigator.getGamepads?.()[0];
    if (gamepad) {
      const deadzone = (value: number): number => (Math.abs(value) < 0.14 ? 0 : value);
      moveX = clamp(moveX + deadzone(gamepad.axes[0] ?? 0), -1, 1);
      moveZ = clamp(moveZ - deadzone(gamepad.axes[1] ?? 0), -1, 1);
      this.yaw = wrapAngle(this.yaw - deadzone(gamepad.axes[2] ?? 0) * 0.045 * this.lookSensitivityScale);
      this.pitch = clamp(this.pitch - deadzone(gamepad.axes[3] ?? 0) * 0.035 * this.lookSensitivityScale, -1.48, 1.48);
      fire ||= (gamepad.buttons[7]?.value ?? 0) > 0.4;
      aim ||= (gamepad.buttons[6]?.value ?? 0) > 0.4;
      jump ||= gamepad.buttons[0]?.pressed ?? false;
      reload ||= gamepad.buttons[2]?.pressed ?? false;
      swap ||= gamepad.buttons[3]?.pressed ?? false;
      melee ||= gamepad.buttons[5]?.pressed ?? false;
      grenade ||= gamepad.buttons[4]?.pressed ?? false;
      use ||= gamepad.buttons[1]?.pressed ?? false;
    }

    return { sequence, moveX, moveZ, yaw: this.yaw, pitch: this.pitch, fire, aim, jump, reload, swap, melee, grenade, use };
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
    document.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    window.removeEventListener('blur', this.clear);
  }

  private requestLock = (): void => {
    if (!this.disposed && document.pointerLockElement !== this.element) void this.element.requestPointerLock();
  };

  private preventDefault = (event: Event): void => event.preventDefault();

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    const wasPressed = this.keys.has(event.code);
    this.keys.add(event.code);
    if (!wasPressed && this.isActionCode(event.code)) this.onActionChange?.();
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const wasPressed = this.keys.delete(event.code);
    if (wasPressed && this.isActionCode(event.code)) this.onActionChange?.();
  };

  private handleMouseDown = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.element) return;
    const key = event.button === 0 ? 'fire' : event.button === 2 ? 'aim' : event.button === 1 ? 'swap' : null;
    if (!key || this.buttons[key]) return;
    this.buttons[key] = true;
    this.onActionChange?.();
  };

  private handleMouseUp = (event: MouseEvent): void => {
    const key = event.button === 0 ? 'fire' : event.button === 2 ? 'aim' : event.button === 1 ? 'swap' : null;
    if (!key || !this.buttons[key]) return;
    this.buttons[key] = false;
    this.onActionChange?.();
  };

  private handleMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.element) return;
    this.yaw = wrapAngle(this.yaw - event.movementX * this.sensitivity * this.lookSensitivityScale);
    this.pitch = clamp(this.pitch - event.movementY * this.sensitivity * this.lookSensitivityScale, -1.48, 1.48);
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.element || event.deltaY === 0) return;
    event.preventDefault();
    this.onZoomStep?.(event.deltaY < 0 ? 1 : -1);
  };

  private handleLockChange = (): void => {
    this.onLockChange?.(document.pointerLockElement === this.element);
  };

  private isActionCode(code: string): boolean {
    return code === 'Space'
      || code === 'KeyR'
      || code === 'KeyQ'
      || code === 'Digit1'
      || code === 'Digit2'
      || code === 'KeyF'
      || code === 'KeyG'
      || code === 'KeyE';
  }

  private clear = (): void => {
    const hadInput = this.keys.size > 0
      || (Object.keys(this.buttons) as ButtonKey[]).some((key) => this.buttons[key]);
    this.keys.clear();
    for (const key of Object.keys(this.buttons) as ButtonKey[]) this.buttons[key] = false;
    // A background tab may suspend requestAnimationFrame immediately. Send the
    // neutral edge now so the host cannot retain movement or automatic fire.
    if (hadInput) this.onActionChange?.();
  };
}
