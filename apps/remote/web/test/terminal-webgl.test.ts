// SPDX-License-Identifier: Apache-2.0
// WebGL is an optimisation: a failed load or a lost context must leave the
// terminal on xterm's DOM renderer instead of showing a blank card.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FakeWebglAddon {
    static instances: FakeWebglAddon[] = [];
    disposed = 0;
    loss: (() => void) | null = null;
    constructor(public preserveDrawingBuffer?: boolean) {
      FakeWebglAddon.instances.push(this);
    }
    onContextLoss = (callback: () => void): { dispose: () => void } => {
      this.loss = callback;
      return { dispose: () => {} };
    };
    dispose = (): void => {
      this.disposed += 1;
    };
  }
  return { FakeWebglAddon };
});

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: mocks.FakeWebglAddon }));

import { attachWebgl } from "../src/terminal-webgl.js";

function fakeTerminal(throwOnLoad = false) {
  return {
    loadAddon: vi.fn(() => {
      if (throwOnLoad) {
        throw new Error("WebGL is not available");
      }
    }),
  };
}

describe("attachWebgl", () => {
  beforeEach(() => {
    mocks.FakeWebglAddon.instances.length = 0;
  });

  it("loads the addon bare, after open()", () => {
    const terminal = fakeTerminal();
    const addon = attachWebgl(terminal);
    expect(addon).not.toBeNull();
    expect(mocks.FakeWebglAddon.instances).toHaveLength(1);
    // The 0.18.0 constructor takes preserveDrawingBuffer, not options.
    expect(mocks.FakeWebglAddon.instances[0]?.preserveDrawingBuffer).toBeUndefined();
    expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("keeps the DOM renderer when the addon fails to load", () => {
    const terminal = fakeTerminal(true);
    const onFallback = vi.fn();
    expect(attachWebgl(terminal, onFallback)).toBeNull();
    expect(onFallback).toHaveBeenCalledTimes(1);
    // The failed addon is disposed; xterm still has its DOM renderer.
    expect(mocks.FakeWebglAddon.instances[0]?.disposed).toBe(1);
  });

  it("disposes the addon on context loss", () => {
    const terminal = fakeTerminal();
    const onFallback = vi.fn();
    attachWebgl(terminal, onFallback);
    const addon = mocks.FakeWebglAddon.instances[0];
    addon?.loss?.();
    expect(addon?.disposed).toBe(1);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});
