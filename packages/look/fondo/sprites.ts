// SPDX-License-Identifier: Apache-2.0
/**
 * The honeycomb's cell sprites: one small canvas per cell, teal where the
 * label map names the cell, transparent elsewhere.
 *
 * Building one canvas per cell up front (3696 cells, `createElement` +
 * `getContext` + `createImageData` + `putImageData` each) cost 960 ms on
 * a 4x-throttled phone, so the store starts as an empty sparse array and
 * a cell's sprite is built the first time a frame draws it, then cached
 * and reused. At most a handful of cells are lit at once, so the
 * per-frame cost stays bounded. Pure module: the builder callback owns
 * the canvas, so the unit tests count builds with a stub.
 */

export interface CellBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Paint one cell's pixels into `data`: teal (r, g, b) and opaque where
 * the label map names `id`, untouched elsewhere. Byte-identical to the
 * eager builder it replaces.
 */
export function writeCellPixels(
  data: Uint8ClampedArray,
  cell: CellBox,
  mapW: number,
  ids: Int32Array,
  id: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let y = 0; y < cell.h; y++) {
    for (let x = 0; x < cell.w; x++) {
      if (ids[(cell.y + y) * mapW + cell.x + x] !== id) continue;
      const o = (y * cell.w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
}

export interface SpriteStore {
  /** The cached sprite for cell n, building it on first use. */
  get(n: number): CanvasImageSource | null;
  /** Sprites actually built so far (holes never build). */
  readonly built: number;
}

/**
 * The empty sparse sprite array: `build` runs at most once per cell
 * (nulls are cached too, via `in`), out-of-range reads stay null.
 */
export function createSpriteStore(
  length: number,
  build: (n: number) => CanvasImageSource | null,
): SpriteStore {
  const sprites: Array<CanvasImageSource | null> = [];
  let built = 0;
  return {
    get(n: number): CanvasImageSource | null {
      if (n < 0 || n >= length) return null;
      if (n in sprites) return sprites[n] as CanvasImageSource | null;
      const sp = build(n);
      sprites[n] = sp;
      if (sp) built++;
      return sp;
    },
    get built(): number {
      return built;
    },
  };
}

/** The slice of a 2d context the cell draw loop needs. */
export interface CellPainter {
  globalAlpha: number;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * The only cell draw loop: cells at `vis >= 0.01` are drawn at their
 * visibility (building the sprite on first use) and everything else is
 * skipped, so the built count never exceeds the cells drawn so far.
 */
export function drawCells(
  ctx: CellPainter,
  store: SpriteStore,
  cells: Array<CellBox | null>,
  vis: ArrayLike<number>,
  halo: number,
): void {
  for (let k = 0; k < cells.length; k++) {
    if (vis[k] < 0.01) continue;
    const cell = cells[k];
    if (!cell) continue;
    const sprite = store.get(k);
    if (!sprite) continue;
    ctx.globalAlpha = vis[k];
    ctx.drawImage(sprite, cell.x * halo, cell.y * halo, cell.w * halo, cell.h * halo);
  }
  ctx.globalAlpha = 1;
}
