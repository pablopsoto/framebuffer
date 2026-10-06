// 1979 — vector displays. No pixels: the beam draws lines straight onto phosphor that
// glows and fades. Persistence is a feedback buffer; glow is a bloom of it.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
  type WebGLRenderTarget,
} from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { Bloom } from '../post';
import { shipGeometry } from '../ship';
import { TerrainGrid } from '../terrain';
import { raw } from '../color';
import { SUN } from '../world';

const PHOSPHORS: Record<string, string> = { green: '#6dffa0', white: '#dfe9ff', amber: '#ffb54a' };

const PERSIST = fullscreen(
  /* glsl */ `
  uniform sampler2D tPrev;
  uniform sampler2D tBeam;
  uniform float uDecay;
  varying vec2 vUv;
  void main() {
    // Phosphor doesn't get brighter than lit: the beam re-excites it, then it fades.
    gl_FragColor = vec4(max(texture2D(tPrev, vUv).rgb * uDecay, texture2D(tBeam, vUv).rgb), 1.0);
  }`,
  { tPrev: { value: null }, tBeam: { value: null }, uDecay: { value: 0.85 } },
);

const SCREEN = fullscreen(
  /* glsl */ `
  uniform sampler2D tPhosphor;
  uniform sampler2D tGlow;
  uniform vec3 uTint;
  uniform float uTime;
  uniform vec2 uRes;
  varying vec2 vUv;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    // A slightly curved tube.
    vec2 c = vUv * 2.0 - 1.0;
    c *= 1.0 + 0.035 * dot(c, c);
    vec2 uv = c * 0.5 + 0.5;
    float beam = texture2D(tPhosphor, uv).r;
    float glow = texture2D(tGlow, uv).r;
    vec3 col = uTint * (beam * 1.2 + glow * 0.9);
    col += uTint * 0.02 * smoothstep(1.2, 0.0, length(c)); // the faint glow of a powered tube
    col += (hash(vUv * uRes + uTime) - 0.5) * 0.025;
    col *= smoothstep(1.05, 0.98, max(abs(c.x), abs(c.y)));
    col = 1.0 - exp(-col * 1.4); // the phosphor saturates
    gl_FragColor = vec4(pow(col, vec3(0.9)), 1.0);
  }`,
  { tPhosphor: { value: null }, tGlow: { value: null }, uTint: { value: new Color() }, uTime: { value: 0 }, uRes: { value: [1, 1] } },
);

