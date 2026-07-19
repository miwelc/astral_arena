import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';

/**
 * Lightweight depth-of-field pass tuned for gameplay. It uses five taps
 * instead of the forty-one used by the stock bokeh pass, keeping the weapon
 * layer sharp while gently separating distant architecture and landscape.
 */
export class DepthFocusPass extends Pass {
  public focusDistance = 24;
  public aperture = 1.05;
  public maxBlurPixels = 1.85;

  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  public constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial({
      name: 'AstralArenaDepthFocus',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocusDistance: { value: this.focusDistance },
        uAperture: { value: this.aperture },
        uMaxBlurPixels: { value: this.maxBlurPixels },
        uHasDepth: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #include <packing>

        varying vec2 vUv;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform float uNear;
        uniform float uFar;
        uniform float uFocusDistance;
        uniform float uAperture;
        uniform float uMaxBlurPixels;
        uniform float uHasDepth;

        float viewDistanceAt(vec2 uv) {
          float depth = texture2D(tDepth, uv).x;
          return -perspectiveDepthToViewZ(depth, uNear, uFar);
        }

        void main() {
          vec4 center = texture2D(tDiffuse, vUv);
          if (uHasDepth < 0.5 || uMaxBlurPixels < 0.01) {
            gl_FragColor = center;
            return;
          }

          float distanceFromCamera = max(0.001, viewDistanceAt(vUv));
          float focusError = abs(distanceFromCamera - uFocusDistance) / max(1.0, uFocusDistance);
          float blurPixels = min(uMaxBlurPixels, focusError * uAperture);
          vec2 texel = blurPixels / max(uResolution, vec2(1.0));

          vec4 color = center * 0.40;
          color += texture2D(tDiffuse, vUv + vec2( 1.0,  0.0) * texel) * 0.15;
          color += texture2D(tDiffuse, vUv + vec2(-1.0,  0.0) * texel) * 0.15;
          color += texture2D(tDiffuse, vUv + vec2( 0.0,  1.0) * texel) * 0.15;
          color += texture2D(tDiffuse, vUv + vec2( 0.0, -1.0) * texel) * 0.15;
          gl_FragColor = color;
        }
      `,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  public override setSize(width: number, height: number): void {
    this.material.uniforms.uResolution!.value.set(width, height);
  }

  public override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.material.uniforms.tDiffuse!.value = readBuffer.texture;
    this.material.uniforms.tDepth!.value = readBuffer.depthTexture;
    this.material.uniforms.uFocusDistance!.value = this.focusDistance;
    this.material.uniforms.uAperture!.value = this.aperture;
    this.material.uniforms.uMaxBlurPixels!.value = this.maxBlurPixels;
    this.material.uniforms.uHasDepth!.value = readBuffer.depthTexture ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  public override dispose(): void {
    this.material.dispose();
    this.quad.dispose();
  }
}
