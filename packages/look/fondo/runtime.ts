// Copied from univerlab src/scripts/fondos/runtime.ts (observer typing adapted)
export interface ObservedCanvas extends HTMLCanvasElement { __ro?: ResizeObserver }
export interface FondoOpts { night: boolean; reduced: boolean; base: string }
export interface Fondo { setNight(night: boolean): void; destroy(): void }
export type MountFondo = (host: HTMLElement, opts: FondoOpts) => Fondo;

export function hostCanvas(host: HTMLElement): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  size(): { w: number; h: number; dpr: number };
} {
  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;

  let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  let w = 0;
  let h = 0;

  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const rect = host.getBoundingClientRect();
    w = Math.max(1, Math.floor(rect.width));
    h = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  };

  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!canvas.isConnected) {
        ro.disconnect();
        return;
      }
      resize();
    });
    ro.observe(host);
    (canvas as ObservedCanvas).__ro = ro;
  }
  resize();

  return {
    canvas,
    ctx,
    size: () => ({ w, h, dpr }),
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

export function pointerIn(
  host: HTMLElement,
  onMove: (x: number, y: number) => void,
  onLeave?: () => void
): () => void {
  const coarse =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;

  let virtualY = 0;
  let lastScrollY = window.scrollY;
  let virtualX = 0;

  const report = (x: number, y: number) => {
    const rect = host.getBoundingClientRect();
    const rx = x - rect.left;
    const ry = y - rect.top;
    if (rx < 0 || ry < 0 || rx > rect.width || ry > rect.height) {
      if (onLeave) onLeave();
      return;
    }
    onMove(rx, ry);
  };

  const onPointerMove = (e: Event) => {
    const pe = e as PointerEvent;
    if (typeof pe.clientX !== 'number') return;
    report(pe.clientX, pe.clientY);
  };
  const onPointerDown = (e: Event) => {
    const pe = e as PointerEvent;
    if (typeof pe.clientX !== 'number') return;
    report(pe.clientX, pe.clientY);
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerdown', onPointerDown);

  // touch: vertical scroll drives a virtual pointer
  let scrollHandler: (() => void) | null = null;
  if (coarse) {
    const rect = host.getBoundingClientRect();
    virtualX = rect.width / 2;
    virtualY = 0;
    scrollHandler = () => {
      const r = host.getBoundingClientRect();
      const delta = window.scrollY - lastScrollY;
      lastScrollY = window.scrollY;
      virtualY = Math.max(0, Math.min(r.height, virtualY + delta));
      const x = virtualX;
      const y = virtualY;
      if (x < 0 || y < 0 || x > r.width || y > r.height) {
        if (onLeave) onLeave();
        return;
      }
      onMove(x, y);
    };
    window.addEventListener('scroll', scrollHandler, { passive: true });
  }

  return () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown);
    if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
  };
}

export function loop(host: HTMLElement, frame: (now: number) => void): () => void {
  let rafId: number | null = null;
  let onScreen = true;
  let tabVisible = !document.hidden;

  const cancel = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };

  const schedule = () => {
    if (rafId !== null) return;
    if (!onScreen || !tabVisible) return;
    rafId = requestAnimationFrame(function cb(now: number) {
      frame(now);
      if (onScreen && tabVisible) {
        rafId = requestAnimationFrame(cb);
      } else {
        rafId = null;
      }
    });
  };

  let io: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === host) onScreen = entry.isIntersecting;
      }
      if (onScreen) schedule();
      else cancel();
    });
    io.observe(host);
  }

  const onVis = () => {
    tabVisible = !document.hidden;
    if (tabVisible) schedule();
    else cancel();
  };
  document.addEventListener('visibilitychange', onVis);

  schedule();

  return () => {
    cancel();
    if (io) io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
  };
}