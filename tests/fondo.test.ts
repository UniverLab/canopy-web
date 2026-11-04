// SPDX-License-Identifier: Apache-2.0
/**
 * The honeycomb's lazy sprites and sliced label map: a cell's sprite is
 * built the first time a frame draws it (never all up front), and the
 * pointer lookup stays -1 until the last id slice lands. The modules
 * under test are pure (no DOM), so these run in node with stubs.
 */
import { describe, expect, it } from "vitest";
import {
  ID_SLICE_ROWS,
  loadCellIndex,
  lookupCell,
  type LabelRows,
} from "../packages/look/fondo/cell-map.js";
import {
  createSpriteStore,
  drawCells,
  writeCellPixels,
  type CellPainter,
} from "../packages/look/fondo/sprites.js";

const CELLS = [
  { x: 0, y: 0, w: 4, h: 4 },
  { x: 4, y: 0, w: 4, h: 4 },
  null,
  { x: 0, y: 4, w: 4, h: 4 },
  { x: 4, y: 4, w: 4, h: 4 },
];

/** A 2d-context stub recording which sprites each frame draws. */
function painter(drawn: number[]): CellPainter {
  return {
    globalAlpha: 1,
    drawImage(image: CanvasImageSource): void {
      drawn.push((image as unknown as { sprite: number }).sprite);
    },
  };
}

describe("lazy cell sprites", () => {
  it("builds only the cells drawn so far, then reuses them", () => {
    let builds = 0;
    const store = createSpriteStore(CELLS.length, (n) => {
      builds++;
      return CELLS[n] === null ? null : ({ sprite: n } as unknown as CanvasImageSource);
    });
    expect(store.built).toBe(0);

    const drawn: number[] = [];
    const ctx = painter(drawn);
    // Cell 1 sits below the 0.01 floor, 2 is a hole, 4 is dark.
    const vis = new Float32Array([0.5, 0.001, 0.9, 0.02, 0]);
    drawCells(ctx, store, CELLS, vis, 0.5);
    expect(drawn).toEqual([0, 3]);
    expect(store.built).toBe(2);
    expect(builds).toBe(2);

    // A second frame reuses the cached sprites: nothing new is built.
    drawCells(ctx, store, CELLS, vis, 0.5);
    expect(store.built).toBe(2);
    expect(builds).toBe(2);

    // Lighting one more cell builds exactly one more sprite, never all five.
    vis[4] = 0.4;
    drawCells(ctx, store, CELLS, vis, 0.5);
    expect(drawn).toEqual([0, 3, 0, 3, 0, 3, 4]);
    expect(store.built).toBe(3);
    expect(store.built).toBeLessThan(CELLS.length);
  });

  it("paints the same teal mask the eager builder painted", () => {
    // A 4x2 map: id 1 on the left of row 0, id 2 on the right, row 1 empty.
    const ids = new Int32Array([1, 1, 2, 2, 0, 0, 0, 0]);
    const data = new Uint8ClampedArray(4 * 2 * 4);
    writeCellPixels(data, { x: 0, y: 0, w: 4, h: 2 }, 4, ids, 1, 0x3f, 0xb8, 0xb0);
    const px = (x: number, y: number): number[] => [
      ...data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];
    // Only the two id-1 pixels are teal (#3fb8b0) and opaque; the rest
    // stays untouched, exactly as the old per-cell canvas did.
    expect(px(0, 0)).toEqual([63, 184, 176, 255]);
    expect(px(1, 0)).toEqual([63, 184, 176, 255]);
    expect(px(2, 0)).toEqual([0, 0, 0, 0]);
    expect(px(3, 0)).toEqual([0, 0, 0, 0]);
    expect(px(0, 1)).toEqual([0, 0, 0, 0]);
    expect(px(3, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe("sliced label map", () => {
  it("stays -1 until the last slice, then answers from the full map", async () => {
    expect(ID_SLICE_ROWS).toBe(128);
    // 300 rows: three slices (128, 128, 44) with a yield between each.
    const W = 8;
    const H = 300;
    const sizes: number[] = [];
    let yields = 0;
    const rows: LabelRows = {
      width: W,
      height: H,
      readRows(y, count): Uint8ClampedArray {
        sizes.push(count);
        const px = new Uint8ClampedArray(W * count * 4);
        for (let r = 0; r < count; r++) {
          for (let x = 0; x < W; x++) {
            const id = (y + r) * W + x + 1;
            const o = (r * W + x) * 4;
            px[o] = id & 0xff;
            px[o + 1] = (id >> 8) & 0xff;
            px[o + 2] = 0;
            px[o + 3] = 255;
          }
        }
        return px;
      },
      yieldBetweenSlices(): Promise<void> {
        yields++;
        return Promise.resolve();
      },
    };

    const slices: number[] = [];
    const index = await loadCellIndex(rows, (idx, rowsDone) => {
      slices.push(rowsDone);
      // Before the last slice the lookup is -1, even for mapped pixels.
      expect(idx.ready).toBe(false);
      expect(lookupCell(idx, 3, 0)).toBe(-1);
    });
    expect(sizes).toEqual([128, 128, 44]);
    expect(sizes.every((size) => size <= ID_SLICE_ROWS)).toBe(true);
    expect(slices).toEqual([128, 256, 300]);
    expect(yields).toBe(2);
    expect(index.ready).toBe(true);

    // Correct after: every pixel's id minus one, across slice boundaries.
    expect(lookupCell(index, 0, 0)).toBe(0);
    expect(lookupCell(index, 7, 127)).toBe(127 * W + 7);
    expect(lookupCell(index, 0, 128)).toBe(128 * W);
    expect(lookupCell(index, 3, 299)).toBe(299 * W + 3);
    expect(lookupCell(index, -1, 0)).toBe(-1);
    expect(lookupCell(index, W, 0)).toBe(-1);
    expect(lookupCell(index, 0, H)).toBe(-1);
    expect(lookupCell(null, 0, 0)).toBe(-1);
  });
});
