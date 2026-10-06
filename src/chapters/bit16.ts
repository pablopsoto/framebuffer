// 1991 — 16-bit and Mode 7. The ground is one big flat bitmap; the SNES turns it with an
// affine matrix, and changing that matrix on every scanline fakes perspective.
import { Vector3, type WebGLRenderTarget } from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { GLSL_WORLD, SUN } from '../world';

const SHADER = /* glsl */ `
${GLSL_WORLD}
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uCam;
uniform float uYaw;
uniform float uAlt;
uniform float uPersp;
uniform float uBank;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec3 q15(vec3 c) { return floor(clamp(c, 0.0, 1.0) * 31.0 + 0.5) / 31.0; }

// The Mode 7 map: the valley seen from above, painted with a few shades per material.
vec3 mapColor(vec2 w) {
  vec2 q = floor(w * 2.0) / 2.0 + 0.25;
  float h = height(q.x, q.y);
  float hx = height(q.x + 0.5, q.y) - height(q.x - 0.5, q.y);
  float hz = height(q.x, q.y + 0.5) - height(q.x, q.y - 0.5);
  vec3 n = normalize(vec3(-hx, 1.0, -hz));
  float shade = floor(clamp(dot(n, uSun) * 1.6 + 0.35, 0.0, 1.0) * 3.0 + 0.5) / 3.0;
  float slope = 1.0 - n.y;
  vec3 c;
  if (h < WATER) {
    float wave = step(0.82, fract((q.x + q.y * 0.5) * 0.35 + uTime * 0.6 + hash(floor(q)) * 0.2));
    c = mix(vec3(0.12, 0.28, 0.6), vec3(0.55, 0.75, 1.0), wave * 0.6);
    return c;
  }
  if (h < WATER + 0.7) c = vec3(0.85, 0.74, 0.48);
  else if (h > 22.0 && slope < 0.5) c = vec3(0.95, 0.95, 1.0);
  else if (slope > 0.45 || h > 12.0) c = vec3(0.55, 0.42, 0.36);
  else {
    c = vec3(0.32, 0.6, 0.22);
    // Forests: trees dotted on a grid of tiles.
    vec2 cell = floor(q * 0.5);
    if (hash(cell) > 0.55 && length(fract(q * 0.5) - 0.5) < 0.35) c = vec3(0.12, 0.36, 0.16);
  }
  return c * (0.45 + 0.65 * shade);
}

vec3 shipSprite(vec2 s, out float a) {
  // Behind view, 32x18; tilted a step for each banking frame.
  float frame = uBank > 0.12 ? 1.0 : (uBank < -0.12 ? -1.0 : 0.0);
  s.y = floor(s.y + frame * s.x * 0.28);
  float ax = abs(s.x + 0.5);
  bool fin = ax < 1.0 && s.y >= 0.0 && s.y < 5.0;
  bool body = ax < 3.0 && s.y >= 3.0 && s.y < 13.0;
  bool wing = s.y >= 8.0 && s.y < 12.0 && ax < 4.0 + (s.y - 8.0) * 3.5;
  bool engine = s.y >= 12.0 && s.y < 14.0 && ax >= 2.0 && ax < 6.0;
  float fl = 2.0 + 2.0 * step(0.5, fract(uTime * 14.0));
  bool flame = s.y >= 14.0 && s.y < 14.0 + fl && ax >= 3.0 && ax < 5.0;
  a = 1.0;
  if (flame) return s.y < 15.0 ? vec3(1.0, 0.95, 0.6) : vec3(1.0, 0.5, 0.15);
  if (engine) return vec3(0.25, 0.25, 0.35);
  if (body && s.y < 6.0 && ax < 2.0) return vec3(0.4, 0.85, 1.0);
  if (fin || body) return vec3(0.82, 0.84, 0.9) * (s.y < 8.0 ? 1.0 : 0.85);
  if (wing) return s.y == 11.0 ? vec3(0.35, 0.36, 0.5) : vec3(0.65, 0.68, 0.8);
  a = 0.0;
  return vec3(0.0);
}

void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float W = uRes.x, H = uRes.y;
  float row = H - 1.0 - p.y; // scanline, from the top
  float hz = floor(H * 0.36);
  float focal = W * 0.62;
  vec2 fwd = vec2(sin(uYaw), -cos(uYaw));
  vec2 right = vec2(cos(uYaw), sin(uYaw));
  float sx = p.x - W * 0.5 + 0.5;
  vec3 col;

  if (uPersp < 0.5) {
    // One matrix for the whole screen: just the map, rotated and scaled.
    vec2 w = uCam + fwd * ((H * 0.5 - row) * 0.6 + 30.0) + right * sx * 0.6;
    col = mapColor(w);
  } else if (row > hz) {
    // A new scale per scanline: rows near the horizon are farther away.
    float dist = uAlt * focal / (row - hz);
    vec2 w = uCam + fwd * dist + right * sx * dist / focal;
    col = mapColor(w);
    col = mix(col, vec3(1.0, 0.62, 0.45), smoothstep(55.0, 170.0, dist)); // colour math haze
  } else {
    // HDMA: the backdrop colour is rewritten on every scanline.
    float k = row / hz;
    col = mix(vec3(0.13, 0.12, 0.38), vec3(1.0, 0.55, 0.38), pow(k, 1.6));
    // The sun, placed by its direction relative to the camera.
    float sunAz = atan(uSun.x, -uSun.z) - uYaw;
    sunAz = mod(sunAz + 3.14159, 6.28318) - 3.14159;
    if (abs(sunAz) < 1.4) {
      vec2 sp = vec2(W * 0.5 + tan(sunAz) * focal, hz - tan(asin(uSun.y)) * focal * 0.35);
      float d = length(vec2(p.x, row) - sp);
      col = mix(col, vec3(1.0, 0.92, 0.7), step(d, 9.0));
      col = mix(col, vec3(1.0, 0.75, 0.5), step(d, 12.0) * step(9.0, d) * 0.6);
    }
    // Two background layers scrolled at different rates: clouds, then mountains.
    float a = uYaw + atan(sx / focal);
    float cloud = sin(a * 9.0 + uTime * 0.05) + sin(a * 23.0 + 2.0) * 0.5;
    float band = hz * 0.35 + floor(cloud * 3.0);
    if (abs(row - band) < 2.0 + floor(cloud * 1.5) && cloud > 0.3) col = mix(col, vec3(1.0, 0.8, 0.75), 0.75);
    float above = hz - row;
    float far = 14.0 + 8.0 * sin(a * 3.0) + 5.0 * sin(a * 7.0 + 1.0) + 2.0 * sin(a * 19.0);
    if (above < far) col = above > far - 2.0 ? vec3(0.75, 0.5, 0.6) : vec3(0.38, 0.26, 0.42);
    float a2 = uYaw * 1.5 + atan(sx / focal) * 1.5;
    float near = 6.0 + 4.0 * sin(a2 * 5.0 + 2.0) + 2.0 * sin(a2 * 13.0);
    if (above < near) col = vec3(0.22, 0.3, 0.32);
  }

  if (uPersp > 0.5) {
    // Shadow under the ship, through colour math (half brightness).
    vec2 shadow = vec2(W * 0.5, floor(hz + (H - hz) * 0.82));
    vec2 sd = (vec2(p.x, row) - shadow) / vec2(12.0, 3.0);
    if (dot(sd, sd) < 1.0) col *= 0.5;
    float aSprite;
    vec3 sc = shipSprite(vec2(p.x - W * 0.5, row - floor(hz + (H - hz) * 0.42)), aSprite);
    // A one-pixel dark outline around the sprite.
    if (aSprite > 0.5) col = sc;
    else {
      float o = 0.0, t;
      shipSprite(vec2(p.x - W * 0.5 + 1.0, row - floor(hz + (H - hz) * 0.42)), t); o += t;
      shipSprite(vec2(p.x - W * 0.5 - 1.0, row - floor(hz + (H - hz) * 0.42)), t); o += t;
      shipSprite(vec2(p.x - W * 0.5, row + 1.0 - floor(hz + (H - hz) * 0.42)), t); o += t;
      shipSprite(vec2(p.x - W * 0.5, row - 1.0 - floor(hz + (H - hz) * 0.42)), t); o += t;
      if (o > 0.5) col = vec3(0.08, 0.06, 0.16);
    }
  }
  gl_FragColor = vec4(q15(col), 1.0);
}
`;

