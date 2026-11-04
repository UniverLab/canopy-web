// SPDX-License-Identifier: Apache-2.0
// The WebGL renderer draws box drawing and block elements itself when
// xterm's customGlyphs option is on, so a canopy TUI's frames are
// pixel-exact. WebGL is an optimisation, never a requirement: a context
// loss or a failed load disposes the addon and leaves xterm's DOM
// renderer in place, so the operator never sees a blank terminal.

import type { ITerminalAddon } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";

export interface WebglHost {
  loadAddon: (addon: ITerminalAddon) => void;
}

export function attachWebgl(terminal: WebglHost, onFallback?: () => void): WebglAddon | null {
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    addon.onContextLoss(() => {
      try {
        addon?.dispose();
      } catch {
        // Disposing is best effort; xterm keeps the DOM renderer.
      }
      addon = null;
      onFallback?.();
    });
    terminal.loadAddon(addon);
    return addon;
  } catch {
    try {
      addon?.dispose();
    } catch {
      // Disposing is best effort; xterm keeps the DOM renderer.
    }
    onFallback?.();
    return null;
  }
}
