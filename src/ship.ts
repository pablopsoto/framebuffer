// A low-poly delta-wing ship, built by hand so every era can draw the same craft.
// Nose points down -z, like the camera.
import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

const P = {
  N: [0, 0, -2.4],
  C: [0, 0.5, -0.3],
  T: [0, 0.32, 1.3],
  B: [0, -0.3, 0.1],
  LW: [-2.1, -0.05, 1.25],
  RW: [2.1, -0.05, 1.25],
  LR: [-0.55, 0, -0.5],
  RR: [0.55, 0, -0.5],
  LT: [-0.5, 0.05, 1.35],
  RT: [0.5, 0.05, 1.35],
  F: [0, 1.0, 1.55],
  FL: [-0.07, 0.42, 0.5],
  FR: [0.07, 0.42, 0.5],
  TL: [-0.07, 0.32, 1.3],
  TR: [0.07, 0.32, 1.3],
} as const;

type Name = keyof typeof P;
/** Material slots: 0 hull, 1 canopy, 2 engine. */
export type Part = 0 | 1 | 2;
const UP = [0, 1, 0];
const DOWN = [0, -1, 0];
const BACK = [0, 0, 1];

// [a, b, c, which way the face looks, material]
const FACES: [Name, Name, Name, readonly number[], Part][] = [
  ['N', 'C', 'LR', UP, 1],
  ['N', 'RR', 'C', UP, 1],
  ['C', 'LT', 'LR', UP, 0],
  ['C', 'RR', 'RT', UP, 0],
  ['C', 'T', 'LT', UP, 0],
  ['C', 'RT', 'T', UP, 0],
  ['LR', 'LT', 'LW', UP, 0],
  ['RR', 'RW', 'RT', UP, 0],
  ['N', 'LR', 'B', DOWN, 0],
  ['N', 'B', 'RR', DOWN, 0],
  ['LR', 'LW', 'B', DOWN, 0],
  ['RR', 'B', 'RW', DOWN, 0],
  ['B', 'LW', 'LT', DOWN, 0],
  ['B', 'RT', 'RW', DOWN, 0],
  ['B', 'LT', 'RT', DOWN, 2],
  ['LT', 'T', 'RT', BACK, 2],
  ['F', 'FL', 'TL', [-1, 0, 0], 0],
  ['F', 'TR', 'FR', [1, 0, 0], 0],
  ['F', 'FR', 'FL', [0, 0.3, -1], 0],
  ['F', 'TL', 'TR', BACK, 0],
];

export interface ShipTriangle {
  a: Vector3;
  b: Vector3;
  c: Vector3;
  normal: Vector3;
  part: Part;
}

/** Triangles wound so their normals face outwards. */
export const SHIP_TRIANGLES: ShipTriangle[] = FACES.map(([a, b, c, hint, part]) => {
  const va = new Vector3(...P[a]);
  let vb = new Vector3(...P[b]);
  let vc = new Vector3(...P[c]);
  const n = new Vector3().subVectors(vb, va).cross(new Vector3().subVectors(vc, va)).normalize();
  if (n.dot(new Vector3(...hint)) < 0) {
    [vb, vc] = [vc, vb];
    n.negate();
  }
  return { a: va, b: vb, c: vc, normal: n, part };
});

/**
 * Flat-shaded geometry with uvs (a planar projection from above) and one draw group
 * per material slot.
 */
export function shipGeometry() {
  const byPart = [0, 1, 2].map((p) => SHIP_TRIANGLES.filter((t) => t.part === p));
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const g = new BufferGeometry();
  let start = 0;
  byPart.forEach((tris, part) => {
    for (const t of tris) {
      for (const v of [t.a, t.b, t.c]) {
        pos.push(v.x, v.y, v.z);
        nor.push(t.normal.x, t.normal.y, t.normal.z);
        uv.push(v.x / 4.2 + 0.5, v.z / 4 + 0.6 + (t.normal.y < -0.5 ? 0.5 : 0));
      }
    }
    g.addGroup(start, tris.length * 3, part);
    start += tris.length * 3;
  });
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  return g;
}
