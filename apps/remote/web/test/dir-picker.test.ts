// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DirList } from "../src/dir-protocol.js";
import { DirPicker, joinChildPath, pathSegments, visibleDirs } from "../src/dir-picker.js";
import type { DirPickerDeps } from "../src/dir-picker.js";

interface SentList {
  path: string | undefined;
  req: string;
}

function setup(startPath: string | null = "/home/u", recent: string[] = ["/recent/a"]): {
  root: HTMLDivElement;
  picker: DirPicker;
  sent: SentList[];
  picked: string[];
  canceled: number;
  answer: (path: string, parent: string | null, names?: string[], truncated?: boolean) => void;
  answerReq: (index: number, list: Partial<DirList> & { path: string }) => void;
} {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const sent: SentList[] = [];
  const picked: string[] = [];
  let canceled = 0;
  const deps: DirPickerDeps = {
    startPath: () => startPath,
    recent: () => recent,
    onList: (path, req) => {
      sent.push({ path, req });
      return true;
    },
    onPick: (path) => picked.push(path),
    onCancel: () => {
      canceled += 1;
    },
  };
  const picker = new DirPicker(deps);
  picker.mount(root);
  const answerReq = (index: number, list: Partial<DirList> & { path: string }): void => {
    const req = sent[index]?.req;
    if (req === undefined) {
      throw new Error(`missing sent request ${index}`);
    }
    picker.handleList({
      req,
      parent: null,
      dirs: [],
      truncated: false,
      ...list,
    });
  };
  const answer = (path: string, parent: string | null, names: string[] = [], truncated = false): void => {
    answerReq(sent.length - 1, { path, parent, dirs: names.map((name) => ({ name })), truncated });
  };
  return { root, picker, sent, picked, get canceled() { return canceled; }, answer, answerReq };
}

describe("dir picker paths", () => {
  it("splits an absolute path into tappable segments", () => {
    expect(pathSegments("/")).toEqual([{ label: "/", path: "/" }]);
    expect(pathSegments("/home/u/demo/")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "u", path: "/home/u" },
      { label: "demo", path: "/home/u/demo" },
    ]);
    expect(pathSegments("relative")).toEqual([{ label: "relative", path: "relative" }]);
  });

  it("joins only the host-returned parent and child name", () => {
    expect(joinChildPath("/", "home")).toBe("/home");
    expect(joinChildPath("/home/u", "demo")).toBe("/home/u/demo");
    expect(joinChildPath("/home/u/", "demo")).toBe("/home/u/demo");
  });

  it("hides dot folders and never offers . or .. as rows", () => {
    const dirs = [{ name: "." }, { name: ".." }, { name: ".config" }, { name: "demo" }];
    expect(visibleDirs(dirs, false)).toEqual([{ name: "demo" }]);
    expect(visibleDirs(dirs, true)).toEqual([{ name: ".config" }, { name: "demo" }]);
  });
});

describe("DirPicker", () => {
  let root: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    root?.remove();
    root = null;
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("paints the breadcrumb, rows and footer for the answered folder", () => {
    const s = setup();
    root = s.root;
    s.answer("/home/u/demo", "/home/u", ["src", "docs"]);
    const crumbs = [...s.root.querySelectorAll<HTMLButtonElement>(".dir-crumb")];
    expect(crumbs.map((crumb) => crumb.dataset.dirPath)).toEqual([
      "/",
      "/home",
      "/home/u",
      "/home/u/demo",
    ]);
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(["/", "home", "u", "demo"]);
    expect(s.root.querySelector("#dir-use")?.textContent).toBe("Use this folder · demo");
    expect([...s.root.querySelectorAll(".dir-row-item")].map((row) => row.textContent)).toEqual([
      "src",
      "docs",
    ]);
    expect(s.root.querySelector(".dir-up")?.getAttribute("data-dir-path")).toBe("/home/u");
  });

  it("filters dot folders until Show hidden is switched on", () => {
    const s = setup();
    root = s.root;
    s.answer("/home/u", "/home", [".config", "demo"]);
    expect([...s.root.querySelectorAll(".dir-row-item")].map((row) => row.textContent)).toEqual([
      "demo",
    ]);
    const toggle = s.root.querySelector<HTMLInputElement>("#dir-hidden");
    expect(toggle).not.toBeNull();
    toggle!.checked = true;
    toggle!.dispatchEvent(new Event("change", { bubbles: true }));
    expect([...s.root.querySelectorAll(".dir-row-item")].map((row) => row.textContent)).toEqual([
      ".config",
      "demo",
    ]);
  });

  it("ignores an answer older than the pending request", () => {
    const s = setup();
    root = s.root;
    s.answer("/home/u", "/home", ["demo"]);
    s.root.querySelector<HTMLButtonElement>('.dir-row-item[data-dir-path="/home/u/demo"]')?.click();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]?.path).toBe("/home/u/demo");
    // The first request's late answer must not replace the folder being loaded.
    s.answerReq(0, { path: "/stale", parent: "/", dirs: [{ name: "stale" }] });
    expect(s.root.querySelector("#dir-crumbs")?.textContent).not.toContain("stale");
    s.answerReq(1, { path: "/home/u/demo", parent: "/home/u", dirs: [{ name: "src" }] });
    expect(s.root.querySelector("#dir-crumbs")?.textContent).toContain("demo");
    expect(s.root.querySelector(".dir-row-item")?.textContent).toContain("src");
  });

  it("falls back to home once when the start path fails, then clears on navigation", () => {
    const s = setup("/missing");
    root = s.root;
    expect(s.sent[0]?.path).toBe("/missing");
    expect(s.picker.handleError("no such directory", s.sent[0]?.req ?? null)).toBe(true);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]?.path).toBeUndefined();
    const error = s.root.querySelector<HTMLElement>("#dir-error");
    expect(error?.hidden).toBe(false);
    expect(error?.textContent).toBe("no such directory");
    s.answerReq(1, { path: "/home/u", parent: "/home", dirs: [{ name: "demo" }] });
    // The start failure stays visible until the user's next navigation.
    expect(s.root.querySelector<HTMLElement>("#dir-error")?.hidden).toBe(false);
    expect(s.root.querySelector("#dir-recent")).not.toBeNull();
    s.root.querySelector<HTMLButtonElement>(".dir-recent-item")?.click();
    expect(s.sent[2]?.path).toBe("/recent/a");
    expect(s.root.querySelector<HTMLElement>("#dir-error")?.hidden).toBe(true);
  });

  it("picks the current folder and cancels back to the form owner", () => {
    const s = setup();
    root = s.root;
    s.answer("/home/u", "/home", ["demo"]);
    s.root.querySelector<HTMLButtonElement>("#dir-use")?.click();
    expect(s.picked).toEqual(["/home/u"]);
    s.root.querySelector<HTMLButtonElement>("#dir-cancel")?.click();
    expect(s.canceled).toBe(1);
  });
});
