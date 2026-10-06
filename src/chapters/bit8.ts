// 1985 — 8-bit. Every pixel is a 2-bit index into a four-colour palette; the screen is
// tiles and a handful of sprites. Swapping the palette re-skins the whole frame at once.
import { DataTexture, RedFormat, UnsignedByteType, type WebGLRenderTarget } from 'three';
import { raw } from '../color';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';

const PALETTES = Object.fromEntries(
  Object.entries({
    nes: ['#000000', '#881400', '#e45c10', '#fce0a8'],
    gb: ['#0f380f', '#306230', '#8bac0f', '#c4cfa1'],
    c64: ['#000000', '#352879', '#6c5eb5', '#b8c76f'],
    cga: ['#000000', '#ff55ff', '#55ffff', '#ffffff'],
  }).map(([k, v]) => [k, v.map(raw)]),
);

// 0 transparent, 1–3 palette entries. Nose to the right.
const SHIP = `
................
....111.........
....1221........
....12221.......
..111222211.....
.1333222233311..
133333333333221.
1333333333333331
1222222222222211
.12222222222111.
..111222211.....
....12221.......
....1221........
....111.........
................
................`;

function spriteTexture(art: string) {
  const rows = art.trim().split('\n');
  const data = new Uint8Array(16 * 16);
  rows.forEach((row, y) => [...row].forEach((ch, x) => (data[(15 - y) * 16 + x] = ch === '.' ? 0 : Number(ch))));
  const t = new DataTexture(data, 16, 16, RedFormat, UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

const SHADER = /* glsl */ `
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uPal[4];
uniform sampler2D tShip;
uniform float uGrid;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float bayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i.y * 4 + i.x]) + 0.5) / 16.0;
}
// Mountains built from 45-degree slopes, the way they were drawn in tiles.
float peaks(float x, float period, float h) { return h - abs(mod(x, period) - period * 0.5); }

void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float W = uRes.x, H = uRes.y;
  float t = uTime;
  int idx = 0;

  // Sky: black at the top, dithered down through two palette entries to the horizon.
  float g = smoothstep(0.95, 0.3, p.y / H) * 2.0;
  idx = int(floor(g)) + (fract(g) > bayer(p) ? 1 : 0);
  if (idx == 0 && hash(p) > 0.993) idx = hash(p + floor(t * 2.0)) > 0.3 ? 2 : 3;

  // A striped sunset.
  vec2 sc = vec2(floor(W * 0.68), floor(H * 0.44));
  float r = floor(H * 0.17);
  vec2 d = p - sc;
  float dist = length(d);
  if (dist < r) {
    float k = (sc.y - p.y) / r; // 0 at the middle, 1 at the bottom
    bool gap = k > 0.0 && mod(p.y - sc.y, 6.0) < 1.0 + k * 4.0;
    idx = gap ? idx : 3;
  }

  // Far range scrolls slowly, nearer hills faster: parallax by raster split.
  float far = floor(H * 0.3) + max(peaks(p.x + floor(t * 6.0), 72.0, 26.0), peaks(p.x + floor(t * 6.0) + 31.0, 46.0, 15.0));
  if (p.y < far) idx = 1;
  float near = floor(H * 0.2) + max(peaks(p.x + floor(t * 18.0), 40.0, 12.0), peaks(p.x + floor(t * 18.0) + 17.0, 28.0, 7.0));
  if (p.y < near) idx = p.y > near - 1.0 ? 1 : 0;

  // Ground: a row of 8x8 tiles scrolling at full speed.
  float gy = floor(H * 0.12);
  if (p.y < gy) {
    vec2 q = vec2(p.x + floor(t * 48.0), p.y);
    if (p.y > gy - 3.0) idx = mod(q.x, 4.0) < 2.0 ? 3 : 2; // grass edge
    else {
      float row = floor(q.y / 4.0);
      float bx = mod(q.x + row * 4.0, 8.0);
      bool mortar = mod(q.y, 4.0) < 1.0 || bx < 1.0;
      idx = mortar ? 0 : (bx < 2.0 && mod(q.y, 4.0) > 2.0 ? 2 : 1);
    }
  }

  // Enemies: little saucers on sine paths.
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float ex = floor(W + 12.0 - mod(t * 38.0 + fk * (W + 24.0) / 3.0, W + 24.0));
    float ey = floor(H * (0.48 + 0.18 * sin(t * 1.6 + fk * 2.1)) + 20.0 * fk - 20.0);
    vec2 e = p - vec2(ex, ey);
    if (abs(e.x) < 6.0 && abs(e.y) < 3.0) {
      float body = abs(e.x) + abs(e.y) * 2.0;
      if (body < 7.0) idx = e.y > 0.0 ? 3 : (mod(e.x + floor(t * 8.0), 3.0) < 1.0 ? 3 : 1);
    }
  }

  // The player's ship and its bullets.
  vec2 ship = vec2(floor(W * 0.46), floor(H * 0.5 + 10.0 * sin(t * 1.5)));
  for (int k = 0; k < 4; k++) {
    float bx = ship.x + 16.0 + mod(t * 190.0 + float(k) * W * 0.3, W * 1.2);
    if (p.y == ship.y + 8.0 && p.x >= floor(bx) && p.x < floor(bx) + 5.0) idx = 3;
  }
  vec2 s = p - ship;
  if (s.x >= 0.0 && s.x < 16.0 && s.y >= 0.0 && s.y < 16.0) {
    int c = int(texelFetch(tShip, ivec2(s), 0).r * 255.0 + 0.5);
    if (c > 0) idx = c;
  }
  float flame = 3.0 + 3.0 * step(0.5, fract(t * 15.0));
  if (s.y >= 7.0 && s.y <= 8.0 && s.x < 0.0 && s.x >= -flame) idx = s.x > -2.0 ? 3 : 2;

  vec3 col = uPal[idx];
  if (uGrid > 0.5) {
    vec2 tq = mod(p, 8.0);
    if (tq.x < 1.0 || tq.y < 1.0) col = mix(col, vec3(1.0, 0.2, 0.4), 0.55);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export function createBit8(): Chapter {
  const params = { palette: 'nes', grid: false };
  let e: Engine;
  let out: WebGLRenderTarget;
  const mat = fullscreen(SHADER, {
    uRes: { value: [1, 1] },
    uTime: { value: 0 },
    uPal: { value: PALETTES.nes },
    tShip: { value: spriteTexture(SHIP) },
    uGrid: { value: 0 },
  });

  return {
    id: 'bit8',
    params,
    controls: [
      {
        type: 'choice',
        key: 'palette',
        label: 'Palette',
        options: [
          { value: 'nes', label: 'NES' },
          { value: 'gb', label: 'Game Boy' },
          { value: 'c64', label: 'C64' },
          { value: 'cga', label: 'CGA' },
        ],
      },
      { type: 'toggle', key: 'grid', label: 'Show 8×8 tiles' },
    ],
    init(engine) {
      e = engine;
      out = e.pixelTarget();
    },
    resize() {
      const { w, h } = e.retroSize(200);
      out.setSize(w, h);
      mat.uniforms.uRes.value = [w, h];
    },
    render(_e, region: Region) {
      mat.uniforms.uTime.value = e.time;
      mat.uniforms.uPal.value = PALETTES[params.palette];
      mat.uniforms.uGrid.value = params.grid ? 1 : 0;
      e.quad(mat, out, region);
      return out.texture;
    },
  };
}
