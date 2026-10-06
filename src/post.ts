// Shared post-processing: a small bloom chain and the tone-mapping curves.
import { Vector2, type Texture, type WebGLRenderTarget } from 'three';
import { fullscreen, type Engine, type Region } from './engine';

export const GLSL_TONEMAP = /* glsl */ `
vec3 acesFilmic(vec3 c) {
  // Stephen Hill's fit of the ACES RRT + ODT, as used by three.js.
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = IN * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(OUT * (a / b), 0.0, 1.0);
}
vec3 agx(vec3 c) {
  // Troy Sobotka's AgX, minimal fit (Benjamin Wrensch).
  const mat3 IN = mat3(0.842479, 0.0423282, 0.0423756, 0.0784336, 0.878468, 0.0784336, 0.0792237, 0.0791661, 0.879142);
  const mat3 OUT = mat3(1.19688, -0.0528968, -0.0529716, -0.0980209, 1.15190, -0.0980435, -0.0990297, -0.0989612, 1.15107);
  c = IN * max(c, 1e-10);
  c = clamp((log2(c) + 12.47393) / 16.5, 0.0, 1.0);
  vec3 x2 = c * c, x4 = x2 * x2;
  c = 15.5 * x4 * x2 - 40.14 * x4 * c + 31.96 * x4 - 6.868 * x2 * c + 0.4298 * x2 + 0.1191 * c - 0.00232;
  c = OUT * c;
  return pow(max(c, 0.0), vec3(2.2)); // back to linear for the shared sRGB encode
}
vec3 srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

const BRIGHT = fullscreen(
  /* glsl */ `
  uniform sampler2D tMap;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tMap, vUv).rgb;
    float l = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 1.6 + 0.05, l), 1.0);
  }`,
  { tMap: { value: null }, uThreshold: { value: 1 } },
);

const BLUR = fullscreen(
  /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uDir;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tMap, vUv).rgb * 0.227027;
    c += (texture2D(tMap, vUv + uDir * 1.384615).rgb + texture2D(tMap, vUv - uDir * 1.384615).rgb) * 0.316216;
    c += (texture2D(tMap, vUv + uDir * 3.230769).rgb + texture2D(tMap, vUv - uDir * 3.230769).rgb) * 0.070270;
    gl_FragColor = vec4(c, 1.0);
  }`,
  { tMap: { value: null }, uDir: { value: new Vector2() } },
);

const ADD = fullscreen(
  /* glsl */ `
  uniform sampler2D tA;
  uniform sampler2D tB;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(tA, vUv).rgb + texture2D(tB, vUv).rgb, 1.0); }`,
  { tA: { value: null }, tB: { value: null } },
);

/** Bright pass, then two blurred levels (1/4 and 1/8 resolution) added together. */
export class Bloom {
  private readonly a4: WebGLRenderTarget;
  private readonly b4: WebGLRenderTarget;
  private readonly a8: WebGLRenderTarget;
  private readonly b8: WebGLRenderTarget;
  readonly output: WebGLRenderTarget;

  constructor(private readonly e: Engine) {
    this.a4 = e.target(0.25);
    this.b4 = e.target(0.25);
    this.a8 = e.target(0.125);
    this.b8 = e.target(0.125);
    this.output = e.target(0.25);
  }

  private blur(src: WebGLRenderTarget, tmp: WebGLRenderTarget, region: Region, radius: number) {
    BLUR.uniforms.tMap.value = src.texture;
    BLUR.uniforms.uDir.value.set(radius / src.width, 0);
    this.e.quad(BLUR, tmp, region);
    BLUR.uniforms.tMap.value = tmp.texture;
    BLUR.uniforms.uDir.value.set(0, radius / src.height);
    this.e.quad(BLUR, src, region);
  }

  render(input: Texture, region: Region, threshold = 1): Texture {
    // Blur reaches past the region's edges; widen it a little.
    const r = { x0: region.x0 - 0.04, y0: region.y0 - 0.04, x1: region.x1 + 0.04, y1: region.y1 + 0.04 };
    BRIGHT.uniforms.tMap.value = input;
    BRIGHT.uniforms.uThreshold.value = threshold;
    this.e.quad(BRIGHT, this.a4, r);
    this.blur(this.a4, this.b4, r, 1);
    this.blur(this.a4, this.b4, r, 2);
    BLUR.uniforms.tMap.value = this.a4.texture;
    BLUR.uniforms.uDir.value.set(0, 0);
    this.e.quad(BLUR, this.a8, r);
    this.blur(this.a8, this.b8, r, 1.5);
    this.blur(this.a8, this.b8, r, 3);
    ADD.uniforms.tA.value = this.a4.texture;
    ADD.uniforms.tB.value = this.a8.texture;
    this.e.quad(ADD, this.output, r);
    return this.output.texture;
  }
}
