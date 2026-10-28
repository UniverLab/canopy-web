// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../src/catalog.js";
import { readLastDir, readRecentDirs } from "../src/dir-history.js";
import { NewDialog, YOLO_HINT } from "../src/new-dialog.js";
import type { Catalog, SessionItem } from "../src/protocol.js";
import type { SpawnRequest } from "../src/protocol.js";

const CATALOG: Catalog = {
  clis: [
    { cli: "muse", label: "Muse", models: ["spark", "core"], yolo: true },
    { cli: "claude", label: "Claude", models: [] },
  ],
  projects: [
    { name: "demo", path: "/home/u/demo" },
    { name: "other", path: "/home/u/other" },
  ],
  presets: [],
  skills: [],
};

const SESSIONS: SessionItem[] = [
  {
    id: "s1",
    name: "live",
    cli: "muse",
    model: "spark",
    workdir: "/home/u/live",
    status: "running",
    lastOutputAt: null,
  },
];

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

  const changeSelect = (selector: string, value: string): void => {
    const el = query<HTMLSelectElement>(selector);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const pickKind = (kind: string): void => {
    const el = query<HTMLInputElement>(`input[name="kind"][value="${kind}"]`);
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  beforeEach(() => {
    localStorage.clear();
    root = document.createElement("div");
    document.body.appendChild(root);
    catalog = new CatalogStore();
    catalog.replace(CATALOG);
    spawns = [];
    connected = true;
    dialog = new NewDialog(
      catalog,
      {
        onSpawn: (spawn, req) => {
          spawns.push({ spawn, req });
          return connected;
        },
      },
      { sessions: SESSIONS, hostId: "h1" },
    );
    dialog.open(root);
  });

  afterEach(() => {
    dialog.close();
    root.remove();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("defaults to Agent with the harness, directory, yolo, name and prompt", () => {
    expect(query<HTMLInputElement>("#new-kind-agent").checked).toBe(true);
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("muse");
    expect(root.querySelector("#new-directory")).not.toBeNull();
    expect(root.querySelector("#new-yolo")).not.toBeNull();
    expect(root.querySelector("#new-name")).not.toBeNull();
    expect(root.querySelector("#new-prompt")).not.toBeNull();
  });

  it("has no model field anywhere", () => {
    expect(root.querySelector("#new-model")).toBeNull();
    expect(root.querySelector('[name="model"]')).toBeNull();
    pickKind("terminal");
    expect(root.querySelector("#new-model")).toBeNull();
  });

  it("shows only directory and name for Terminal", () => {
    pickKind("terminal");
    expect(root.querySelector("#new-directory")).not.toBeNull();
    expect(root.querySelector("#new-name")).not.toBeNull();
    expect(root.querySelector("#new-cli")).toBeNull();
    expect(root.querySelector("#new-yolo")).toBeNull();
    expect(root.querySelector("#new-prompt")).toBeNull();
    pickKind("agent");
    expect(root.querySelector("#new-cli")).not.toBeNull();
    expect(root.querySelector("#new-yolo")).not.toBeNull();
    expect(root.querySelector("#new-prompt")).not.toBeNull();
  });

  it("sends the exact agent spawn and omits empty optional fields", () => {
    query<HTMLInputElement>("#new-directory").value = "  /home/u/demo  ";
    query<HTMLInputElement>("#new-name").value = "  build  ";
    query<HTMLTextAreaElement>("#new-prompt").value = "  do the thing \n";
    submit();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.spawn).toEqual({
      kind: "agent",
      cli: "muse",
      workdir: "/home/u/demo",
      name: "build",
      prompt: "do the thing",
    });
    expect(typeof spawns[0]?.req).toBe("string");
    expect(dialog.isOpen).toBe(true);
  });

  it("sends a terminal spawn without cli, prompt or yolo", () => {
    pickKind("terminal");
    query<HTMLInputElement>("#new-directory").value = "~/scratch";
    query<HTMLInputElement>("#new-name").value = "shell";
    submit();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.spawn).toEqual({ kind: "terminal", workdir: "~/scratch", name: "shell" });
    expect("cli" in (spawns[0]?.spawn ?? {})).toBe(false);
    expect("prompt" in (spawns[0]?.spawn ?? {})).toBe(false);
    expect("yolo" in (spawns[0]?.spawn ?? {})).toBe(false);
  });

  it("enables yolo only for harnesses whose catalog entry carries it", () => {
    const box = query<HTMLInputElement>("#new-yolo");
    expect(box.disabled).toBe(false);
    expect(query<HTMLElement>("#new-yolo-hint").hidden).toBe(true);
    changeSelect("#new-cli", "claude");
    expect(query<HTMLInputElement>("#new-yolo").disabled).toBe(true);
    const hint = query<HTMLElement>("#new-yolo-hint");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(YOLO_HINT);
  });

  it("sends yolo only when checked, and never remembers it", () => {
    const box = query<HTMLInputElement>("#new-yolo");
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    expect(spawns[0]?.spawn).toEqual({
      kind: "agent",
      cli: "muse",
      workdir: "/home/u/demo",
      yolo: true,
    });
    // A harness switch to an unsupported entry unchecks.
    changeSelect("#new-cli", "claude");
    expect(query<HTMLInputElement>("#new-yolo").checked).toBe(false);
    // A fresh open is always off.
    dialog.close();
    dialog.open(root);
    expect(query<HTMLInputElement>("#new-yolo").checked).toBe(false);
  });

  it("requires a directory", () => {
    submit();
    expect(spawns).toHaveLength(0);
    const error = query<HTMLElement>("#new-directory-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("Enter a directory");
    pickKind("terminal");
    submit();
    expect(spawns).toHaveLength(0);
    expect(query<HTMLElement>("#new-directory-error").hidden).toBe(false);
  });

  it("suggests catalog, session and recent directories without duplicates", () => {
    query<HTMLInputElement>("#new-directory").value = "/home/u/typed";
    submit();
    expect(spawns).toHaveLength(1);
    dialog.close();
    dialog.open(root);
    const options = [...root.querySelectorAll<HTMLOptionElement>("#new-directory-list option")].map(
      (option) => option.value,
    );
    expect(options).toEqual(["/home/u/demo", "/home/u/other", "/home/u/live", "/home/u/typed"]);
  });

  it("prefills the last directory used on this host", () => {
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    expect(readLastDir("h1")).toBe("/home/u/demo");
    expect(readRecentDirs()).toEqual(["/home/u/demo"]);
    expect(dialog.handleSpawned(spawns[0]?.req ?? "")).toBe(true);
    dialog.open(root);
    expect(query<HTMLInputElement>("#new-directory").value).toBe("/home/u/demo");
    // Other hosts start empty: memory is per host.
    dialog.setHostId("h2");
    dialog.close();
    dialog.open(root);
    expect(query<HTMLInputElement>("#new-directory").value).toBe("");
  });

  it("closes on a matching spawned and ignores other reqs", () => {
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleSpawned("other")).toBe(false);
    expect(dialog.isOpen).toBe(true);
    expect(dialog.handleSpawned(req)).toBe(true);
    expect(dialog.isOpen).toBe(false);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("shows a host path error beside the directory field and keeps the form", () => {
    query<HTMLInputElement>("#new-directory").value = "/home/u/nope";
    query<HTMLInputElement>("#new-name").value = "build";
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleError("unknown workdir: /home/u/nope", req, "unknown_project")).toBe(true);
    const error = query<HTMLElement>("#new-directory-error");
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("unknown workdir: /home/u/nope");
    expect(dialog.isOpen).toBe(true);
    expect(query<HTMLInputElement>("#new-name").value).toBe("build");
    expect(query<HTMLInputElement>("#new-directory").value).toBe("/home/u/nope");
  });

  it("shows other errors above the actions", () => {
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    const req = spawns[0]?.req ?? "";
    expect(dialog.handleError("spawn_failed: harness exited", req, "spawn_failed")).toBe(true);
    expect(query("#new-error").textContent).toBe("spawn_failed: harness exited");
    expect(dialog.handleError("late", req, "internal")).toBe(false);
  });

  it("says so when the frame cannot be sent", () => {
    connected = false;
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    expect(query("#new-error").textContent).toBe("Not connected");
    expect(dialog.isOpen).toBe(true);
  });

  it("fills the harness picker when the catalog arrives late", () => {
    catalog.clear();
    expect(query<HTMLOptionElement>("#new-cli option").textContent).toBe("No harnesses");
    catalog.replace(CATALOG);
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("muse");
    expect(query<HTMLInputElement>("#new-yolo").disabled).toBe(false);
  });

  it("closes from the close button", () => {
    query<HTMLButtonElement>("#new-close").click();
    expect(dialog.isOpen).toBe(false);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });
});
