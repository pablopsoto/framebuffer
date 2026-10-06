// 2023 — Gaussian splatting. No triangles at all: the scene is a cloud of soft, coloured,
// oriented blobs, sorted back to front every frame and blended. Lighting is baked in, the
// way a splat capture records it.
import {
  BufferAttribute,
  CustomBlending,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderTarget,
} from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { SHIP_TRIANGLES } from '../ship';
import { normalAt } from '../terrain';
import { albedo, GLSL_WORLD, height, pathX, PERIOD, SUN, WATER } from '../world';

const ROW = 1024;

interface Cloud {
  data: Float32Array; // 16 floats per splat: centre+opacity, covariance (6), pad, colour
  count: number;
}

const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const srgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const display = (c: number[]) => c.map((v) => srgb(aces(v * 1.15)));

function rng(seed: number) {
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

function shadowed(x: number, y: number, z: number) {
  for (let t = 0.6; t < 70; t += 0.5 + t * 0.06) {
    const px = x + SUN.x * t;
    const py = y + SUN.y * t;
    const pz = z + SUN.z * t;
    if (height(px, pz) > py) return true;
  }
  return false;
}

/** Push one splat: a flat ellipse in the plane with normal n. */
function push(out: number[], p: number[], n: number[], s1: number, s2: number, s3: number, color: number[], opacity: number, twist: number) {
  const nv = new Vector3(...n).normalize();
  const t = new Vector3(Math.cos(twist), 0, Math.sin(twist)).cross(nv).normalize();
  if (t.lengthSq() < 0.5) t.set(1, 0, 0);
  const b = new Vector3().crossVectors(nv, t).normalize();
  const cov = (i: number, j: number) =>
    s1 * s1 * t.getComponent(i) * t.getComponent(j) + s2 * s2 * b.getComponent(i) * b.getComponent(j) + s3 * s3 * nv.getComponent(i) * nv.getComponent(j);
  out.push(p[0], p[1], p[2], opacity, cov(0, 0), cov(0, 1), cov(0, 2), cov(1, 1), cov(1, 2), cov(2, 2), 0, 0, color[0], color[1], color[2], 1);
}

function terrainCloud(): Cloud {
  const out: number[] = [];
  const r = rng(11);
  const n = [0, 0, 0];
  const skyAmb = [0.55, 0.45, 0.5];
  const sun = [1 * 3.4, 0.72 * 3.4, 0.48 * 3.4];
  const add = (x: number, z: number, step: number) => {
    x += (r() - 0.5) * step;
    z += (r() - 0.5) * step;
    const y = height(x, z);
    normalAt(x, z, n);
    if (y < WATER) {
      // Water records what it reflected: the sky near the horizon.
      const c = display([0.02 + 0.35 * 0.8, 0.04 + 0.35 * 0.45, 0.05 + 0.35 * 0.35]);
      push(out, [x, WATER, z], [0, 1, 0], step * 0.8, step * 0.8, 0.02, c, 0.95, r() * 6.28);
      return;
    }
    const a = albedo(x, z, y, 1 - n[1]);
    const ndl = Math.max(0, n[0] * SUN.x + n[1] * SUN.y + n[2] * SUN.z);
    const lit = ndl > 0 && !shadowed(x, y + 0.05, z) ? ndl / Math.PI : 0;
    const amb = 0.45 + 0.35 * n[1];
    const c = display(a.map((v, i) => v * (skyAmb[i] * amb + sun[i] * lit) * (0.92 + r() * 0.16)));
    const s = step * (0.5 + r() * 0.25);
    push(out, [x, y, z], n, s * (1 + r() * 0.6), s, step * 0.12, c, 0.92, r() * 6.28);
  };
  for (let z = 0; z < PERIOD; z += 0.7) {
    const mid = pathX(z);
    for (let x = mid - 46; x < mid + 46; x += 0.7) add(x, z, 0.7);
  }
  for (let z = 0; z < PERIOD; z += 1.5) {
    const mid = pathX(z);
    for (let x = mid - 120; x < mid + 120; x += 1.5) if (Math.abs(x - mid) >= 46) add(x, z, 1.5);
  }
  return shuffle(new Float32Array(out), r);
}

function shipCloud(): Cloud {
  const out: number[] = [];
  const r = rng(5);
  const areas = SHIP_TRIANGLES.map((t) => new Vector3().subVectors(t.b, t.a).cross(new Vector3().subVectors(t.c, t.a)).length() / 2);
  const total = areas.reduce((a, b) => a + b, 0);
  SHIP_TRIANGLES.forEach((t, k) => {
    const count = Math.ceil((areas[k] / total) * 6000);
    const n = t.normal;
    const ndl = Math.max(0, n.dot(SUN));
    for (let i = 0; i < count; i++) {
      let u = r();
      let v = r();
      if (u + v > 1) [u, v] = [1 - u, 1 - v];
      const p = t.a.clone().addScaledVector(new Vector3().subVectors(t.b, t.a), u).addScaledVector(new Vector3().subVectors(t.c, t.a), v);
      let c: number[];
      if (t.part === 2) c = display([4, 1.7, 0.6]);
      else if (t.part === 1) c = display([0.05 + 0.3 * (1 - n.y), 0.08 + 0.25 * (1 - n.y), 0.14 + 0.2 * n.y]);
      else c = display([0.78, 0.77, 0.75].map((a, j) => a * ([0.5, 0.42, 0.45][j] * (0.6 + 0.4 * n.y) + [3.4, 2.45, 1.63][j] * (ndl / Math.PI) + 0.4 * Math.pow(Math.max(0, n.y), 4))));
      push(out, [p.x, p.y, p.z], [n.x, n.y, n.z], 0.06, 0.05, 0.004, c, 0.95, r() * 6.28);
    }
  });
  return shuffle(new Float32Array(out), r);
}

function shuffle(data: Float32Array, r: () => number): Cloud {
  const count = data.length / 16;
  const tmp = new Float32Array(16);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    tmp.set(data.subarray(i * 16, i * 16 + 16));
    data.copyWithin(i * 16, j * 16, j * 16 + 16);
    data.set(tmp, j * 16);
  }
  return { data, count };
}

