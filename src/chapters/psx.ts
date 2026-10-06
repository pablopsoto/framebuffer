// 1996 — the first 3D consoles. 320x240, vertices snapped to whole pixels (the wobble),
// textures mapped without perspective correction (the warp), 15-bit colour with dither.
import {
  CanvasTexture,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderTarget,
} from 'three';
import type { Chapter, Engine, Region } from '../engine';
import { shipGeometry } from '../ship';
import { skyDome } from '../sky';
import { TerrainGrid } from '../terrain';
import { GLSL_WORLD, SUN, WATER } from '../world';

/** A tiny hand-made texture, drawn into a canvas pixel by pixel. */
function pixelTexture(size: number, paint: (x: number, y: number) => [number, number, number]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [r, g, b] = paint(x, y);
      img.data.set([r, g, b, 255], (y * size + x) * 4);
    }
  ctx.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.magFilter = t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}

const noise = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Ground: big stone slabs with dark seams, so the warping is easy to see.
const GROUND = pixelTexture(64, (x, y) => {
  const seam = x % 32 === 0 || y % 32 === 0 || (y % 32 === 16 && x % 16 === 0) ? 0.45 : 1;
  const v = (0.78 + noise(x, y) * 0.3) * seam;
  return [v * 255, v * 245, v * 230];
});
const HULL = pixelTexture(32, (x, y) => {
  const panel = x % 8 === 0 || y % 8 === 0 ? 0.7 : 1;
  const stripe = y > 12 && y < 16 ? [1, 0.35, 0.25] : [1, 1, 1];
  const v = (0.85 + noise(x, y) * 0.15) * panel;
  return [v * stripe[0] * 255, v * stripe[1] * 255, v * stripe[2] * 255];
});
const WATER_TEX = pixelTexture(32, (x, y) => {
  const wave = (x + Math.round(Math.sin(y * 0.6) * 2)) % 16 < 2 ? 1.6 : 1;
  return [40 * wave, 90 * wave, 150 * wave];
});

const VERTEX = /* glsl */ `
uniform vec2 uRes;
uniform float uSnap;
uniform vec3 uSun;
uniform vec3 uTint;
uniform vec3 uEmissive;
uniform vec2 uUvOffset;
varying vec2 vUv;
varying vec3 vUvw;
varying vec3 vShade;
varying float vFog;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 clip = projectionMatrix * viewMatrix * wp;
  if (uSnap > 0.5 && clip.w > 0.0) {
    // No sub-pixel precision: every vertex lands on a whole pixel.
    vec2 halfRes = uRes * 0.5;
    clip.xy = floor(clip.xy / clip.w * halfRes + 0.5) / halfRes * clip.w;
  }
  vec3 n = normalize(mat3(modelMatrix) * normal);
  #ifdef USE_COLOR
    vec3 base = pow(color, vec3(0.6));
  #else
    vec3 base = vec3(1.0);
  #endif
  // Gouraud: light is worked out per vertex and smeared across the triangle.
  float lam = max(dot(n, uSun), 0.0);
  vShade = base * uTint * (vec3(0.5, 0.45, 0.6) + vec3(1.15, 0.85, 0.6) * lam) + uEmissive;
  vFog = smoothstep(70.0, 175.0, length(wp.xyz - cameraPosition));
  vUv = uv + uUvOffset;
  vUvw = vec3(vUv * clip.w, clip.w);
  gl_Position = clip;
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float uAffine;
uniform float uDither;
uniform vec3 uFog;
varying vec2 vUv;
varying vec3 vUvw;
varying vec3 vShade;
varying float vFog;
void main() {
  // Interpolating uv*w and w perspective-correctly, then dividing, gives back plain
  // screen-space (affine) interpolation — what the PlayStation's GPU did.
  vec2 uv = uAffine > 0.5 ? vUvw.xy / vUvw.z : vUv;
  vec3 c = texture2D(map, uv).rgb * vShade;
  c = mix(c, uFog, vFog);
  if (uDither > 0.5) {
    int m[16] = int[16](-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2);
    ivec2 i = ivec2(mod(gl_FragCoord.xy, 4.0));
    c += float(m[i.y * 4 + i.x]) * 2.0 / 255.0;
  }
  gl_FragColor = vec4(floor(clamp(c, 0.0, 1.0) * 31.0) / 31.0, 1.0);
}
`;

