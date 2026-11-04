// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { guardGuestSend, isGuestFrameAllowed } from "../src/guest-guard.js";

describe("isGuestFrameAllowed", () => {
  it("allows the shared stream: list, attach, detach, input, text prompt", () => {
    const allowed = [
      { t: "list", req: "r1" },
      { t: "attach", id: "s1" },
      { t: "detach", id: "s1" },
      { t: "input", id: "s1", data: "bHM=" },
      { t: "prompt", req: "r2", id: "s1", text: "fix it" },
    ];
    for (const frame of allowed) {
      expect(isGuestFrameAllowed(JSON.stringify(frame)), JSON.stringify(frame)).toBe(true);
    }
  });

  it("rejects every out-of-grant action", () => {
    const denied = [
      { t: "spawn", req: "r1", kind: "agent", workdir: "/x" },
      { t: "spawn", req: "r1", kind: "terminal", workdir: "/x" },
      { t: "compose", req: "r1", draft: { sections: [], skills: [] } },
      { t: "prompt", req: "r1", id: "s1", draft: { sections: [], skills: [] } },
      { t: "catalog", req: "r1" },
      { t: "shelf_list", req: "r1", id: "s1" },
      { t: "shelf_get", req: "r1", file_id: "f1" },
      { t: "graphs", req: "r1" },
      { t: "graph_watch", id: "g1" },
      { t: "graph_unwatch", id: "g1" },
      { t: "host.metrics.watch", interval: 10 },
      { t: "host.metrics.unwatch" },
      { t: "pair_init" },
      { t: "offer", sdp: "v=0" },
    ];
    for (const frame of denied) {
      expect(isGuestFrameAllowed(JSON.stringify(frame)), JSON.stringify(frame)).toBe(false);
    }
  });

  it("fails closed on malformed frames", () => {
    for (const raw of ["", "{", "[]", "null", "42", '"prompt"', JSON.stringify({})]) {
      expect(isGuestFrameAllowed(raw), raw).toBe(false);
    }
  });
});

describe("guardGuestSend", () => {
  it("sends allowed frames and drops denied ones without calling send", () => {
    const sent: string[] = [];
    const send = guardGuestSend((data) => {
      sent.push(data);
      return true;
    });
    expect(send(JSON.stringify({ t: "attach", id: "s1" }))).toBe(true);
    expect(send(JSON.stringify({ t: "spawn", req: "r1", kind: "agent", workdir: "/x" }))).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