const VERTEX = /* glsl */ `
const float PERIOD = ${PERIOD.toFixed(1)};
attribute float aIndex;
uniform sampler2D tData;
uniform mat4 uModel;
uniform float uWrap;
uniform float uCamZ;
uniform float uFocal;
uniform vec2 uViewport;
uniform float uScale;
varying vec4 vColor;
varying vec2 vPos;
void main() {
  int i = int(aIndex);
  ivec2 base = ivec2((i % ${ROW}) * 4, i / ${ROW});
  vec4 t0 = texelFetch(tData, base, 0);
  vec4 t1 = texelFetch(tData, base + ivec2(1, 0), 0);
  vec4 t2 = texelFetch(tData, base + ivec2(2, 0), 0);
  vec4 t3 = texelFetch(tData, base + ivec2(3, 0), 0);
  mat3 R = mat3(uModel);
  mat3 S = R * mat3(t1.x, t1.y, t1.z, t1.y, t1.w, t2.x, t1.z, t2.x, t2.y) * transpose(R) * (uScale * uScale);
  vec3 c = (uModel * vec4(t0.xyz, 1.0)).xyz;
  if (uWrap > 0.5) c.z = uCamZ + 30.0 - mod(uCamZ + 30.0 - c.z, PERIOD);
  vec4 cam = viewMatrix * vec4(c, 1.0);
  vec4 pos = projectionMatrix * cam;
  float clip = 1.3 * pos.w;
  if (cam.z > -0.2 || abs(pos.x) > clip || abs(pos.y) > clip) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  // Project the 3D Gaussian to a 2D one: Σ' = J W Σ Wᵀ Jᵀ.
  float z = cam.z;
  mat3 J = mat3(uFocal / -z, 0.0, 0.0, 0.0, uFocal / -z, 0.0, uFocal * cam.x / (z * z), uFocal * cam.y / (z * z), 0.0);
  mat3 T = J * mat3(viewMatrix);
  mat3 cov = T * S * transpose(T);
  float a = cov[0][0] + 0.3, b = cov[0][1], d = cov[1][1] + 0.3;
  float mid = 0.5 * (a + d);
  float rad = length(vec2(0.5 * (a - d), b));
  float l1 = mid + rad, l2 = max(mid - rad, 0.1);
  vec2 v1 = abs(b) < 1e-6 ? (a >= d ? vec2(1.0, 0.0) : vec2(0.0, 1.0)) : normalize(vec2(b, l1 - a));
  vec2 major = min(sqrt(2.0 * l1), 1024.0) * v1;
  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(-v1.y, v1.x);
  vPos = position.xy;
  gl_Position = vec4(pos.xy / pos.w + (position.x * major + position.y * minor) * 2.0 / uViewport, 0.0, 1.0);
  float fog = smoothstep(70.0, 210.0, -z);
  vColor = vec4(mix(t3.rgb, vec3(0.98, 0.72, 0.6), fog * 0.85), t0.w);
}
`;

const FRAGMENT = /* glsl */ `
varying vec4 vColor;
varying vec2 vPos;
void main() {
  float A = -dot(vPos, vPos);
  if (A < -4.0) discard;
  float B = exp(A) * vColor.a;
  gl_FragColor = vec4(vColor.rgb * B, B);
}
`;

const SKY = fullscreen(
  /* glsl */ `
  ${GLSL_WORLD}
  uniform mat4 uCamWorld;
  uniform vec2 uTanFov;
  varying vec2 vUv;
  void main() {
    vec3 d = normalize(mat3(uCamWorld) * normalize(vec3((vUv * 2.0 - 1.0) * uTanFov, -1.0)));
    vec3 c = skyColor(d, true) * 1.15;
    c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
    gl_FragColor = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
  }`,
  { uCamWorld: { value: new Matrix4() }, uTanFov: { value: [1, 1] }, uSun: { value: SUN } },
);

