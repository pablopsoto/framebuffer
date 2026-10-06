// The one scene every era renders: a ship flying down a river valley at sunset.
// The world repeats every PERIOD units along z, so the flight never ends and every
// renderer — meshes, ray marcher, splats — can agree on the same landscape.
import { Euler, Matrix4, PerspectiveCamera, Vector3 } from 'three';

export const PERIOD = 256;
const K = (Math.PI * 2) / PERIOD;
/** Units per second. */
export const SPEED = 13;
/** Direction towards the sun: low, ahead and to the left. */
export const SUN = new Vector3(-0.5, 0.26, -0.85).normalize();
export const WATER = -1.5;
export const FOV = 52;

export const pathX = (z: number) => 6 * Math.sin(2 * K * z) + 2.5 * Math.sin(5 * K * z + 1);

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function height(x: number, z: number) {
  const d = x - pathX(z);
  const valley = 36 * (1 - Math.exp(-(d * d) / 1000));
  let b = 3 * Math.sin(0.09 * x + 1.5 * Math.sin(3 * K * z)) * Math.sin(7 * K * z + 0.5 * Math.cos(0.07 * x));
  b += 1.2 * Math.sin(0.23 * x + 13 * K * z + 1.7) * Math.sin(22 * K * z - 0.17 * x);
  b += 0.45 * Math.sin(0.61 * x - 41 * K * z) * Math.sin(53 * K * z + 0.37 * x + 0.5);
  return valley + b * (0.35 + 1.4 * smoothstep(4, 34, Math.abs(d))) - 2;
}

/** The same landscape in GLSL, kept in step with the functions above. */
export const GLSL_WORLD = /* glsl */ `
const float PERIOD = ${PERIOD.toFixed(1)};
const float K = ${K.toFixed(8)};
const float WATER = ${WATER.toFixed(2)};
uniform vec3 uSun;
float pathX(float z) { return 6.0 * sin(2.0 * K * z) + 2.5 * sin(5.0 * K * z + 1.0); }
float height(float x, float z) {
  float d = x - pathX(z);
  float valley = 36.0 * (1.0 - exp(-(d * d) / 1000.0));
  float b = 3.0 * sin(0.09 * x + 1.5 * sin(3.0 * K * z)) * sin(7.0 * K * z + 0.5 * cos(0.07 * x));
  b += 1.2 * sin(0.23 * x + 13.0 * K * z + 1.7) * sin(22.0 * K * z - 0.17 * x);
  b += 0.45 * sin(0.61 * x - 41.0 * K * z) * sin(53.0 * K * z + 0.37 * x + 0.5);
  return valley + b * (0.35 + 1.4 * smoothstep(4.0, 34.0, abs(d))) - 2.0;
}
// Linear HDR sunset sky; the sun disc is optional so bounce rays don't count it twice.
vec3 skyColor(vec3 d, bool disc) {
  float h = max(d.y, 0.0);
  vec3 c = mix(vec3(1.05, 0.52, 0.30), vec3(0.09, 0.14, 0.32), pow(h, 0.42));
  float s = max(dot(d, uSun), 0.0);
  c += vec3(1.0, 0.55, 0.25) * pow(s, 6.0) * 0.55;
  if (disc) c += vec3(1.0, 0.8, 0.55) * smoothstep(0.9993, 0.9996, s) * 40.0;
  c = mix(c, vec3(0.35, 0.22, 0.2), smoothstep(0.0, -0.25, d.y));
  return c;
}
`;

/** Ground colour shared by the 3D eras: river sand, grass, rock, a dusting of snow. */
export function albedo(x: number, z: number, y: number, slope: number): [number, number, number] {
  const sand: [number, number, number] = [0.55, 0.47, 0.33];
  const grass: [number, number, number] = [0.2, 0.3, 0.1];
  const rock: [number, number, number] = [0.32, 0.27, 0.24];
  const snow: [number, number, number] = [0.85, 0.86, 0.9];
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t) as [number, number, number];
  let c = mix(sand, grass, smoothstep(WATER + 0.4, WATER + 1.4, y));
  c = mix(c, rock, smoothstep(0.35, 0.6, slope));
  c = mix(c, snow, smoothstep(22, 28, y + 3 * Math.sin(x * 0.3 + z * 0.2)) * (1 - smoothstep(0.55, 0.75, slope)));
  return c;
}

export const GLSL_ALBEDO = /* glsl */ `
vec3 albedo(vec3 p, float slope) {
  vec3 c = mix(vec3(0.55, 0.47, 0.33), vec3(0.2, 0.3, 0.1), smoothstep(WATER + 0.4, WATER + 1.4, p.y));
  c = mix(c, vec3(0.32, 0.27, 0.24), smoothstep(0.35, 0.6, slope));
  c = mix(c, vec3(0.85, 0.86, 0.9), smoothstep(22.0, 28.0, p.y + 3.0 * sin(p.x * 0.3 + p.z * 0.2)) * (1.0 - smoothstep(0.55, 0.75, slope)));
  return c;
}
`;

export interface Flight {
  t: number;
  ship: Vector3;
  rotation: Euler;
  matrix: Matrix4;
  camera: PerspectiveCamera;
}

/** Where the ship and the chase camera are at time t. */
export function flightAt(t: number, out: Flight, aspect: number) {
  out.t = t;
  const z = -((t * SPEED) % PERIOD);
  const x = pathX(z);
  const y = 4.2 + 0.45 * Math.sin(t * 1.1);
  // Heading follows the river; the ship banks into its bends.
  const slope = (pathX(z - 1) - pathX(z + 1)) / 2;
  const curve = pathX(z - 3) - 2 * pathX(z) + pathX(z + 3);
  out.ship.set(x, y, z);
  out.rotation.set(0.04 * Math.cos(t * 1.1), -Math.atan(slope), Math.max(-0.7, Math.min(0.7, -curve * 0.9)), 'YXZ');
  out.matrix.makeRotationFromEuler(out.rotation).setPosition(out.ship);

  // Chase camera: behind the ship along its heading, kept clear of the ground.
  const len = Math.hypot(slope, 1);
  const fx = slope / len;
  const fz = -1 / len;
  const cx = x - fx * 8.5;
  const cz = z - fz * 8.5;
  const cy = Math.max(y + 2.3, height(cx, cz) + 2);
  const cam = out.camera;
  cam.fov = FOV;
  cam.aspect = aspect;
  cam.near = 0.3;
  cam.far = 600;
  cam.position.set(cx, cy, cz);
  cam.up.set(0, 1, 0);
  cam.lookAt(x + fx * 14, y + 0.3, z + fz * 14);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return out;
}

export function createFlight(): Flight {
  return { t: 0, ship: new Vector3(), rotation: new Euler(), matrix: new Matrix4(), camera: new PerspectiveCamera() };
}
