// SPDX-License-Identifier: Apache-2.0
// The document title behind every remote view: "<view> · Canopy remote",
// the bare site name until the app paints its first route. The shell, the
// guest views and the editor all title through here, so the scheme stays
// one scheme.

/** The site name every view title carries. */
export const REMOTE_SITE = "Canopy remote";

/** The separator between the view and the site: "Sessions · Canopy remote". */
export const REMOTE_SEPARATOR = " · ";

/** One view title: the view plus the site, or the bare site when empty. */
export function remoteTitle(view: string): string {
  return view === "" ? REMOTE_SITE : `${view}${REMOTE_SEPARATOR}${REMOTE_SITE}`;
}

/** One session's title: its name plus the site ("Session" when nameless). */
export function sessionTitle(name: string): string {
  return remoteTitle(name === "" ? "Session" : name);
}

/** One graph's title: its name plus the site ("Graph" when nameless). */
export function graphTitle(name: string): string {
  return remoteTitle(name === "" ? "Graph" : name);
}

/** What the shell's title needs beyond the route name. */
export interface ShellTitleState {
  homeTab: string;
  graphName: string;
  sessionName: string;
}

/**
 * The shell's document title per route: the home tab's own name on the
 * home screen, the session or graph name on its view.
 */
export function shellTitle(route: string, state: ShellTitleState): string {
  if (route === "signin") {
    return remoteTitle("Sign in");
  }
  if (route === "pair") {
    return remoteTitle("Pair");
  }
  if (route === "hosts") {
    return remoteTitle("Choose a host");
  }
  if (route === "sessions") {
    return remoteTitle(state.homeTab === "graphs" ? "Graphs" : "Sessions");
  }
  if (route === "graph") {
    return graphTitle(state.graphName);
  }
  if (route === "metrics") {
    return remoteTitle("SysInfo");
  }
  return sessionTitle(state.sessionName);
}
