// A patch of the valley that travels with the camera. Vertices are in world space and
// snap to the grid, so the patch only needs rebuilding when the camera crosses a cell.
import { BufferAttribute, BufferGeometry } from 'three';
import { albedo, height } from './world';

export interface GridOptions {
  cell: number;
  halfWidth: number;
  ahead: number;
  behind: number;
  /** World units per texture repeat. */
  uvScale?: number;
  colors?: boolean;
}

export function normalAt(x: number, z: number, out: number[] = [0, 0, 0]) {
  const e = 0.25;
  const dx = (height(x + e, z) - height(x - e, z)) / (2 * e);
  const dz = (height(x, z + e) - height(x, z - e)) / (2 * e);
  const l = Math.hypot(dx, 1, dz);
  out[0] = -dx / l;
  out[1] = 1 / l;
  out[2] = -dz / l;
  return out;
}

export class TerrainGrid {
  readonly geometry = new BufferGeometry();
  readonly cols: number;
  readonly rows: number;
  private key = '';
  /** Rows already computed, keyed by grid position: the patch slides, most rows survive. */
  private rowCache = new Map<string, Float32Array>();

  constructor(private readonly o: GridOptions) {
    this.cols = Math.ceil((o.halfWidth * 2) / o.cell) + 1;
    this.rows = Math.ceil((o.ahead + o.behind) / o.cell) + 1;
    const n = this.cols * this.rows;
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute('normal', new BufferAttribute(new Float32Array(n * 3), 3));
    this.geometry.setAttribute('uv', new BufferAttribute(new Float32Array(n * 2), 2));
    if (o.colors) this.geometry.setAttribute('color', new BufferAttribute(new Float32Array(n * 3), 3));
    const index: number[] = [];
    for (let j = 0; j < this.rows - 1; j++) {
      for (let i = 0; i < this.cols - 1; i++) {
        const a = j * this.cols + i;
        const b = a + 1;
        const c = a + this.cols;
        const d = c + 1;
        // Alternate the diagonal so the grid doesn't look combed.
        if ((i + j) % 2) index.push(a, b, c, b, d, c);
        else index.push(a, d, c, a, b, d);
      }
    }
    this.geometry.setIndex(index);
  }

  /** Re-centre on the camera; returns true when the vertices changed. */
  update(camX: number, camZ: number) {
    const { cell, halfWidth, behind, uvScale = 8 } = this.o;
    const bx = Math.round(camX / cell) * cell - halfWidth;
    const bz = Math.round(camZ / cell) * cell + behind;
    const key = `${bx},${bz}`;
    if (key === this.key) return false;
    this.key = key;
    const pos = this.geometry.attributes.position.array as Float32Array;
    const nor = this.geometry.attributes.normal.array as Float32Array;
    const uv = this.geometry.attributes.uv.array as Float32Array;
    const col = this.geometry.attributes.color?.array as Float32Array | undefined;
    const n = [0, 0, 0];
    const stride = 3 + 3 + 2 + (col ? 3 : 0);
    const cache = new Map<string, Float32Array>();
    for (let j = 0; j < this.rows; j++) {
      const z = bz - j * cell;
      const rowKey = `${bx},${z}`;
      let row = this.rowCache.get(rowKey);
      if (!row) {
        row = new Float32Array(this.cols * stride);
        for (let i = 0; i < this.cols; i++) {
          const x = bx + i * cell;
          const y = height(x, z);
          normalAt(x, z, n);
          row.set([x, y, z, n[0], n[1], n[2], x / uvScale, z / uvScale], i * stride);
          if (col) row.set(albedo(x, z, y, 1 - n[1]), i * stride + 8);
        }
      }
      cache.set(rowKey, row);
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        const o = i * stride;
        pos.set(row.subarray(o, o + 3), k * 3);
        nor.set(row.subarray(o + 3, o + 6), k * 3);
        uv.set(row.subarray(o + 6, o + 8), k * 2);
        if (col) col.set(row.subarray(o + 8, o + 11), k * 3);
      }
    }
    this.rowCache = cache;
    for (const a of Object.values(this.geometry.attributes)) a.needsUpdate = true;
    this.geometry.computeBoundingSphere();
    return true;
  }
}
