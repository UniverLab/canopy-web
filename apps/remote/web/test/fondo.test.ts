// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { fondoScript } from "../../../graphs/src/pages/look.js";
import { FONDO_ASSETS, syncHeaderFondo } from "../src/fondo.js";
import type { FondoHandle } from "../src/fondo.js";

const HEADER = `<header class="topbar"><div class="fondo" id="fondo" aria-hidden="true"></div><div class="topbar-inner"></div></header>`;

/** A repaint detaches the old host and paints a fresh header. */
function repaint(root: HTMLElement): void {
  root.innerHTML = HEADER;
}

function mounted(root: HTMLElement): HTMLElement {
  repaint(root);
  return root;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function probingMount(): {
  mount: ReturnType<typeof vi.fn>;
  destroys: ReturnType<typeof vi.fn>[];
  hosts: HTMLElement[];
} {
  const destroys: ReturnType<typeof vi.fn>[] = [];
  const hosts: HTMLElement[] = [];
  const mount = vi.fn((host: HTMLElement): FondoHandle => {
    hosts.push(host);
    const destroy = vi.fn();
    destroys.push(destroy);
    return { destroy: () => destroy() };
  });
  return { mount, destroys, hosts };
}

describe("syncHeaderFondo", () => {
  let root: HTMLElement;

  afterEach(() => {
    // A host-less sync tears the live mount down and invalidates pending
    // ones, so tests never leak mounts into each other.
    syncHeaderFondo(document.createElement("div"), () => null);
    root?.remove();
  });

  it("mounts on the header band's host", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    const { mount, hosts } = probingMount();
    syncHeaderFondo(root, mount);
    await tick();
    expect(mount).toHaveBeenCalledTimes(1);
    const host = hosts[0] as HTMLElement;
    expect(host.id).toBe("fondo");
    expect(host.parentElement?.className).toBe("topbar");
    expect(host.getAttribute("aria-hidden")).toBe("true");
  });

  it("mounts from the same asset base as the graphs header", () => {
    expect(fondoScript()).toContain(FONDO_ASSETS);
    expect(FONDO_ASSETS).toBe("/look/fondo/assets/");
  });

  it("destroys the previous mount before remounting on a repaint", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    const { mount, destroys } = probingMount();
    syncHeaderFondo(root, mount);
    await tick();
    repaint(root);
    syncHeaderFondo(root, mount);
    await tick();
    expect(mount).toHaveBeenCalledTimes(2);
    expect(destroys).toHaveLength(2);
    expect(destroys[0]).toHaveBeenCalledTimes(1);
    expect(destroys[1]).not.toHaveBeenCalled();
  });

  it("destroys a superseded async mount instead of keeping it", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    let release!: (handle: FondoHandle) => void;
    const gate = new Promise<FondoHandle>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn((): Promise<FondoHandle> => gate);
    syncHeaderFondo(root, slow);
    // A second repaint wins the race before the first mount lands.
    repaint(root);
    const { mount } = probingMount();
    syncHeaderFondo(root, mount);
    const orphanDestroy = vi.fn();
    release({ destroy: () => orphanDestroy() });
    await tick();
    await tick();
    expect(orphanDestroy).toHaveBeenCalledTimes(1);
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("mounts nothing when the repaint carries no host", async () => {
    root = document.body.appendChild(document.createElement("div"));
    root.innerHTML = `<header class="topbar"><div class="topbar-inner"></div></header>`;
    const { mount } = probingMount();
    syncHeaderFondo(root, mount);
    await tick();
    expect(mount).not.toHaveBeenCalled();
  });

  it("destroys the orphan when its host leaves the document", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    const { mount, destroys } = probingMount();
    syncHeaderFondo(root, mount);
    root.innerHTML = `<p>no header anymore</p>`;
    await tick();
    expect(destroys).toHaveLength(1);
    expect(destroys[0]).toHaveBeenCalledTimes(1);
  });

  it("leaves a rejected mount flat without throwing", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    const failing = vi.fn((): FondoHandle => {
      throw new Error("kit failed");
    });
    expect(() => syncHeaderFondo(root, failing)).not.toThrow();
    await tick();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("tears the live mount down when the repaint carries no host", async () => {
    root = mounted(document.body.appendChild(document.createElement("div")));
    const { mount, destroys } = probingMount();
    syncHeaderFondo(root, mount);
    await tick();
    syncHeaderFondo(document.createElement("div"), mount);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(destroys[0]).toHaveBeenCalledTimes(1);
  });
});
