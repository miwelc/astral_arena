import type { Vec3 } from './types';

export const EPSILON = 0.00001;
export const TAU = Math.PI * 2;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const cloneVec3 = (value: Vec3): Vec3 => ({ ...value });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const subtract = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (value: Vec3, scalar: number): Vec3 => ({ x: value.x * scalar, y: value.y * scalar, z: value.z * scalar });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const lengthSquared = (value: Vec3): number => dot(value, value);
export const length = (value: Vec3): number => Math.sqrt(lengthSquared(value));
export const distanceSquared = (a: Vec3, b: Vec3): number => lengthSquared(subtract(a, b));
export const distance = (a: Vec3, b: Vec3): number => Math.sqrt(distanceSquared(a, b));
export const normalize = (value: Vec3): Vec3 => {
  const magnitude = length(value);
  return magnitude < EPSILON ? vec3() : scale(value, 1 / magnitude);
};
export const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
export const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;
export const lerpVec3 = (from: Vec3, to: Vec3, amount: number): Vec3 => ({
  x: lerp(from.x, to.x, amount),
  y: lerp(from.y, to.y, amount),
  z: lerp(from.z, to.z, amount),
});
export const wrapAngle = (angle: number): number => {
  let result = angle % TAU;
  if (result > Math.PI) result -= TAU;
  if (result < -Math.PI) result += TAU;
  return result;
};
export const lerpAngle = (from: number, to: number, amount: number): number => from + wrapAngle(to - from) * amount;
export const horizontalDistance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const directionFromAngles = (yaw: number, pitch: number): Vec3 => ({
  x: -Math.sin(yaw) * Math.cos(pitch),
  y: Math.sin(pitch),
  z: -Math.cos(yaw) * Math.cos(pitch),
});
export const yawTo = (from: Vec3, to: Vec3): number => Math.atan2(-(to.x - from.x), -(to.z - from.z));
export const pitchTo = (from: Vec3, to: Vec3): number => Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));

export const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const random01 = (state: { randomState: number }): number => {
  let x = state.randomState || 0x6d2b79f5;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  state.randomState = x >>> 0;
  return state.randomState / 0xffffffff;
};

export const randomRange = (state: { randomState: number }, min: number, max: number): number => min + (max - min) * random01(state);

export const emptyInput = (): import('./types').PlayerInput => ({
  sequence: 0,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  fire: false,
  aim: false,
  jump: false,
  reload: false,
  swap: false,
  melee: false,
  grenade: false,
  crouch: false,
  use: false,
});