export function createBit16(): Chapter {
  const params = { yaw: 0, alt: 9, persp: true };
  let e: Engine;
  let out: WebGLRenderTarget;
  const mat = fullscreen(SHADER, {
    uRes: { value: [1, 1] },
    uTime: { value: 0 },
    uCam: { value: [0, 0] },
    uYaw: { value: 0 },
    uAlt: { value: 9 },
    uPersp: { value: 1 },
    uBank: { value: 0 },
    uSun: { value: SUN },
  });
  const dir = new Vector3();

  return {
    id: 'bit16',
    params,
    controls: [
      { type: 'range', key: 'yaw', label: 'Rotate the map', min: -180, max: 180, step: 1, format: (v) => `${v}°` },
      { type: 'range', key: 'alt', label: 'Camera height', min: 3, max: 40, step: 0.5 },
      { type: 'toggle', key: 'persp', label: 'Per-scanline scale' },
    ],
    init(engine) {
      e = engine;
      out = e.pixelTarget();
    },
    resize() {
      const { w, h } = e.retroSize(224);
      out.setSize(w, h);
      mat.uniforms.uRes.value = [w, h];
    },
    render(_e, region: Region) {
      const f = e.flight;
      f.camera.getWorldDirection(dir);
      const u = mat.uniforms;
      u.uTime.value = e.time;
      u.uCam.value = [f.camera.position.x, f.camera.position.z];
      u.uYaw.value = Math.atan2(dir.x, -dir.z) + (params.yaw * Math.PI) / 180;
      u.uAlt.value = params.alt;
      u.uPersp.value = params.persp ? 1 : 0;
      u.uBank.value = -f.rotation.z;
      e.quad(mat, out, region);
      return out.texture;
    },
  };
}
