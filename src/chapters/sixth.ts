// 2004 — programmable shaders. Per-pixel lighting, normal maps, glossy reflections, fog
// and a generous helping of bloom; or, the other road of the era, cel shading with ink.
import {
  DepthTexture,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type WebGLRenderTarget,
} from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { Bloom, GLSL_TONEMAP } from '../post';
import { shipGeometry } from '../ship';
import { skyDome } from '../sky';
import { TerrainGrid } from '../terrain';
import { GLSL_WORLD, SUN, WATER } from '../world';

const shared = {
  uSun: { value: SUN },
  uTime: { value: 0 },
  uNormalMap: { value: 1 },
  uFog: { value: 1 },
  uCel: { value: 0 },
};

const VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  #ifdef USE_COLOR
    vColor = color;
  #else
    vColor = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAGMENT = /* glsl */ `
${GLSL_WORLD}
uniform float uTime, uNormalMap, uFog, uCel;
uniform vec3 uBase, uEmissive;
uniform float uSpec, uShine, uReflect, uKind; // kind: 0 ground, 1 ship, 2 water
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vec3 N = normalize(vNormal);
  vec2 p = vWorld.xz;
  if (uNormalMap > 0.5 && uKind == 2.0) {
    vec2 g = vec2(cos(p.x * 0.8 + uTime * 1.3) * 0.07 + cos(p.x * 2.3 - p.y * 1.3 + uTime * 2.1) * 0.05,
                  cos(p.y * 0.9 - uTime * 1.1) * 0.07 + cos(p.y * 2.9 + p.x * 0.7 + uTime * 1.7) * 0.05);
    N = normalize(vec3(-g.x, 1.0, -g.y));
  } else if (uNormalMap > 0.5 && uKind == 0.0) {
    // A tiling normal map stands in for detail the mesh doesn't have.
    vec2 g = vec2(cos(p.x * 1.9 + sin(p.y * 1.3)) * 0.25 + cos(p.x * 5.3 + p.y * 2.1) * 0.14,
                  cos(p.y * 2.1 + sin(p.x * 1.1)) * 0.25 + cos(p.y * 4.7 - p.x * 3.1) * 0.14);
    float rock = smoothstep(0.1, 0.4, 1.0 - N.y) * 0.8 + 0.25;
    N = normalize(N + vec3(-g.x, 0.0, -g.y) * rock);
  }
  vec3 V = normalize(cameraPosition - vWorld);
  float lam = max(dot(N, uSun), 0.0);
  if (uCel > 0.5) lam = lam < 0.12 ? 0.3 : (lam < 0.5 ? 0.65 : 1.0);
  vec3 base = uKind == 0.0 ? vColor : uBase;
  if (uCel > 0.5) base = mix(vec3(dot(base, vec3(0.33))), base, 1.6);
  vec3 ambient = mix(vec3(0.22, 0.15, 0.14), vec3(0.2, 0.26, 0.45), N.y * 0.5 + 0.5);
  vec3 c = base * (ambient + vec3(1.6, 1.12, 0.78) * lam);
  vec3 H = normalize(uSun + V);
  float s = pow(max(dot(N, H), 0.0), uShine) * uSpec * step(0.0, dot(N, uSun));
  if (uCel > 0.5) s = step(0.5, s) * 0.8;
  c += vec3(1.7, 1.3, 0.95) * s;
  if (uReflect > 0.0) {
    // A cube map in spirit: the sky, looked up in the reflected direction.
    vec3 R = reflect(-V, N);
    R.y = abs(R.y);
    float f = uReflect + (1.0 - uReflect) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    c = mix(c, skyColor(R, uKind == 2.0) * 0.9, uCel > 0.5 ? f * 0.4 : f);
  }
  c += uEmissive;
  if (uFog > 0.5) {
    float d = length(cameraPosition - vWorld);
    float f = (1.0 - exp(-d * 0.0055)) * exp(-max(vWorld.y, 0.0) * 0.015);
    vec3 fogColor = mix(vec3(0.55, 0.42, 0.5), vec3(1.3, 0.75, 0.45), pow(max(dot(-V, uSun), 0.0), 5.0));
    c = mix(c, fogColor, uCel > 0.5 ? f * 0.5 : f);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

const SKY = /* glsl */ `
${GLSL_WORLD}
uniform float uCel;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, true);
  if (uCel > 0.5) c = mix(vec3(0.35, 0.55, 0.95), vec3(1.0, 0.75, 0.55), smoothstep(0.35, 0.0, d.y)) + skyColor(d, true) * step(0.9995, dot(d, uSun));
  gl_FragColor = vec4(c, 1.0);
}
`;

const POST = fullscreen(
  /* glsl */ `
  ${GLSL_TONEMAP}
  uniform sampler2D tScene;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform float uBloom, uCel, uNear, uFar;
  uniform vec2 uTexel;
  varying vec2 vUv;
  float viewZ(vec2 uv) {
    float d = texture2D(tDepth, uv).r;
    return (uNear * uFar) / ((uFar - uNear) * d - uFar);
  }
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    if (uBloom > 0.5) c += texture2D(tBloom, vUv).rgb * 0.9;
    if (uCel > 0.5) {
      // Ink wherever the depth jumps: the outlines of cel-shaded games.
      float z = viewZ(vUv);
      float e = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(i == 0 ? 1.0 : (i == 1 ? -1.0 : 0.0), i == 2 ? 1.0 : (i == 3 ? -1.0 : 0.0)) * uTexel * 1.5;
        e = max(e, abs(viewZ(vUv + o) - z) / -z);
      }
      c = mix(c, vec3(0.05, 0.03, 0.08), smoothstep(0.03, 0.06, e));
    }
    // No tone mapping yet in 2004: brightness simply clips.
    gl_FragColor = vec4(srgb(c * 0.95), 1.0);
  }`,
  {
    tScene: { value: null },
    tBloom: { value: null },
    tDepth: { value: null },
    uBloom: { value: 1 },
    uCel: { value: 0 },
    uNear: { value: 0.3 },
    uFar: { value: 600 },
    uTexel: { value: new Vector2() },
  },
);

export function createSixth(): Chapter {
  const params = { look: 'real', normals: true, fog: true, bloom: true };
  let e: Engine;
  let hdr: WebGLRenderTarget;
  let out: WebGLRenderTarget;
  let bloom: Bloom;
  let grid: TerrainGrid;
  let ship: Mesh;
  let water: Mesh;
  let sky: Mesh;
  const scene = new Scene();
  const material = (kind: number, o: { base?: number[]; spec?: number; shine?: number; reflect?: number; emissive?: number[] } = {}) =>
    new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      vertexColors: kind === 0,
      uniforms: {
        ...shared,
        uKind: { value: kind },
        uBase: { value: new Vector3(...(o.base ?? [1, 1, 1])) },
        uSpec: { value: o.spec ?? 0.1 },
        uShine: { value: o.shine ?? 16 },
        uReflect: { value: o.reflect ?? 0 },
        uEmissive: { value: new Vector3(...(o.emissive ?? [0, 0, 0])) },
      },
    });

  return {
    id: 'sixth',
    params,
    controls: [
      {
        type: 'choice',
        key: 'look',
        label: 'Look',
        options: [
          { value: 'real', label: 'Per-pixel' },
          { value: 'cel', label: 'Cel-shaded' },
        ],
      },
      { type: 'toggle', key: 'normals', label: 'Normal maps' },
      { type: 'toggle', key: 'fog', label: 'Fog' },
      { type: 'toggle', key: 'bloom', label: 'Bloom' },
    ],
    init(engine) {
      e = engine;
      hdr = e.target(1, { depthBuffer: true, depthTexture: new DepthTexture(1, 1) });
      out = e.target(1);
      bloom = new Bloom(e);
      grid = new TerrainGrid({ cell: 2.5, halfWidth: 90, ahead: 240, behind: 12, colors: true });
      const terrain = new Mesh(grid.geometry, material(0, { spec: 0.15, shine: 12 }));
      terrain.frustumCulled = false;
      ship = new Mesh(shipGeometry(), [
        material(1, { base: [0.75, 0.77, 0.82], spec: 1.2, shine: 60, reflect: 0.25 }),
        material(1, { base: [0.05, 0.1, 0.2], spec: 3, shine: 200, reflect: 0.5 }),
        material(1, { base: [0.1, 0.08, 0.08], emissive: [4, 1.6, 0.5] }),
      ]);
      ship.matrixAutoUpdate = false;
      water = new Mesh(new PlaneGeometry(400, 400).rotateX(-Math.PI / 2), material(2, { base: [0.02, 0.05, 0.06], spec: 6, shine: 300, reflect: 0.05 }));
      sky = skyDome(SKY, { uCel: shared.uCel });
      scene.add(sky, terrain, water, ship);
    },
    render(_e, region: Region) {
      const f = e.flight;
      grid.update(f.camera.position.x, f.camera.position.z);
      ship.matrix.copy(f.matrix);
      ship.matrixWorldNeedsUpdate = true;
      water.position.set(f.camera.position.x, WATER, f.camera.position.z - 150);
      const cel = params.look === 'cel';
      shared.uTime.value = e.time;
      shared.uNormalMap.value = params.normals ? 1 : 0;
      shared.uFog.value = params.fog ? 1 : 0;
      shared.uCel.value = cel ? 1 : 0;
      e.renderer.setClearColor(0x000000, 1);
      e.draw(scene, f.camera, hdr, region);
      const glow = params.bloom ? bloom.render(hdr.texture, region, 1.0) : null;
      const u = POST.uniforms;
      u.tScene.value = hdr.texture;
      u.tBloom.value = glow;
      u.tDepth.value = hdr.depthTexture;
      u.uBloom.value = params.bloom ? 1 : 0;
      u.uCel.value = cel ? 1 : 0;
      u.uTexel.value.set(1 / hdr.width, 1 / hdr.height);
      e.quad(POST, out, region);
      return out.texture;
    },
  };
}
