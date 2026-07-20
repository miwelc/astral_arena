import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createForestGroundTextures,
  createOrbitalEnvironmentTexture,
  createTechnicalSurfaceTextures,
} from './visualTextures';

interface CapturedCanvas {
  width: number;
  height: number;
  pixels?: Uint8ClampedArray;
  getContext: (contextId: string) => CanvasRenderingContext2D | null;
}

const originalDocument = globalThis.document;

const installCanvasStub = (): void => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tagName: string): CapturedCanvas => {
        if (tagName !== 'canvas') throw new Error(`Unexpected element: ${tagName}`);
        const canvas: CapturedCanvas = {
          width: 0,
          height: 0,
          getContext: (contextId: string) => {
            if (contextId !== '2d') return null;
            return {
              createLinearGradient: () => ({ addColorStop: () => undefined }),
              createRadialGradient: () => ({ addColorStop: () => undefined }),
              createImageData: (width: number, height: number) => ({
                width,
                height,
                data: new Uint8ClampedArray(width * height * 4),
              }),
              fillRect: () => undefined,
              beginPath: () => undefined,
              arc: () => undefined,
              fill: () => undefined,
              putImageData: (imageData: ImageData) => {
                canvas.pixels = imageData.data;
              },
            } as unknown as CanvasRenderingContext2D;
          },
        };
        return canvas;
      },
    },
  });
};

const pixelsOf = (texture: THREE.CanvasTexture): Uint8ClampedArray => {
  const canvas = texture.image as CapturedCanvas;
  if (!canvas.pixels) throw new Error(`${texture.name} did not publish image data`);
  return canvas.pixels;
};

const byteHash = (pixels: Uint8ClampedArray): number => {
  let hash = 0x811c9dc5;
  for (const value of pixels) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

const channelRange = (pixels: Uint8ClampedArray, channel: number): [number, number] => {
  let minimum = 255;
  let maximum = 0;
  for (let offset = channel; offset < pixels.length; offset += 4) {
    minimum = Math.min(minimum, pixels[offset]!);
    maximum = Math.max(maximum, pixels[offset]!);
  }
  return [minimum, maximum];
};

beforeEach(installCanvasStub);

afterEach(() => {
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  } else {
    Reflect.deleteProperty(globalThis, 'document');
  }
});

describe('forest ground PBR texture set', () => {
  it('is deterministic, repeat-wrapped and uses the right colour spaces', () => {
    const first = createForestGroundTextures(128);
    const second = createForestGroundTextures(128);

    expect(byteHash(pixelsOf(first.albedo))).toBe(byteHash(pixelsOf(second.albedo)));
    expect(byteHash(pixelsOf(first.normal))).toBe(byteHash(pixelsOf(second.normal)));
    expect(byteHash(pixelsOf(first.roughness))).toBe(byteHash(pixelsOf(second.roughness)));

    for (const texture of Object.values(first)) {
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
      expect(texture.generateMipmaps).toBe(true);
      expect((texture.image as CapturedCanvas).width).toBe(128);
      expect((texture.image as CapturedCanvas).height).toBe(128);
    }
    expect(first.albedo.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(first.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(first.roughness.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('contains broad material variation and geometric microdetail', () => {
    const textures = createForestGroundTextures(128);
    const albedo = pixelsOf(textures.albedo);
    const normal = pixelsOf(textures.normal);
    const roughness = pixelsOf(textures.roughness);
    const [albedoMinimum, albedoMaximum] = channelRange(albedo, 1);
    const [normalXMinimum, normalXMaximum] = channelRange(normal, 0);
    const [normalYMinimum, normalYMaximum] = channelRange(normal, 1);
    const [roughnessMinimum, roughnessMaximum] = channelRange(roughness, 0);

    expect(albedoMaximum - albedoMinimum).toBeGreaterThan(60);
    expect(normalXMaximum - normalXMinimum).toBeGreaterThan(40);
    expect(normalYMaximum - normalYMinimum).toBeGreaterThan(40);
    expect(roughnessMinimum).toBeLessThan(120);
    expect(roughnessMaximum).toBeGreaterThan(230);
  });
});

describe('technical surface PBR texture set', () => {
  it('adds deterministic panel, fastener and abrasion microdetail', () => {
    const first = createTechnicalSurfaceTextures(128);
    const second = createTechnicalSurfaceTextures(128);
    const normal = pixelsOf(first.normal);
    const roughness = pixelsOf(first.roughness);
    const [normalMinimum, normalMaximum] = channelRange(normal, 0);
    const [roughnessMinimum, roughnessMaximum] = channelRange(roughness, 0);

    expect(byteHash(normal)).toBe(byteHash(pixelsOf(second.normal)));
    expect(byteHash(roughness)).toBe(byteHash(pixelsOf(second.roughness)));
    expect(normalMaximum - normalMinimum).toBeGreaterThan(35);
    expect(roughnessMaximum - roughnessMinimum).toBeGreaterThan(45);
    expect(first.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(first.roughness.colorSpace).toBe(THREE.NoColorSpace);
    expect(first.normal.wrapS).toBe(THREE.RepeatWrapping);
    expect(first.roughness.wrapT).toBe(THREE.RepeatWrapping);
  });
});

describe('orbital environment map', () => {
  it('creates a dark equirectangular reflection source with stable sampling settings', () => {
    const texture = createOrbitalEnvironmentTexture(256, 128);

    expect(texture.name).toBe('umbra-orbital-equirectangular-environment');
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(texture.generateMipmaps).toBe(false);
    expect((texture.image as CapturedCanvas).width).toBe(256);
    expect((texture.image as CapturedCanvas).height).toBe(128);
  });
});
