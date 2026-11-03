// SPDX-License-Identifier: Apache-2.0
/**
 * The honeycomb's label map: which cell id each pixel of `celdas.png`
 * belongs to (red + green * 256, the id minus one is the cell index).
 *
 * The full `getImageData` of the 1813x977 map cost 70 ms on a 4x-throttled
 * phone, so the map is built in slices of at most `ID_SLICE_ROWS` rows per
 * task, yielding between slices; the pointer lookup stays -1 until the
 * last slice lands. Pure module: no DOM, so the unit tests drive it in
 * node with a synthetic label source.
 */

/** Rows decoded per task; the map lands slice by slice, never in one block. */
export const ID_SLICE_ROWS = 128;

/** Row slices of the decoded label image, whatever decoded it. */
export interface LabelRows {
  readonly width: number;
  readonly height: number;
  /** RGBA pixels for rows [y, y + count), row-major. */
  readRows(y: number, count: number): Uint8ClampedArray;
  /** Yield between slices; defaults to a macrotask (`setTimeout(0)`). */
  yieldBetweenSlices?(): Promise<void>;
}

export class CellIndex {
  readonly w: number;
  readonly h: number;
  readonly ids: Int32Array;
  /** Flips only after the last slice; the lookup gates on it. */
  ready = false;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.ids = new Int32Array(w * h);
  }

  /** The cell index at map pixel (ix, iy), or -1 outside the map. */
  at(ix: number, iy: number): number {
    if (ix < 0 || iy < 0 || ix >= this.w || iy >= this.h) return -1;
    return this.ids[iy * this.w + ix] - 1;
  }
}

/**
 * The pointer lookup behind mount's `cellAt`: -1 until the index is
 * ready (pointer input before that is ignored), the cell after.
 */
export function lookupCell(index: CellIndex | null, ix: number, iy: number): number {
  if (!index || !index.ready) return -1;
  return index.at(ix, iy);
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Fill the cell index slice by slice, yielding between slices so no
 * single task decodes more than `ID_SLICE_ROWS` rows. `onSlice` fires
 * after each slice lands (still unready); `ready` flips after the last.
 */
export async function loadCellIndex(
  source: LabelRows,
  onSlice?: (index: CellIndex, rowsDone: number) => void,
): Promise<CellIndex> {
  const index = new CellIndex(source.width, source.height);
  const w = source.width;
  for (let y = 0; y < source.height; y += ID_SLICE_ROWS) {
    const count = Math.min(ID_SLICE_ROWS, source.height - y);
    const px = source.readRows(y, count);
    for (let i = 0; i < w * count; i++) {
      index.ids[y * w + i] = px[i * 4] + px[i * 4 + 1] * 256;
    }
    onSlice?.(index, y + count);
    if (y + count < source.height) {
      if (source.yieldBetweenSlices) await source.yieldBetweenSlices();
      else await nextTask();
    }
  }
  index.ready = true;
  return index;
}
