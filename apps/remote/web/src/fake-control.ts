// SPDX-License-Identifier: Apache-2.0
// Test-only graph control behind fake.html (served by vite dev, never
// built): the hello features the fake greets with, and the Playwright
// hook that sends graph_control for the watched graph straight at the
// host, the way the view's button does. Split out of fake-host.ts to
// keep the fake entry a readable size.

import { buildGraphControl, newReqId } from "./protocol.js";
import type { GraphControlAction } from "./protocol.js";

/**
 * The hello's feature list: the shelf always, the upload half unless
 * ?upload=off, graph_control unless ?controls=off, and session_resume
 * unless ?resume=off greets like an older host — each view or dialog
 * then shows nothing of the missing feature.
 */
export function fakeHelloFeatures(search: string): string[] {
  const params = new URLSearchParams(search);
  return [
    "shelf",
    ...(params.get("upload") === "off" ? [] : ["shelf_upload"]),
    ...(params.get("controls") === "off" ? [] : ["graph_control"]),
    ...(params.get("resume") === "off" ? [] : ["session_resume"]),
  ];
}

/** The __fake.graphControl hook: one raw control for the watched graph. */
export function createFakeControl(
  send: (data: string) => boolean,
  watchedId: () => string | null,
): (action: GraphControlAction) => void {
  return (action: GraphControlAction) => {
    const id = watchedId();
    if (id !== null) {
      send(buildGraphControl(newReqId(), id, action));
    }
  };
}
