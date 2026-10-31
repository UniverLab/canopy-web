// SPDX-License-Identifier: Apache-2.0
// The SysInfo route: the strip in the header, the view behind it, and the
// watch lifecycle — watch while the strip or the view shows (the home tab,
// the graph, the SysInfo view itself), unwatch on the terminal, the
// off-host screens, page hide, or teardown. The terminal keeps the whole
// viewport, like the sign-out control it never carries. The shell owns
// render() and the route; this module owns everything else metrics needs,
// through hooks the shell provides. Mirrors the graph route's split.

import type { MetricsStore } from "./metrics-store.js";
import { metricsStripHtml, renderMetricsView, updateMetricsView } from "./metrics-view.js";
import type { MetricsViewArgs } from "./metrics-view.js";

export interface MetricsReturn {
  route: "sessions" | "session" | "graph";
  sessionId: string | null;
}

export interface MetricsRouteCallbacks {
  /** Watch the host's metrics while the strip or the SysInfo view shows. */
  onWatchMetrics: () => void;
  /** Stop watching: hiding the page, entering the terminal, leaving. */
  onUnwatchMetrics: () => void;
  /** The strip was tapped; the shell tears down and shows the view. */
  onOpenMetrics: () => void;
}

export interface MetricsRouteChrome {
  header: string;
  banner: string;
  /** The signed-in login the direct button names, or null. */
  login: string | null;
  /** The last sign-out failure, shown inline, or null. */
  signOutError: string | null;
  connected: boolean;
  /** Sign out through POST /auth/logout (shell-owned). */
  onSignOut: () => void;
}

export interface MetricsRouteHooks {
  /** Re-open a session from the SysInfo view (shell-owned re-attach). */
  openSession: (id: string) => void;
  /** Leave the SysInfo view for the home tab or the graph (shell-owned). */
  showReturn: (route: "sessions" | "graph") => void;
  /** Tear down the terminal widgets (shell-owned). */
  teardownSession: () => void;
  /** Show the SysInfo view over the captured return (shell-owned). */
  showMetrics: () => void;
  /** The chrome snapshot the view paints under; read fresh per paint. */
  chrome: () => MetricsRouteChrome;
  /** The shell's current route name ("sessions", "metrics", …). */
  route: () => string;
}

export class MetricsRoute {
  /** Where the SysInfo view goes back to; sessions until opened. */
  private ret: MetricsReturn = { route: "sessions", sessionId: null };
  private readonly root: HTMLElement;
  private readonly metrics: MetricsStore | null;
  private readonly callbacks: MetricsRouteCallbacks;
  private readonly hooks: MetricsRouteHooks;
  private stopStore: (() => void) | null = null;

  constructor(
    root: HTMLElement,
    metrics: MetricsStore | null,
    callbacks: MetricsRouteCallbacks,
    hooks: MetricsRouteHooks,
  ) {
    this.root = root;
    this.metrics = metrics;
    this.callbacks = callbacks;
    this.hooks = hooks;
  }

  /** The strip shows on the home tab, the graph and the SysInfo view. */
  onMetricsRoute(): boolean {
    const route = this.hooks.route();
    return route === "sessions" || route === "graph" || route === "metrics";
  }

  /** The strip markup for the header; "" where it must not show. */
  stripHtml(): string {
    return this.onMetricsRoute() ? metricsStripHtml(this.metrics?.current() ?? null) : "";
  }

  /** Watch while the strip or the view shows, unwatch anywhere else. */
  syncWatch(): void {
    if (this.onMetricsRoute()) {
      this.callbacks.onWatchMetrics();
    } else {
      this.callbacks.onUnwatchMetrics();
    }
  }

  // Tapping the strip opens the SysInfo view over a strip route or the
  // terminal; anything else (sign-in, pair, hosts) refuses. The session
  // stays attached and the graph stays watched underneath.
  openCurrent(route: string, sessionId: string | null): void {
    if (route !== "sessions" && route !== "session" && route !== "graph") {
      return;
    }
    this.ret = { route, sessionId: route === "session" ? sessionId : null };
    if (route === "session") {
      this.hooks.teardownSession();
    }
    this.hooks.showMetrics();
  }

  /** Back to the home tab, the graph, or the re-attached session. */
  back(): void {
    const ret = this.ret;
    this.ret = { route: "sessions", sessionId: null };
    if (ret.route === "session") {
      if (ret.sessionId !== null) {
        this.hooks.openSession(ret.sessionId);
      } else {
        this.hooks.showReturn("sessions");
      }
      return;
    }
    this.hooks.showReturn(ret.route);
  }

  mount(): void {
    renderMetricsView(this.root, this.args());
  }

  /** After a connection patch, the view's disconnect note follows. */
  syncConnection(): void {
    if (this.hooks.route() === "metrics") {
      updateMetricsView(this.root, this.args());
    }
  }

  wireStrip(): void {
    this.root
      .querySelector("#metrics-strip")
      ?.addEventListener("click", () => this.callbacks.onOpenMetrics());
  }

  /** After every render: wire the fresh strip, sync the watch. */
  afterRender(): void {
    this.wireStrip();
    this.syncWatch();
  }

  // A push repaints the strip where it sits — beside the host chip, at the
  // header's end — without touching the rest of the header, so the
  // terminal and the composer's draft survive it.
  syncStrip(): void {
    const html = this.stripHtml();
    const existing = this.root.querySelector("#metrics-strip");
    if (html === "") {
      existing?.remove();
      return;
    }
    if (existing === null) {
      this.root.querySelector(".topbar .topbar-inner")?.insertAdjacentHTML("beforeend", html);
      this.wireStrip();
      return;
    }
    const slot = document.createElement("span");
    slot.innerHTML = html;
    const next = slot.firstElementChild;
    if (next !== null) {
      existing.replaceWith(next);
      this.wireStrip();
    }
  }

  /** The store subscription and the hide/re-show hooks. */
  start(): void {
    // A push repaints the view in place when it is open, and the strip
    // wherever it rides.
    this.stopStore = this.metrics?.subscribe(() => {
      if (this.hooks.route() === "metrics") {
        updateMetricsView(this.root, this.args());
      }
      this.syncStrip();
    }) ?? null;
    globalThis.document.addEventListener("visibilitychange", this.onVisibility);
  }

  // Hiding the page drops the watch; showing it again (still on a route
  // that shows the strip) re-sends it.
  private readonly onVisibility = (): void => {
    if (globalThis.document.hidden) {
      this.callbacks.onUnwatchMetrics();
    } else if (this.onMetricsRoute()) {
      this.callbacks.onWatchMetrics();
    }
  };

  private args(): MetricsViewArgs {
    const chrome = this.hooks.chrome();
    return {
      header: chrome.header,
      banner: chrome.banner,
      login: chrome.login,
      signOutError: chrome.signOutError,
      frame: this.metrics?.current() ?? null,
      history: this.metrics?.history() ?? null,
      receivedAt: this.metrics?.lastReceivedAt() ?? null,
      connected: chrome.connected,
      onBack: () => this.back(),
      onSignOut: () => chrome.onSignOut(),
    };
  }

  dispose(): void {
    globalThis.document.removeEventListener("visibilitychange", this.onVisibility);
    this.callbacks.onUnwatchMetrics();
    this.stopStore?.();
    this.stopStore = null;
  }
}
