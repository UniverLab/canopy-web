// SPDX-License-Identifier: Apache-2.0
// The header-band honeycomb: the shared look kit's live background,
// mounted on the #fondo host the topbar carries as its first child. Every
// view repaints the header with root.innerHTML, which detaches the old
// host, so each repaint syncs: destroy the previous mount, then mount on
// the fresh host. The kit loads lazily — the guest chunk mounts too, and
// must not carry the kit's bytes statically — and a mount that loses its
// race (a newer repaint, a detached host) is destroyed, never kept.

export interface FondoHandle {
  destroy(): void;
}

export type FondoMount = (host: HTMLElement) => FondoHandle | null | Promise<FondoHandle | null>;

/** The kit's asset base, the same one the graphs header mounts with. */
export const FONDO_ASSETS = "/look/fondo/assets/";

let current: FondoHandle | null = null;
let pending = 0;

async function realMount(host: HTMLElement): Promise<FondoHandle | null> {
  // No 2d canvas, no honeycomb: the header stays flat (and unit tests,
  // which have no canvas, never touch the kit or the network).
  if (!document.createElement("canvas").getContext("2d")) {
    return null;
  }
  const { mountCanopyBackground } = await import("../../../../packages/look/fondo/index.js");
  return mountCanopyBackground(host, FONDO_ASSETS);
}

/**
 * Remount the honeycomb on the header's fresh #fondo host. A repaint that
 * carries no host (or no canvas) simply leaves the previous mount
 * destroyed and the header flat. The mount is injectable for tests; the
 * default is the shared kit, honouring prefers-reduced-motion.
 */
export function syncHeaderFondo(root: ParentNode, mount: FondoMount = realMount): void {
  current?.destroy();
  current = null;
  const attempt = ++pending;
  const host = root.querySelector("#fondo");
  if (!(host instanceof HTMLElement)) {
    return;
  }
  void Promise.resolve()
    .then(() => mount(host))
    .then((handle) => {
      if (handle === null || attempt !== pending || !host.isConnected) {
        handle?.destroy();
        return;
      }
      current = handle;
    })
    .catch(() => {
      // The header stays flat when the kit fails to load or mount.
    });
}
