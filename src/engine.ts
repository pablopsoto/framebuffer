// The shared GPU stage: one WebGL2 canvas, a full-screen quad, render targets that follow
// the window size, and a compositor that lays each era's frame into its part of the screen.
import {
  Camera,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  NearestFilter,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector4,
  WebGLRenderer,
  WebGLRenderTarget,
  type Object3D,
  type RenderTargetOptions,
} from 'three';
import { createFlight, flightAt, type Flight } from './world';

/** Normalised screen rectangle, origin bottom-left. */
export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export const FULL: Region = { x0: 0, y0: 0, x1: 1, y1: 1 };

export type Control =
  | { type: 'range'; key: string; label: string; min: number; max: number; step: number; format?: (v: number) => string }
  | { type: 'choice'; key: string; label: string; options: { value: string; label: string }[] }
  | { type: 'toggle'; key: string; label: string };

export type Params = Record<string, number | string | boolean>;

export interface Chapter {
  readonly id: string;
  readonly params: Params;
  readonly controls: Control[];
  init(e: Engine): void;
  /** Draw this era's frame (at least the given region) and return it. */
  render(e: Engine, region: Region): Texture;
  /** Called with the drawing-buffer size whenever it changes. */
  resize?(width: number, height: number): void;
  /** Read-only status line under the controls, e.g. a sample count. */
  status?(): string;
}

export interface Layer {
  texture: Texture;
  region: Region;
  /** Draw the scan beam along the top edge (a transition between eras). */
  beam?: boolean;
  /** Hairline gaps at the left and right edges (the hero's strips). */
  gaps?: boolean;
}

interface Managed {
  target: WebGLRenderTarget;
  scale: number;
}

export const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export function fullscreen(fragmentShader: string, uniforms: Record<string, { value: unknown }> = {}, defines: Record<string, string | number> = {}) {
  return new ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false });
}

const LAYER = fullscreen(
  /* glsl */ `
  uniform sampler2D tMap;
  uniform vec2 uScreen;
  uniform vec4 uRect;
  uniform float uBeam;
  uniform float uGaps;
  uniform float uTime;
  void main() {
    vec2 uv = gl_FragCoord.xy / uScreen;
    vec3 c = texture2D(tMap, uv).rgb;
    if (uBeam > 0.5) {
      // The electron beam that redraws the frame in the next era.
      float d = uRect.w - gl_FragCoord.y;
      c += vec3(0.55, 0.85, 1.0) * (exp(-d / 1.5) * 1.2 + exp(-d / 24.0) * 0.18);
      c *= 1.0 - 0.25 * exp(-d / 60.0) * step(1.0, mod(gl_FragCoord.y, 3.0));
    }
    if (uGaps > 0.5) {
      float dx = min(gl_FragCoord.x - uRect.x, uRect.z - gl_FragCoord.x);
      c *= smoothstep(0.0, 1.5, dx);
    }
    gl_FragColor = vec4(c, 1.0);
  }`,
  {
    tMap: { value: null },
    uScreen: { value: new Vector2() },
    uRect: { value: new Vector4() },
    uBeam: { value: 0 },
    uGaps: { value: 0 },
    uTime: { value: 0 },
  },
);

export class Engine {
  readonly renderer: WebGLRenderer;
  readonly flight: Flight = createFlight();
  /** Drawing-buffer size in device pixels, after dynamic resolution. */
  width = 1;
  height = 1;
  time = 0;
  dt = 0;
  frame = 0;
  /** Freeze the flight (reduced motion, or a paused chapter). */
  frozen = false;
  /** Dynamic resolution: drops when frames run long, recovers when they don't. */
  quality = 1;

  private readonly quadScene = new Scene();
  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quadMesh = new Mesh(new PlaneGeometry(2, 2));
  private readonly managed: Managed[] = [];
  private readonly chapters = new Set<Chapter>();
  private readonly ready = new Set<Chapter>();
  private frameTimes: number[] = [];
  private lastDrop = -1e9;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    // Every era hands over display-ready colour; nothing is converted on the way out.
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  get aspect() {
    return this.width / this.height;
  }

