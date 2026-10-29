// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's WebMCP tools: two read-only, unauthenticated, pure tools
 * about the public service. Nothing here fetches, opens a socket or
 * touches a session — the tests fail the fetch to prove it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTools,
  findModelContext,
  initWebMcp,
  registerRemoteTools,
  type McpTool,
  type ModelContextLike,
} from "../src/webmcp.js";

class FakeModelContext implements ModelContextLike {
  registered: McpTool[] = [];

  registerTool(tool: McpTool): Promise<unknown> {
    this.registered.push(tool);
    return Promise.resolve(tool.name);
  }
}

function stubModelContext(mc: ModelContextLike | undefined): void {
  Object.defineProperty(document, "modelContext", {
    value: mc,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // The module reads document first: leave no stub behind for the next test.
  if ("modelContext" in document) {
    Object.defineProperty(document, "modelContext", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
});

describe("buildTools", () => {
  it("builds the two read-only public tools", () => {
    const tools = buildTools();
    expect(tools.map((tool) => tool.name)).toEqual(["remote_status", "how_to_pair"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toEqual({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
      expect(tool.annotations).toEqual({ readOnlyHint: true });
    }
  });

  it("describes the public service without touching the network", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("must not fetch")));
    vi.stubGlobal("fetch", fetchSpy);
    const [status, pairing] = buildTools();
    const statusText = await status.execute({}, {});
    for (const line of ["Canopy remote", "GitHub", "/auth/login", "/ws/device", "/turn", "llms.txt"]) {
      expect(statusText).toContain(line);
    }
    const pairingText = await pairing.execute({}, {});
    for (const line of ["pair", "code", "end-to-end"]) {
      expect(pairingText).toContain(line);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("findModelContext", () => {
  it("prefers document.modelContext and falls back to navigator", () => {
    const docMc = new FakeModelContext();
    const navMc = new FakeModelContext();
    stubModelContext(docMc);
    vi.stubGlobal("navigator", { modelContext: navMc });
    expect(findModelContext()).toBe(docMc);
    stubModelContext(undefined);
    expect(findModelContext()).toBe(navMc);
  });

  it("returns null when neither host carries the API", () => {
    stubModelContext(undefined);
    vi.stubGlobal("navigator", {});
    expect(findModelContext()).toBeNull();
  });
});

describe("registerRemoteTools", () => {
  it("registers both tools", async () => {
    const mc = new FakeModelContext();
    await registerRemoteTools(mc);
    expect(mc.registered.map((tool) => tool.name)).toEqual(["remote_status", "how_to_pair"]);
  });
});

describe("initWebMcp", () => {
  it("registers on the deferred tick and swallows a rejection", async () => {
    vi.useFakeTimers();
    // The setTimeout path, deterministically: no requestIdleCallback here.
    vi.stubGlobal("requestIdleCallback", undefined);
    const mc = new FakeModelContext();
    stubModelContext(mc);
    initWebMcp();
    expect(mc.registered).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(mc.registered.map((tool) => tool.name)).toEqual(["remote_status", "how_to_pair"]);

    // A duplicate name rejects: the page must never break for it.
    const failing: ModelContextLike = {
      registerTool: () => Promise.reject(new Error("duplicate name")),
    };
    stubModelContext(failing);
    expect(() => initWebMcp()).not.toThrow();
    await vi.advanceTimersByTimeAsync(10);
  });

  it("schedules nothing when the API is absent", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    stubModelContext(undefined);
    vi.stubGlobal("navigator", {});
    initWebMcp();
    expect(spy).not.toHaveBeenCalled();
  });
});
