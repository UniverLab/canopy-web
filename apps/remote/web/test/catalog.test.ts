// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { CatalogStore, emptyCatalog } from "../src/catalog.js";
import type { Catalog } from "../src/protocol.js";

const CATALOG: Catalog = {
  clis: [{ cli: "muse", label: "Muse", models: ["spark"] }],
  projects: [{ name: "demo", path: "/home/u/demo" }],
  presets: [{ name: "review", preview: "look closely" }],
  skills: [{ name: "tdd", label: "TDD" }],
};

describe("CatalogStore", () => {
  it("starts empty and unloaded", () => {
    const store = new CatalogStore();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot()).toEqual(emptyCatalog());
    expect(store.clis).toEqual([]);
    expect(store.projects).toEqual([]);
    expect(store.presets).toEqual([]);
    expect(store.skills).toEqual([]);
  });

  it("caches the catalog and notifies subscribers", () => {
    const store = new CatalogStore();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.replace(CATALOG);
    expect(store.isLoaded).toBe(true);
    expect(store.clis).toEqual(CATALOG.clis);
    expect(store.projects).toEqual(CATALOG.projects);
    expect(store.presets).toEqual(CATALOG.presets);
    expect(store.skills).toEqual(CATALOG.skills);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.replace(CATALOG);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("clears on a new or lost host", () => {
    const store = new CatalogStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.replace(CATALOG);
    store.clear();
    expect(store.isLoaded).toBe(false);
    expect(store.snapshot()).toEqual(emptyCatalog());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("finds catalog entries by key", () => {
    const store = new CatalogStore();
    store.replace(CATALOG);
    expect(store.findCli("muse")?.label).toBe("Muse");
    expect(store.findCli("nope")).toBeNull();
    expect(store.findProject("demo")?.path).toBe("/home/u/demo");
    expect(store.findProject("nope")).toBeNull();
    expect(store.findPreset("review")?.preview).toBe("look closely");
    expect(store.findPreset("nope")).toBeNull();
  });
});
