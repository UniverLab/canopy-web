// Copied from univerlab src/scripts/fondos/canopy.ts (import extensions and observer typing adapted)
import { hostCanvas, pointerIn, loop, decodeImage } from './runtime.js';
import type { Fondo, FondoOpts, MountFondo, ObservedCanvas, FondoImage } from './runtime.js';
import { loadCellIndex, lookupCell } from './cell-map.js';
import type { CellIndex, LabelRows } from './cell-map.js';
import { createSpriteStore, drawCells, writeCellPixels } from './sprites.js';
import type { SpriteStore } from './sprites.js';

const TEAL = '#3fb8b0';
const STEP_MS = 120;
export const ON = 1;
export const DYING = 2;
const BIRTH = 0.8;
const HALO = 0.5;
const COMB_ALPHA = 0.035;
const REVIVE_IDLE = 4000;
const REVIVE_GAP = 3000;
// The cells repaint at most this often: they step every 120ms, so 30fps is
// already smooth, and a phone's main thread gets half its frames back.
const DRAW_MS = 33;
// The glow's blur is a downscale to 1/BLUR_DOWN and a smoothed upscale; a
// canvas `filter: blur()` cost 20ms a frame on a throttled phone.
const BLUR_DOWN = 4;
export const MASK = 'radial-gradient(ellipse 66% 76% at 50% 44%, transparent 0 38%, #000 88%)';

export interface CanopyCell {
  x: number;
  y: number;
  w: number;
  h: number;
  n: number[];
}

export function stepCells(
  state: Uint8Array,
  next: Uint8Array,
  cells: Array<{ n: number[] } | null>,
  rand: () => number = Math.random
): Uint8Array {
  for (let k = 0; k < state.length; k++) {
    const cell = cells[k];
    if (!cell) {
      next[k] = 0;
      continue;
    }
    if (state[k] === ON) {
      next[k] = DYING;
    } else if (state[k] === DYING) {
      next[k] = 0;
    } else {
      let on = 0;
      for (const j of cell.n) {
        if (state[j] === ON) on++;
      }
      next[k] = on === 2 && rand() < BIRTH ? ON : 0;
    }
  }
  return next;
}

