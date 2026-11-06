// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogStore } from "../src/catalog.js";
import { readLastDir, readRecentDirs } from "../src/dir-history.js";
import { NewDialog, YOLO_HINT } from "../src/new-dialog.js";
import type { Catalog, ResumableSession, SessionItem } from "../src/protocol.js";
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
    kind: "agent",
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

  it("yolo_disabled_when_unsupported", () => {
    expect(query<HTMLInputElement>("#new-yolo").disabled).toBe(false);
    expect(query<HTMLElement>("#new-yolo-hint").hidden).toBe(true);
    changeSelect("#new-cli", "claude");
    expect(query<HTMLInputElement>("#new-yolo").disabled).toBe(true);
    const hint = query<HTMLElement>("#new-yolo-hint");
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe(YOLO_HINT);
    changeSelect("#new-cli", "muse");
    expect(query<HTMLInputElement>("#new-yolo").disabled).toBe(false);
    expect(query<HTMLElement>("#new-yolo-hint").hidden).toBe(true);
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
    expect(dialog.handleSpawned(spawns[0]?.req ?? "")).toBe("");
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
    expect(dialog.handleSpawned("other")).toBeNull();
    expect(dialog.isOpen).toBe(true);
    expect(dialog.handleSpawned(req)).toBe("");
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

  it("dialog_offers_only_installed_harnesses", () => {
    const offered = () =>
      [...root.querySelectorAll<HTMLOptionElement>("#new-cli option")].map((option) => option.value);
    // An old host never names its harnesses: everything the catalog carries.
    expect(offered()).toEqual(["muse", "claude"]);
    // Hello names claude only: the picker and the default follow at once.
    catalog.setInstalledHarnesses(["claude"]);
    expect(offered()).toEqual(["claude"]);
    expect(query<HTMLSelectElement>("#new-cli").value).toBe("claude");
    // A submit now can only name an installed harness: no Create-then-error.
    query<HTMLInputElement>("#new-directory").value = "/home/u/demo";
    submit();
    expect(spawns[0]?.spawn.cli).toBe("claude");
    // Known-none: the picker says so and offers nothing to spawn.
    catalog.setInstalledHarnesses([]);
    expect(query<HTMLOptionElement>("#new-cli option").textContent).toBe("No harnesses");
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

  it("directory_label_has_space", () => {
    const labelText = (): string =>
      query<HTMLInputElement>("#new-directory")?.closest("label")?.textContent ?? "";
    expect(labelText()).toContain("📁 Directory");
    pickKind("terminal");
    expect(labelText()).toContain("📁 Directory");
  });
});

describe("NewDialog Resume mode", () => {
  let root: HTMLDivElement;
  let catalog: CatalogStore;
  let dialog: NewDialog;
  let listed: string[];
  let resumes: { id: string; req: string }[];
  let connected: boolean;

  const ROWS: ResumableSession[] = [
    {
      id: "past-a",
      name: "refactor the parser",
      cli: "muse",
      workdir: "/home/u/demo",
      started_at: Date.now() - 60_000,
      has_conversation: true,
    },
    {
      id: "past-b",
      name: "docs pass",
      cli: "claude",
      workdir: "/home/u/other",
      started_at: Date.now() - 3_600_000,
      has_conversation: false,
    },
  ];

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  const pickMode = (mode: string): void => {
    const el = query<HTMLInputElement>(`input[name="mode"][value="${mode}"]`);
    el.checked = true;
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
    listed = [];
    resumes = [];
    connected = true;
    dialog = new NewDialog(
      catalog,
      {
        onSpawn: () => connected,
        onResumableList: (req) => {
          listed.push(req);
          return connected;
        },
        onResume: (id, req) => {
          resumes.push({ id, req });
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

  it("offers no Resume on a host that does not speak it", () => {
    expect(root.querySelector("#new-mode-resume")).toBeNull();
    expect(root.querySelector('input[name="mode"]')).toBeNull();
    expect(query<HTMLInputElement>("#new-kind-agent").checked).toBe(true);
  });

  it("shows the second control for agents, New selected by default", () => {
    dialog.setHasResume(true);
    expect(query<HTMLInputElement>("#new-mode-new").checked).toBe(true);
    expect(query<HTMLInputElement>("#new-mode-resume").checked).toBe(false);
    // New keeps the whole spawn form.
    expect(root.querySelector("#new-cli")).not.toBeNull();
    expect(root.querySelector("#new-prompt")).not.toBeNull();
    // Terminals cannot resume; the control goes away, and comes back.
    pickKind("terminal");
    expect(root.querySelector("#new-mode-resume")).toBeNull();
    pickKind("agent");
    expect(root.querySelector("#new-mode-resume")).not.toBeNull();
  });

  it("Resume hides the spawn fields and asks for the history", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    expect(listed).toHaveLength(1);
    expect(typeof listed[0]).toBe("string");
    for (const selector of [
      "#new-cli",
      "#new-directory",
      "#new-yolo",
      "#new-name",
      "#new-prompt",
      "#new-create",
    ]) {
      expect(root.querySelector(selector), selector).toBeNull();
    }
    expect(root.querySelector("#resume-filter")).not.toBeNull();
    expect(root.querySelector("#resume-list")).not.toBeNull();
    expect(query("#resume-status").textContent).toBe("Loading…");
  });

  it("lists the answer and says so when it is empty", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    dialog.handleResumable(ROWS);
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".resume-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("refactor the parser");
    expect(rows[1]?.textContent).toContain("latest in this folder");
    // A history the host no longer has.
    dialog.handleResumable([]);
    expect(query("#resume-status").textContent).toBe("No past sessions to resume.");
  });

  it("filters the rows as the filter is typed", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    dialog.handleResumable(ROWS);
    const filter = query<HTMLInputElement>("#resume-filter");
    filter.value = "CLAUDE";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    const rows = [...root.querySelectorAll<HTMLButtonElement>(".resume-row")];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset.resumeId).toBe("past-b");
  });

  it("a row sends session_resume, and its spawned closes the dialog", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    dialog.handleResumable(ROWS);
    root.querySelector<HTMLButtonElement>('.resume-row[data-resume-id="past-a"]')?.click();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.id).toBe("past-a");
    const req = resumes[0]?.req ?? "";
    // The list is disabled while the host works.
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".resume-row")].every((row) => row.disabled),
    ).toBe(true);
    // Another spawned is not this resume's.
    expect(dialog.handleSpawned("elsewhere")).toBeNull();
    expect(dialog.isOpen).toBe(true);
    // The shell opens the session through the spawn path: name "" means
    // the store's own row names it.
    expect(dialog.handleSpawned(req)).toBe("");
    expect(dialog.isOpen).toBe(false);
    expect(root.querySelector(".sheet-overlay")).toBeNull();
  });

  it("a host error stays in the dialog above the list and re-enables it", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    dialog.handleResumable(ROWS);
    root.querySelector<HTMLButtonElement>('.resume-row[data-resume-id="past-a"]')?.click();
    const req = resumes[0]?.req ?? "";
    expect(dialog.handleError("host is busy", req, "busy")).toBe(true);
    expect(dialog.isOpen).toBe(true);
    expect(query<HTMLElement>("#resume-error").hidden).toBe(false);
    expect(query("#resume-error-text").textContent).toBe("host is busy");
    expect(
      [...root.querySelectorAll<HTMLButtonElement>(".resume-row")].every((row) => row.disabled),
    ).toBe(false);
  });

  it("a failed history request says so with Retry, and Retry asks again", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    const req = listed[0] ?? "";
    expect(dialog.handleError("could not read the host's history", req, "internal")).toBe(true);
    expect(query("#resume-error-text").textContent).toBe("could not read the host's history");
    query<HTMLButtonElement>("#resume-retry").click();
    expect(listed).toHaveLength(2);
  });

  it("says Not connected when the list cannot be sent", () => {
    connected = false;
    dialog.setHasResume(true);
    pickMode("resume");
    expect(query("#resume-error-text").textContent).toBe("Not connected");
  });

  it("every open starts on New again", () => {
    dialog.setHasResume(true);
    pickMode("resume");
    dialog.close();
    dialog.open(root);
    expect(query<HTMLInputElement>("#new-mode-new").checked).toBe(true);
    expect(root.querySelector("#new-cli")).not.toBeNull();
    expect(root.querySelector("#resume-filter")).toBeNull();
  });
});
