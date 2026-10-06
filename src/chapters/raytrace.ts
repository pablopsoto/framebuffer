// 2018 — ray tracing. Every pixel follows light backwards: into the scene, towards the
// sun, and around a few bounces. One noisy sample per pixel per frame, accumulated over
// time; while moving, history is reprojected — the job real-time denoisers do.
import { Matrix4, Vector3, type WebGLRenderTarget } from 'three';
import { fullscreen, type Chapter, type Engine, type Region } from '../engine';
import { GLSL_TONEMAP } from '../post';
import { SHIP_TRIANGLES } from '../ship';
import { createFlight, flightAt, GLSL_ALBEDO, GLSL_WORLD, SUN, type Flight } from '../world';

const TRIS = SHIP_TRIANGLES.length;

const TRACE = fullscreen(
  /* glsl */ `
  ${GLSL_WORLD}
  ${GLSL_ALBEDO}
  uniform vec2 uRes;
  uniform float uFrame;
  uniform int uBounces;
  uniform float uTime;
  uniform vec3 uCamPos;
  uniform mat4 uCamWorld;
  uniform vec2 uTanFov;
  uniform vec3 uTri[${TRIS * 3}];
  uniform float uPart[${TRIS}];
  uniform vec3 uShipCenter;
  uniform mat4 uShipToPrev;
  uniform sampler2D tHistory;
  uniform mat4 uPrevViewProj;
  uniform vec3 uPrevCamPos;
  uniform float uAlpha;
  varying vec2 vUv;

  uint seed;
  uint pcg() {
    seed = seed * 747796405u + 2891336453u;
    uint w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
    return (w >> 22u) ^ w;
  }
  float rnd() { return float(pcg()) / 4294967295.0; }

  vec3 cosineDir(vec3 n) {
    float a = rnd() * 6.2831853, r = sqrt(rnd());
    vec3 t = normalize(abs(n.y) < 0.99 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0)));
    vec3 b = cross(n, t);
    return normalize(t * cos(a) * r + b * sin(a) * r + n * sqrt(1.0 - r * r));
  }

  // Heightfield: step by a fraction of the height above ground, then refine by bisection.
  float marchTerrain(vec3 ro, vec3 rd, float tmax, int steps) {
    float t = 0.05, lt = 0.0;
    for (int i = 0; i < 200; i++) {
      if (i >= steps || t > tmax) return -1.0;
      vec3 p = ro + rd * t;
      float h = p.y - height(p.x, p.z);
      if (h < 0.0) {
        for (int j = 0; j < 6; j++) {
          float m = 0.5 * (lt + t);
          vec3 q = ro + rd * m;
          if (q.y - height(q.x, q.z) < 0.0) t = m; else lt = m;
        }
        return t;
      }
      lt = t;
      t += max(0.4 * h, 0.03 + 0.004 * t);
    }
    return -1.0;
  }

  float hitShip(vec3 ro, vec3 rd, out vec3 n, out float part) {
    vec3 oc = ro - uShipCenter;
    float b = dot(oc, rd), c = dot(oc, oc) - 7.0;
    if (b * b - c < 0.0) return -1.0;
    float best = 1e9;
    for (int i = 0; i < ${TRIS}; i++) {
      vec3 a = uTri[i * 3], e1 = uTri[i * 3 + 1] - a, e2 = uTri[i * 3 + 2] - a;
      vec3 pv = cross(rd, e2);
      float det = dot(e1, pv);
      if (abs(det) < 1e-7) continue;
      float inv = 1.0 / det;
      vec3 tv = ro - a;
      float u = dot(tv, pv) * inv;
      if (u < 0.0 || u > 1.0) continue;
      vec3 qv = cross(tv, e1);
      float v = dot(rd, qv) * inv;
      if (v < 0.0 || u + v > 1.0) continue;
      float t = dot(e2, qv) * inv;
      if (t > 1e-3 && t < best) {
        best = t;
        n = normalize(cross(e1, e2));
        part = uPart[i];
      }
    }
    return best < 1e9 ? best : -1.0;
  }

  // kind: 0 sky, 1 ground, 2 water, 3 hull, 4 canopy, 5 engine
  float trace(vec3 ro, vec3 rd, out vec3 n, out float kind) {
    float t = marchTerrain(ro, rd, 320.0, 200);
    kind = t > 0.0 ? 1.0 : 0.0;
    if (rd.y < 0.0) {
      float tw = (WATER - ro.y) / rd.y;
      if (tw > 0.0 && (t < 0.0 || tw < t)) {
        t = tw;
        kind = 2.0;
      }
    }
    vec3 sn; float part;
    float ts = hitShip(ro, rd, sn, part);
    if (ts > 0.0 && (t < 0.0 || ts < t)) {
      n = sn;
      kind = 3.0 + part;
      return ts;
    }
    if (kind == 1.0) {
      vec3 p = ro + rd * t;
      float e = 0.05;
      n = normalize(vec3(height(p.x - e, p.z) - height(p.x + e, p.z), 2.0 * e, height(p.x, p.z - e) - height(p.x, p.z + e)));
    } else if (kind == 2.0) {
      vec3 p = ro + rd * t;
      n = normalize(vec3(cos(p.x * 0.8 + uTime * 1.3) * 0.03, 1.0, cos(p.z * 0.9 - uTime * 1.1) * 0.03));
    }
    return t;
  }

  bool shadowed(vec3 ro, vec3 rd) {
    vec3 n; float part;
    if (hitShip(ro, rd, n, part) > 0.0) return true;
    return marchTerrain(ro, rd, 120.0, 90) > 0.0;
  }

  void main() {
    seed = uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(uFrame) * 26699u;
    vec2 jitter = vec2(rnd(), rnd()) - 0.5;
    vec2 ndc = ((gl_FragCoord.xy + jitter) / uRes) * 2.0 - 1.0;
    vec3 ro = uCamPos;
    vec3 rd = normalize(mat3(uCamWorld) * normalize(vec3(ndc * uTanFov, -1.0)));

    vec3 sunColor = vec3(1.0, 0.72, 0.48) * 3.4;
    vec3 L = vec3(0.0), T = vec3(1.0);
    vec3 first = ro + rd * 5000.0;
    float firstKind = 0.0;
    bool specular = true;
    for (int b = 0; b <= 4; b++) {
      if (b > uBounces) break;
      vec3 n; float kind;
      float t = trace(ro, rd, n, kind);
      if (kind == 0.0) {
        L += T * skyColor(rd, specular);
        break;
      }
      vec3 p = ro + rd * t;
      if (b == 0) { first = p; firstKind = kind; }
      if (kind == 5.0) { L += T * vec3(6.0, 2.6, 0.9); break; }
      if (dot(n, rd) > 0.0) n = -n;
      ro = p + n * 0.003;
      if (kind == 1.0) {
        // Diffuse: sample the sun directly, then bounce in a random direction.
        vec3 a = albedo(p, 1.0 - n.y);
        vec3 sd = normalize(uSun + (vec3(rnd(), rnd(), rnd()) - 0.5) * 0.04);
        float ndl = dot(n, sd);
        if (ndl > 0.0 && !shadowed(ro, sd)) L += T * a / 3.14159 * sunColor * ndl;
        rd = cosineDir(n);
        T *= a;
        specular = false;
      } else {
        // Mirror-like: water and canopy follow Fresnel, the hull is brushed metal.
        float cosi = max(dot(-rd, n), 0.0);
        if (kind == 3.0) {
          T *= vec3(0.78, 0.77, 0.75);
          rd = normalize(reflect(rd, n) + (vec3(rnd(), rnd(), rnd()) - 0.5) * 0.35);
          if (dot(rd, n) < 0.0) break;
        } else {
          float F = 0.02 + 0.98 * pow(1.0 - cosi, 5.0);
          T *= F;
          rd = reflect(rd, n);
        }
        specular = true;
      }
    }
    L = min(L, vec3(12.0)); // tame fireflies

    // Reproject: where was this surface last frame, and is the history there still it?
    vec3 prevP = firstKind >= 3.0 ? (uShipToPrev * vec4(first, 1.0)).xyz : first;
    vec4 clip = uPrevViewProj * vec4(prevP, 1.0);
    vec2 puv = clip.xy / clip.w * 0.5 + 0.5;
    vec4 hist = texture2D(tHistory, puv);
    float dist = length(prevP - uPrevCamPos);
    bool valid = clip.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))
      && abs(hist.a - dist) < 0.04 * dist + 0.1;
    float a = valid ? uAlpha : 1.0;
    gl_FragColor = vec4(mix(hist.rgb, L, a), length(first - uCamPos));
  }`,
  {
    uRes: { value: [1, 1] },
    uFrame: { value: 0 },
    uBounces: { value: 2 },
    uTime: { value: 0 },
    uSun: { value: SUN },
    uCamPos: { value: new Vector3() },
    uCamWorld: { value: new Matrix4() },
    uTanFov: { value: [1, 1] },
    uTri: { value: Array.from({ length: TRIS * 3 }, () => new Vector3()) },
    uPart: { value: SHIP_TRIANGLES.map((t) => t.part) },
    uShipCenter: { value: new Vector3() },
    uShipToPrev: { value: new Matrix4() },
    tHistory: { value: null },
    uPrevViewProj: { value: new Matrix4() },
    uPrevCamPos: { value: new Vector3() },
    uAlpha: { value: 1 },
  },
);