export const mount: MountFondo = (host: HTMLElement, opts: FondoOpts): Fondo => {
  const { base, reduced } = opts;

  const { canvas, ctx: c, size } = hostCanvas(host);
  canvas.style.setProperty('mask-image', MASK);
  canvas.style.setProperty('-webkit-mask-image', MASK);

  if (reduced) {
    let still: FondoImage | null = null;
    // A resize clears the canvas (hostCanvas reassigns its size), so the still is repainted on every resize.
    const paintStill = () => {
      if (!still) return;
      const sz = size();
      const mapW = still.width || 1;
      const mapH = still.height || 1;
      const s = Math.max(sz.w / mapW, sz.h / mapH);
      const ox = (sz.w - mapW * s) / 2;
      const oy = (sz.h - mapH * s) / 2;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.setTransform(sz.dpr * s, 0, 0, sz.dpr * s, sz.dpr * ox, sz.dpr * oy);
      c.globalAlpha = COMB_ALPHA;
      c.drawImage(still.source, 0, 0);
      c.globalAlpha = 1;
    };
    decodeImage(base + 'panal.webp').then((img) => {
      still = img;
      paintStill();
    });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(paintStill) : null;
    ro?.observe(host);
    return {
      setNight() {},
      destroy() {
        ro?.disconnect();
        (canvas as ObservedCanvas).__ro?.disconnect?.();
        canvas.remove();
      },
    };
  }

  // Cost model (measured on a 4x-throttled phone): the comb never moves, so
  // `canvas` holds it alone and is repainted only on a resize. The lit cells
  // and their glow are small canvases the compositor scales and blends
  // (plus-lighter) — a full-screen drawImage with 'lighter' was 15ms a frame.
  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  layer.style.setProperty('mask-image', MASK);
  layer.style.setProperty('-webkit-mask-image', MASK);
  const lit = document.createElement('canvas');
  const lc = lit.getContext('2d') as CanvasRenderingContext2D;
  const glow = document.createElement('canvas');
  const gc = glow.getContext('2d') as CanvasRenderingContext2D;
  for (const el of [lit, glow]) {
    el.style.position = 'absolute';
    layer.appendChild(el);
  }
  glow.style.opacity = '0.9';
  glow.style.mixBlendMode = 'screen';
  glow.style.mixBlendMode = 'plus-lighter';
  host.appendChild(layer);
  const tiny = document.createElement('canvas');
  const tc = tiny.getContext('2d') as CanvasRenderingContext2D;
  // The comb pre-scaled to the glow's size, so the per-frame mask is a 1:1 copy.
  const combGlow = document.createElement('canvas');
  const cg = combGlow.getContext('2d') as CanvasRenderingContext2D;

  let dpr = 1;
  let w = 0;
  let h = 0;
  let s = 1;
  let ox = 0;
  let oy = 0;
  let map: { w: number; h: number; cells: CanopyCell[] } | null = null;
  let comb: FondoImage | null = null;
  let cells: CanopyCell[] = [];
  // Empty and sparse up front: a cell's sprite is built the first time a
  // frame draws it, then cached and reused. At most a handful of cells
  // are lit at once, so the per-frame cost stays bounded.
  let store: SpriteStore | null = null;
  let index: CellIndex | null = null;
  let state: Uint8Array | null = null;
  let next: Uint8Array | null = null;
  let vis: Float32Array | null = null;

  let lastStep = 0;
  let lastInput = 0;
  let lastRevive = 0;
  let lastCell = -1;
  let lastDraw = 0;
  let blank = false;
  let ready = false;

  const layout = () => {
    const sz = size();
    dpr = sz.dpr;
    w = sz.w;
    h = sz.h;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    if (!map || !comb) return;
    s = Math.max(w / map.w, h / map.h);
    ox = (w - map.w * s) / 2;
    oy = (h - map.h * s) / 2;
    for (const el of [lit, glow]) {
      el.style.left = ox + 'px';
      el.style.top = oy + 'px';
      el.style.width = map.w * s + 'px';
      el.style.height = map.h * s + 'px';
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    c.globalAlpha = COMB_ALPHA;
    c.drawImage(comb.source, 0, 0);
    c.globalAlpha = 1;
  };

  const hex = TEAL.match(/\w\w/g) as string[];
  const [r, g, b] = hex.map((x) => parseInt(x, 16));

  const buildSprite = (n: number): HTMLCanvasElement | null => {
    const cell = cells[n];
    if (!cell || !map || !index) return null;
    const sp = document.createElement('canvas');
    sp.width = cell.w;
    sp.height = cell.h;
    const sc = sp.getContext('2d') as CanvasRenderingContext2D;
    const img = sc.createImageData(cell.w, cell.h);
    writeCellPixels(img.data, cell, map.w, index.ids, n + 1, r, g, b);
    sc.putImageData(img, 0, 0);
    return sp;
  };

  const cellAt = (x: number, y: number): number => {
    if (!map) return -1;
    const ix = Math.floor((x - ox) / s);
    const iy = Math.floor((y - oy) / s);
    // -1 until the last id slice lands; pointer input before that is ignored.
    return lookupCell(index, ix, iy);
  };

  const seed = (k: number) => {
    if (k < 0 || !cells[k] || !state) return;
    state[k] = ON;
    const ns = cells[k].n;
    if (ns && ns.length) {
      state[ns[(Math.random() * ns.length) | 0]] = ON;
    }
  };

  const input = (x: number, y: number) => {
    lastInput = performance.now();
    const k = cellAt(x, y);
    if (k !== lastCell) {
      seed(k);
      lastCell = k;
    }
  };

  const frame = (now: number) => {
    if (!ready || !map || !comb || !state || !next || !vis || !store) return;
    const sz = size();
    if (sz.w !== w || sz.h !== h || sz.dpr !== dpr || w === 0) layout();
    if (now - lastStep > STEP_MS) {
      stepCells(state, next, cells, Math.random);
      const tmp = state;
      state = next;
      next = tmp;
      lastStep = now;
      let alive = 0;
      for (let k = 0; k < state.length; k++) if (state[k] === ON) alive++;
      if (
        alive < 2 &&
        now - lastInput > REVIVE_IDLE &&
        now - lastRevive > REVIVE_GAP
      ) {
        seed((Math.random() * cells.length) | 0);
        lastRevive = now;
      }
    }

    if (now - lastDraw < DRAW_MS) return;
    // Fades are rated per 60fps frame; scale them to the real gap.
    const steps = lastDraw ? Math.min((now - lastDraw) / 16.7, 6) : 1;
    lastDraw = now;

    // Every non-null cell fades here, not just the built sprites: a cell
    // still dark has no sprite yet, and skipping it would leave it dark
    // forever.
    let litAny = false;
    for (let k = 0; k < cells.length; k++) {
      if (!cells[k]) continue;
      const target = state[k] === ON ? 0.55 : state[k] === DYING ? 0.18 : 0;
      const rate = target > vis[k] ? 0.5 : 0.08;
      vis[k] += (target - vis[k]) * (1 - Math.pow(1 - rate, steps));
      if (vis[k] >= 0.01) litAny = true;
    }
    // Nothing glows: clear once and leave both canvases alone until a cell lights.
    if (!litAny && blank) return;
    blank = !litAny;

    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, lit.width, lit.height);
    drawCells(lc, store, cells, vis, HALO);

    tc.globalCompositeOperation = 'copy';
    tc.drawImage(lit, 0, 0, tiny.width, tiny.height);
    gc.globalCompositeOperation = 'copy';
    gc.drawImage(tiny, 0, 0, glow.width, glow.height);
    gc.globalCompositeOperation = 'source-in';
    gc.drawImage(combGlow, 0, 0);
  };

  const unsubPointer = pointerIn(
    host,
    (x, y) => input(x, y),
    () => {
      lastCell = -1;
    }
  );

  const stopLoop = loop(host, frame);

  Promise.all([
    fetch(base + 'celdas.json').then((r) => r.json()),
    decodeImage(base + 'celdas.png'),
    decodeImage(base + 'panal.webp'),
  ]).then(async ([m, labels, img]) => {
    map = m;
    cells = m.cells;
    comb = img;
    state = new Uint8Array(cells.length);
    next = new Uint8Array(cells.length);
    vis = new Float32Array(cells.length);
    store = createSpriteStore(cells.length, buildSprite);
    const k = document.createElement('canvas');
    k.width = map!.w;
    k.height = map!.h;
    const kc = k.getContext('2d') as CanvasRenderingContext2D;
    kc.drawImage(labels.source, 0, 0);
    // The ids land in slices of at most 128 rows per task; `ready` flips
    // only after the last slice, in the same task as layout and the seeds.
    const rows: LabelRows = {
      width: map!.w,
      height: map!.h,
      readRows: (y, count) => kc.getImageData(0, y, map!.w, count).data,
    };
    index = await loadCellIndex(rows);
    lit.width = glow.width = combGlow.width = Math.round(map!.w * HALO);
    lit.height = glow.height = combGlow.height = Math.round(map!.h * HALO);
    tiny.width = Math.max(1, Math.round(lit.width / BLUR_DOWN));
    tiny.height = Math.max(1, Math.round(lit.height / BLUR_DOWN));
    cg.drawImage(img.source, 0, 0, combGlow.width, combGlow.height);
    layout();
    for (let i = 0; i < 6; i++) seed((Math.random() * cells.length) | 0);
    ready = true;
  });

  return {
    setNight() {},
    destroy() {
      unsubPointer();
      stopLoop();
      (canvas as ObservedCanvas).__ro?.disconnect?.();
      canvas.remove();
      layer.remove();
    },
  };
};