class SplatMesh {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly order: Float32Array;
  private readonly depth: Float32Array;
  private readonly keys: Uint16Array;
  private readonly counts = new Uint32Array(65536);
  private readonly pos: Float32Array;

  constructor(
    readonly cloud: Cloud,
    uniforms: Record<string, { value: unknown }>,
    wrap: boolean,
  ) {
    const rows = Math.ceil(cloud.count / ROW);
    const tex = new Float32Array(ROW * 4 * rows * 4);
    tex.set(cloud.data);
    const data = new DataTexture(tex, ROW * 4, rows, RGBAFormat, FloatType);
    data.needsUpdate = true;
    this.pos = new Float32Array(cloud.count * 3);
    for (let i = 0; i < cloud.count; i++) this.pos.set(cloud.data.subarray(i * 16, i * 16 + 3), i * 3);
    this.order = new Float32Array(cloud.count);
    this.depth = new Float32Array(cloud.count);
    this.keys = new Uint16Array(cloud.count);

    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aIndex', new InstancedBufferAttribute(this.order, 1));
    const material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { ...uniforms, tData: { value: data }, uModel: { value: new Matrix4() }, uWrap: { value: wrap ? 1 : 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
    });
    this.mesh = new Mesh(g, material);
    this.mesh.frustumCulled = false;
  }

  /** Back-to-front by view depth, a 16-bit counting sort over the first `count` splats. */
  sort(camera: PerspectiveCamera, model: Matrix4, count: number, wrapZ: number | null) {
    const v = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, model).elements;
    const p = this.pos;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < count; i++) {
      let z = p[i * 3 + 2];
      if (wrapZ !== null) z = wrapZ + 30 - ((((wrapZ + 30 - z) % PERIOD) + PERIOD) % PERIOD);
      const d = v[2] * p[i * 3] + v[6] * p[i * 3 + 1] + v[10] * z + v[14];
      this.depth[i] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
    const scale = 65535 / Math.max(1e-6, max - min);
    const counts = this.counts;
    counts.fill(0);
    for (let i = 0; i < count; i++) {
      const k = ((this.depth[i] - min) * scale) | 0; // most negative (farthest) first
      this.keys[i] = k;
      counts[k]++;
    }
    for (let i = 1; i < 65536; i++) counts[i] += counts[i - 1];
    for (let i = count - 1; i >= 0; i--) this.order[--counts[this.keys[i]]] = i;
    const attr = this.mesh.geometry.attributes.aIndex as InstancedBufferAttribute;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
    this.mesh.geometry.instanceCount = count;
    (this.mesh.material.uniforms.uModel.value as Matrix4).copy(model);
  }
}

export function createSplats(): Chapter {
  const params = { density: 1, scale: 1 };
  let e: Engine;
  let out: WebGLRenderTarget;
  let terrain: SplatMesh;
  let ship: SplatMesh;
  const scene = new Scene();
  const uniforms = {
    uCamZ: { value: 0 },
    uFocal: { value: 1 },
    uViewport: { value: new Vector2() },
    uScale: { value: 1 },
  };
  const identity = new Matrix4();

  return {
    id: 'splats',
    params,
    controls: [
      { type: 'range', key: 'density', label: 'Splats', min: 0.02, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      { type: 'range', key: 'scale', label: 'Splat size', min: 0.15, max: 2, step: 0.01, format: (v) => `${v.toFixed(2)}×` },
    ],
    status: () => (terrain ? `${Math.round((terrain.cloud.count + ship.cloud.count) * params.density).toLocaleString('en')} splats, sorted every frame` : ''),
    init(engine) {
      e = engine;
      out = e.target(1);
      terrain = new SplatMesh(terrainCloud(), uniforms, true);
      ship = new SplatMesh(shipCloud(), uniforms, false);
      ship.mesh.renderOrder = 1;
      scene.add(terrain.mesh, ship.mesh);
    },
    render(_e, region: Region) {
      const f = e.flight;
      const cam = f.camera;
      const ty = Math.tan((cam.fov * Math.PI) / 360);
      SKY.uniforms.uCamWorld.value.copy(cam.matrixWorld);
      SKY.uniforms.uTanFov.value = [ty * cam.aspect, ty];
      e.quad(SKY, out, region);

      uniforms.uCamZ.value = cam.position.z;
      uniforms.uFocal.value = out.height / (2 * ty);
      uniforms.uViewport.value.set(out.width, out.height);
      uniforms.uScale.value = params.scale;
      terrain.sort(cam, identity, Math.max(1, Math.round(terrain.cloud.count * params.density)), cam.position.z);
      ship.sort(cam, f.matrix, Math.max(1, Math.round(ship.cloud.count * params.density)), null);
      e.draw(scene, cam, out, region, false);
      return out.texture;
    },
  };
}