const DISPLAY = fullscreen(
  /* glsl */ `
  ${GLSL_TONEMAP}
  uniform sampler2D tMap;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(srgb(acesFilmic(texture2D(tMap, vUv).rgb * 1.15)), 1.0); }`,
  { tMap: { value: null } },
);

export function createRaytrace(): Chapter {
  const params = { bounces: 2, fly: true, accumulate: true };
  let e: Engine;
  let a: WebGLRenderTarget;
  let b: WebGLRenderTarget;
  let out: WebGLRenderTarget;
  const local: Flight = createFlight();
  let pausedAt = 0;
  let still = 0;
  const prevViewProj = new Matrix4();
  const prevCam = new Vector3();
  const prevShip = new Matrix4();
  const lastCamera = new Matrix4();
  const m = new Matrix4();

  return {
    id: 'raytrace',
    params,
    controls: [
      { type: 'range', key: 'bounces', label: 'Bounces', min: 0, max: 4, step: 1 },
      { type: 'toggle', key: 'fly', label: 'Fly' },
      { type: 'toggle', key: 'accumulate', label: 'Accumulate' },
    ],
    status: () => (params.accumulate ? (still > 0 ? `${still + 1} samples per pixel` : 'reprojecting history') : '1 sample per pixel'),
    init(engine) {
      e = engine;
      a = e.target(0.4);
      b = e.target(0.4);
      out = e.target(0.4);
    },
    render(_e, region: Region) {
      if (params.fly) pausedAt = e.time;
      const f = params.fly ? e.flight : flightAt(pausedAt, local, e.aspect);
      const cam = f.camera;
      const moved = !lastCamera.equals(cam.matrixWorld) || params.fly;
      still = moved ? 0 : still + 1;
      lastCamera.copy(cam.matrixWorld);

      const u = TRACE.uniforms;
      u.uRes.value = [a.width, a.height];
      u.uFrame.value = e.frame;
      u.uBounces.value = params.bounces;
      u.uTime.value = params.fly ? e.time : pausedAt;
      u.uCamPos.value.copy(cam.position);
      u.uCamWorld.value.copy(cam.matrixWorld);
      const ty = Math.tan((cam.fov * Math.PI) / 360);
      u.uTanFov.value = [ty * cam.aspect, ty];
      SHIP_TRIANGLES.forEach((t, i) => {
        u.uTri.value[i * 3].copy(t.a).applyMatrix4(f.matrix);
        u.uTri.value[i * 3 + 1].copy(t.b).applyMatrix4(f.matrix);
        u.uTri.value[i * 3 + 2].copy(t.c).applyMatrix4(f.matrix);
      });
      u.uShipCenter.value.set(0, 0.1, 0.2).applyMatrix4(f.matrix);
      u.uShipToPrev.value.copy(prevShip).multiply(m.copy(f.matrix).invert());
      u.tHistory.value = a.texture;
      u.uPrevViewProj.value.copy(prevViewProj);
      u.uPrevCamPos.value.copy(prevCam);
      u.uAlpha.value = !params.accumulate ? 1 : still > 0 ? 1 / (still + 1) : 0.2;
      e.quad(TRACE, b, region);
      [a, b] = [b, a];

      prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      prevCam.copy(cam.position);
      prevShip.copy(f.matrix);

      DISPLAY.uniforms.tMap.value = a.texture;
      e.quad(DISPLAY, out, region);
      return out.texture;
    },
  };
}