const SKY = /* glsl */ `
${GLSL_WORLD}
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, false);
  c = pow(c / (1.0 + c) * 1.5, vec3(1.0 / 2.2));
  float s = dot(d, uSun);
  c = mix(c, vec3(1.0, 0.95, 0.75), step(0.9985, s));
  gl_FragColor = vec4(floor(clamp(c, 0.0, 1.0) * 31.0) / 31.0, 1.0);
}
`;

export function createPsx(): Chapter {
  const params = { snap: true, affine: true, dither: true };
  let e: Engine;
  let out: WebGLRenderTarget;
  let grid: TerrainGrid;
  let ship: Mesh;
  let water: Mesh;
  const scene = new Scene();
  const shared = {
    uRes: { value: new Vector2() },
    uSnap: { value: 1 },
    uAffine: { value: 1 },
    uDither: { value: 1 },
    uSun: { value: SUN },
    uFog: { value: new Vector3(0.95, 0.62, 0.46) },
  };
  const material = (map: CanvasTexture, tint: [number, number, number], emissive: [number, number, number] = [0, 0, 0], vertexColors = false) =>
    new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      vertexColors,
      uniforms: {
        ...shared,
        map: { value: map },
        uTint: { value: new Vector3(...tint) },
        uEmissive: { value: new Vector3(...emissive) },
        uUvOffset: { value: new Vector2() },
      },
    });

  return {
    id: 'psx',
    params,
    controls: [
      { type: 'toggle', key: 'snap', label: 'Vertex snapping' },
      { type: 'toggle', key: 'affine', label: 'Affine textures' },
      { type: 'toggle', key: 'dither', label: 'Dithering' },
    ],
    init(engine) {
      e = engine;
      out = e.pixelTarget({ depthBuffer: true });
      // Few, large triangles: a PlayStation scene had a few thousand per frame.
      grid = new TerrainGrid({ cell: 7, halfWidth: 77, ahead: 190, behind: 14, uvScale: 7, colors: true });
      const terrain = new Mesh(grid.geometry, material(GROUND, [1.05, 1, 0.95], [0, 0, 0], true));
      terrain.frustumCulled = false;
      ship = new Mesh(shipGeometry(), [
        material(HULL, [0.9, 0.92, 1]),
        material(HULL, [0.25, 0.4, 0.75]),
        material(HULL, [0.3, 0.2, 0.15], [1, 0.55, 0.2]),
      ]);
      ship.matrixAutoUpdate = false;
      water = new Mesh(new PlaneGeometry(160, 230, 8, 12).rotateX(-Math.PI / 2), material(WATER_TEX, [1.1, 1.1, 1.2]));
      (water.geometry.attributes.uv.array as Float32Array).forEach((_, i, a) => (a[i] *= i % 2 ? 230 / 8 : 160 / 8));
      scene.add(skyDome(SKY), terrain, water, ship);
    },
    resize() {
      const { w, h } = e.retroSize(240);
      out.setSize(w, h);
      shared.uRes.value.set(w, h);
    },
    render(_e, region: Region) {
      const f = e.flight;
      grid.update(f.camera.position.x, f.camera.position.z);
      ship.matrix.copy(f.matrix);
      ship.matrixWorldNeedsUpdate = true;
      // The water plane moves with the camera in whole texture tiles, plus a slow drift.
      const step = 8;
      water.position.set(Math.round(f.camera.position.x / step) * step, WATER, Math.round(f.camera.position.z / step) * step - 95);
      ((water.material as ShaderMaterial).uniforms.uUvOffset.value as Vector2).set(
        water.position.x / step,
        -water.position.z / step + e.time * 0.15,
      );
      shared.uSnap.value = params.snap ? 1 : 0;
      shared.uAffine.value = params.affine ? 1 : 0;
      shared.uDither.value = params.dither ? 1 : 0;
      e.renderer.setClearColor(0x000000, 1);
      e.draw(scene, f.camera, out, region);
      return out.texture;
    },
  };
}