  /** A render target sized as a fraction of the screen, resized with it. */
  target(scale = 1, options: RenderTargetOptions = {}) {
    const target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      ...options,
    });
    target.texture.colorSpace = NoColorSpace;
    this.managed.push({ target, scale });
    this.sizeTarget({ target, scale });
    return target;
  }

  /** A pixel-art render target: nearest filtering, sized by the chapter itself. */
  pixelTarget(options: RenderTargetOptions = {}) {
    const target = new WebGLRenderTarget(1, 1, { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, ...options });
    target.texture.colorSpace = NoColorSpace;
    return target;
  }

  /** Retro resolution: about `lines` scanlines tall, square pixels, the screen's aspect. */
  retroSize(lines: number) {
    const px = Math.max(1, this.height / lines);
    return { w: Math.max(1, Math.round(this.width / px)), h: Math.max(1, Math.round(this.height / px)) };
  }

  private sizeTarget({ target, scale }: Managed) {
    target.setSize(Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale)));
  }

  private bind(target: WebGLRenderTarget | null, region?: Region) {
    const r = this.renderer;
    if (target) {
      const w = target.width;
      const h = target.height;
      if (region && region !== FULL) {
        const c = (v: number) => Math.min(1, Math.max(0, v));
        const x = Math.floor(c(region.x0) * w);
        const y = Math.floor(c(region.y0) * h);
        target.scissor.set(x, y, Math.ceil(c(region.x1) * w) - x, Math.ceil(c(region.y1) * h) - y);
        target.scissorTest = true;
      } else {
        target.scissor.set(0, 0, w, h);
        target.scissorTest = false;
      }
      target.viewport.set(0, 0, w, h);
    }
    r.setRenderTarget(target);
  }

  quad(material: ShaderMaterial, target: WebGLRenderTarget | null, region?: Region) {
    this.quadMesh.material = material;
    this.bind(target, region);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  draw(scene: Object3D, camera: Camera, target: WebGLRenderTarget, region?: Region, clear: boolean | 'depth' = true) {
    this.bind(target, region);
    if (clear === 'depth') this.renderer.clear(false, true, false);
    else if (clear) this.renderer.clear(true, true, true);
    this.renderer.render(scene, camera);
  }

  /** Chapters set themselves up the first time they're needed. */
  use(chapter: Chapter) {
    if (!this.ready.has(chapter)) {
      chapter.init(this);
      chapter.resize?.(this.width, this.height);
      this.ready.add(chapter);
    }
    this.chapters.add(chapter);
    return chapter;
  }

  resize() {
    const dpr = Math.min(devicePixelRatio, 2) * this.quality;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    for (const m of this.managed) this.sizeTarget(m);
    for (const c of this.ready) c.resize?.(w, h);
  }

  /** Advance the clock and the flight. */
  tick(now: number) {
    this.dt = this.frame ? Math.min(0.1, Math.max(0, now / 1000 - this.clock)) : 1 / 60;
    this.clock = now / 1000;
    if (!this.frozen) this.time += this.dt;
    this.frame++;
    flightAt(this.time, this.flight, this.aspect);
    this.adapt();
  }
  private clock = 0;

  private adapt() {
    this.frameTimes.push(this.dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 1 / 40 && this.quality > 0.5) {
      this.quality = Math.max(0.5, this.quality - 0.15);
      this.lastDrop = this.clock;
      this.resize();
    } else if (avg < 1 / 55 && this.quality < 1 && this.clock - this.lastDrop > 12) {
      this.quality = Math.min(1, this.quality + 0.1);
      this.resize();
    }
  }

  present(layers: Layer[]) {
    const r = this.renderer;
    const u = LAYER.uniforms;
    u.uScreen.value.set(this.width, this.height);
    u.uTime.value = this.time;
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, this.width, this.height);
    for (const l of layers) {
      const x = Math.round(l.region.x0 * this.width);
      const y = Math.round(l.region.y0 * this.height);
      const w = Math.round(l.region.x1 * this.width) - x;
      const h = Math.round(l.region.y1 * this.height) - y;
      if (w <= 0 || h <= 0) continue;
      u.tMap.value = l.texture;
      u.uRect.value.set(x, y, x + w, y + h);
      u.uBeam.value = l.beam ? 1 : 0;
      u.uGaps.value = l.gaps ? 1 : 0;
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      this.quadMesh.material = LAYER;
      r.render(this.quadScene, this.quadCam);
    }
    r.setScissorTest(false);
  }
}

export const isWebGL2 = () => {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
};
