// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../src/catalog.js";
import { NewDialog } from "../src/new-dialog.js";
import type { SpawnRequest } from "../src/protocol.js";
import type { Catalog } from "../src/protocol.js";

const CATALOG: Catalog = {
  clis: [
    { cli: "muse", label: "Muse", models: ["spark", "core"] },
    { cli: "claude", label: "Claude", models: [] },
  ],
  projects: [
    { name: "demo", path: "/home/u/demo" },
    { name: "other", path: "/home/u/other" },
  ],
  presets: [],
  skills: [],
};

describe("NewDialog", () => {
  let root: HTMLDivElement;
  let catalog: CatalogStore;
  let dialog: NewDialog;
  let spawns: { spawn: SpawnRequest; req: string }[];
  let connected: boolean;

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  const submit = (): void => {
    query<HTMLFormElement>("#new-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  };

  const change = (selector: string, value: string): void => {
    const el = query<HTMLSelectElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    catalog = new CatalogStore();
    catalog.replace(CATALOG);
    spawns = [];
    connected = true;
    dialog = new NewDialog(catalog, {
      onSpawn: (spawn, req) => {
        spawns.push({ spawn, req });
        return connected;
      },
    });
    dialog.open(root);
  });

  afterEach(() => {
    dialog.close();
    root.remove();
    document.body.innerHTML = "";
  });

  it("defaults to the first harness with its models and no project", () => {
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("muse");
    const models = [...root.querySelectorAll<HTMLOptionElement>("#new-model option")];
    expect(models.map((option) => option.value)).toEqual(["", "spark", "core"]);
    expect(query<HTMLSelectElement>("#new-model").value).toBe("");
    expect(query<HTMLSelectElement>("#new-project").value).toBe("");
    expect(query<HTMLOptionElement>("#new-project option").textContent).toBe("Choose a project…");
  });

  it("preselects the only project and follows a harness change", () => {
    catalog.replace({ ...CATALOG, projects: [CATALOG.projects[0] as Catalog["projects"][number]] });
    expect(query<HTMLSelectElement>("#new-project").value).toBe("demo");
    change("#new-cli", "claude");
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("claude");
    const models = [...root.querySelectorAll<HTMLOptionElement>("#new-model option")];
    expect(models.map((option) => option.value)).toEqual([""]);
    expect(query<HTMLSelectElement>("#new-model").value).toBe("");
  });

  it("sends the exact spawn frame and omits empty optional fields", () => {
    change("#new-cli", "claude");
    change("#new-project", "demo");
    query<HTMLInputElement>("#new-name").value = "  build  ";
    query<HTMLTextAreaElement>("#new-prompt").value = "  do the thing \n";
    submit();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.spawn).toEqual({
      cli: "claude",
      workdir: "/home/u/demo",
      name: "build",
      prompt: "do the thing",
    });
    expect(typeof spawns[0]?.req).toBe("string");
    expect(dialog.isOpen).toBe(true);
  });

  it("includes a chosen model", () => {
    change("#new-project", "other");
    change("#new-model", "spark");
    submit();
    expect(spawns[0]?.spawn).toEqual({
      cli: "muse",
      model: "spark",
      workdir: "/home/u/other",
    });
  });

  it("requires a project", () => {
    submit();
    expect(spawns).toHaveLength(0);
    const error = query<HTMLElement>("#new-project-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Choose a project");
  });

  it("closes on a matching spawned and ignores other reqs", () => {
    change("#new-project", "demo");
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleSpawned("other")).toBe(false);
    expect(dialog.isOpen).toBe(true);
    expect(dialog.handleSpawned(req)).toBe(true);
    expect(dialog.isOpen).toBe(false);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("shows a spawn error beside the project field and keeps the form", () => {
    change("#new-project", "demo");
    query<HTMLInputElement>("#new-name").value = "build";
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleError("unknown project: demo", req, "unknown_project")).toBe(true);
    const error = query<HTMLElement>("#new-project-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("unknown project: demo");
    expect(dialog.isOpen).toBe(true);
    expect(query<HTMLInputElement>("#new-name").value).toBe("build");
    expect(query<HTMLSelectElement>("#new-project").value).toBe("demo");
  });

  it("shows other errors above the actions", () => {
    change("#new-project", "demo");
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleError("spawn_failed: harness exited", req, "spawn_failed")).toBe(true);
    expect(query("#new-error").textContent).toBe("spawn_failed: harness exited");
    expect(dialog.handleError("late", req, "internal")).toBe(false);
  });

  it("says so when the frame cannot be sent", () => {
    connected = false;
    change("#new-project", "demo");
    submit();
    expect(query("#new-error").textContent).toBe("Not connected");
    expect(dialog.isOpen).toBe(true);
  });

  it("fills the pickers when the catalog arrives late", () => {
    catalog.clear();
    expect(query<HTMLOptionElement>("#new-cli option").textContent).toBe("No harnesses");
    catalog.replace(CATALOG);
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("muse");
    expect([...root.querySelectorAll("#new-project option")]).toHaveLength(3);
  });

  it("closes from the close button", () => {
    query<HTMLButtonElement>("#new-close").click();
    expect(dialog.isOpen).toBe(false);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