export function createVector(): Chapter {
  const params = { decay: 0.86, phosphor: 'green', hidden: true };
  let e: Engine;
  let scene: Scene;
  let grid: TerrainGrid;
  let wire: LineSegments;
  let occluder: Mesh;
  let ship: LineSegments;
  let shipOccluder: Mesh;
  let beam: WebGLRenderTarget;
  let a: WebGLRenderTarget;
  let b: WebGLRenderTarget;
  let out: WebGLRenderTarget;
  let bloom: Bloom;
  const lineMat = new LineBasicMaterial({ color: '#ffffff', transparent: true, blending: AdditiveBlending, depthWrite: false });
  const occluderMat = new MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });

  /** Terrain as a vector monitor would draw it: rows across the valley, a few ribs along it. */
  function terrainLines() {
    const pos = grid.geometry.attributes.position.array as Float32Array;
    const { cols, rows } = grid;
    const v: number[] = [];
    const at = (i: number, j: number) => [pos[(j * cols + i) * 3], pos[(j * cols + i) * 3 + 1], pos[(j * cols + i) * 3 + 2]];
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols - 1; i++) v.push(...at(i, j), ...at(i + 1, j));
    for (let i = 1; i < cols; i += 2) for (let j = 0; j < rows - 1; j++) v.push(...at(i, j), ...at(i, j + 1));
    const g = wire.geometry;
    g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
    g.computeBoundingSphere();
  }

  /** Stars and a sun on a dome that travels with the camera. */
  function sky() {
    const v: number[] = [];
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 120; i++) {
      const az = rnd() * Math.PI * 2;
      const el = 0.08 + rnd() * 0.9;
      const p = new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).multiplyScalar(500);
      v.push(p.x, p.y, p.z, p.x + 0.9, p.y, p.z);
    }
    // The sun: a circle with the horizon lines of an 80s arcade cabinet.
    const c = SUN.clone().multiplyScalar(500);
    const right = new Vector3().crossVectors(SUN, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, SUN).normalize();
    const R = 30;
    for (let i = 0; i < 48; i++) {
      const a0 = (i / 48) * Math.PI * 2;
      const a1 = ((i + 1) / 48) * Math.PI * 2;
      const p0 = c.clone().addScaledVector(right, Math.cos(a0) * R).addScaledVector(up, Math.sin(a0) * R);
      const p1 = c.clone().addScaledVector(right, Math.cos(a1) * R).addScaledVector(up, Math.sin(a1) * R);
      v.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
    for (let k = 1; k < 6; k++) {
      const y = -R + k * k * 1.6;
      const w = Math.sqrt(R * R - y * y);
      const p0 = c.clone().addScaledVector(right, -w).addScaledVector(up, y);
      const p1 = c.clone().addScaledVector(right, w).addScaledVector(up, y);
      v.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(v), 3));
    const m = new LineSegments(g, lineMat);
    m.frustumCulled = false;
    return m;
  }

  let dome: LineSegments;

  return {
    id: 'vector',
    params,
    controls: [
      { type: 'range', key: 'decay', label: 'Phosphor decay', min: 0.5, max: 0.97, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      {
        type: 'choice',
        key: 'phosphor',
        label: 'Phosphor',
        options: [
          { value: 'green', label: 'P1 green' },
          { value: 'white', label: 'P4 white' },
          { value: 'amber', label: 'P3 amber' },
        ],
      },
      { type: 'toggle', key: 'hidden', label: 'Hidden-line removal' },
    ],

    init(engine) {
      e = engine;
      scene = new Scene();
      grid = new TerrainGrid({ cell: 6, halfWidth: 66, ahead: 186, behind: 12 });
      wire = new LineSegments(new BufferGeometry(), lineMat);
      wire.frustumCulled = false;
      occluder = new Mesh(grid.geometry, occluderMat);
      occluder.frustumCulled = false;
      const sg = shipGeometry();
      ship = new LineSegments(new EdgesGeometry(sg, 1), lineMat);
      shipOccluder = new Mesh(sg, occluderMat);
      ship.matrixAutoUpdate = shipOccluder.matrixAutoUpdate = false;
      dome = sky();
      scene.add(occluder, wire, shipOccluder, ship, dome);
      beam = e.target(0.5, { depthBuffer: true });
      a = e.target(0.5);
      b = e.target(0.5);
      out = e.target(1);
      bloom = new Bloom(e);
    },

    render(_e, region: Region) {
      const f = e.flight;
      if (grid.update(f.camera.position.x, f.camera.position.z)) terrainLines();
      ship.matrix.copy(f.matrix);
      ship.matrixWorldNeedsUpdate = true;
      shipOccluder.matrix.copy(f.matrix);
      shipOccluder.matrixWorldNeedsUpdate = true;
      dome.position.copy(f.camera.position);
      occluder.visible = shipOccluder.visible = params.hidden;
      // The beam is never perfectly steady.
      lineMat.opacity = 0.85 + 0.15 * Math.random();

      e.renderer.setClearColor(0x000000, 1);
      e.draw(scene, f.camera, beam, region);

      PERSIST.uniforms.tPrev.value = a.texture;
      PERSIST.uniforms.tBeam.value = beam.texture;
      PERSIST.uniforms.uDecay.value = Math.pow(params.decay, e.dt * 60);
      e.quad(PERSIST, b, region);
      [a, b] = [b, a];

      const glow = bloom.render(a.texture, region, 0.0);
      const s = SCREEN.uniforms;
      s.tPhosphor.value = a.texture;
      s.tGlow.value = glow;
      s.uTint.value.copy(raw(PHOSPHORS[params.phosphor]));
      s.uTime.value = e.time;
      s.uRes.value = [out.width, out.height];
      e.quad(SCREEN, out, region);
      return out.texture;
    },
  };
}
