// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectFailMessage } from "../src/peer.js";
import { consumePairFragment, createApp } from "../src/ui.js";
import type { AppUi, PairSubmit } from "../src/ui.js";

describe("consumePairFragment", () => {
  it("takes the code and removes the fragment", () => {
    globalThis.location.hash = "#7K3QH-M9P2X";
    expect(consumePairFragment()).toBe("7K3QH-M9P2X");
    expect(globalThis.location.hash).toBe("");
  });

  it("returns null without a fragment", () => {
    globalThis.location.hash = "";
    expect(consumePairFragment()).toBeNull();
  });
});

describe("createApp", () => {
  let root: HTMLDivElement;
  let app: AppUi;
  let pairs: PairSubmit[];
  let connected: string[];
  let disconnects: number;
  let retries: number;
  let pairAgains: number;

  const query = <T extends Element>(selector: string): T => {
    const el = root.querySelector(selector);
    if (!el) {
      throw new Error(`missing ${selector}`);
    }
    return el as T;
  };

  const submitForm = () => {
    query<HTMLFormElement>("#pair-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  };

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    pairs = [];
    connected = [];
    disconnects = 0;
    retries = 0;
    pairAgains = 0;
    app = createApp(root, {
      onPair: (submit) => pairs.push(submit),
      onConnect: (hostId) => connected.push(hostId),
      onDisconnect: () => {
        disconnects += 1;
      },
      onRetry: () => {
        retries += 1;
      },
      onPairAgain: () => {
        pairAgains += 1;
      },
    });
  });

  afterEach(() => {
    root.remove();
    document.body.innerHTML = "";
  });

  it("prefills the code and the device label on the pair form", () => {
    app.showPair("7K3QH-M9P2X");
    expect(query<HTMLInputElement>("#pair-code").value).toBe("7K3QH-M9P2X");
    expect(query<HTMLInputElement>("#pair-label").value).toContain(" on ");
  });

  it("preselects the host when exactly one is online", () => {
    app.showPair();
    app.setOnlineHosts([{ host_id: "h1", label: "Host one" }]);
    const select = query<HTMLSelectElement>("#pair-host");
    expect(select.value).toBe("h1");
    expect(select.options).toHaveLength(1);
  });

  it("asks which host when several are online", () => {
    app.showPair();
    app.setOnlineHosts([
      { host_id: "h1", label: "Host one" },
      { host_id: "h2", label: "Host two" },
    ]);
    const select = query<HTMLSelectElement>("#pair-host");
    expect(select.value).toBe("");
    expect(select.options).toHaveLength(3);
    expect(select.options[0]?.textContent).toContain("Choose a host");
  });

  it("keeps the typed code when the host list refreshes", () => {
    app.showPair();
    query<HTMLInputElement>("#pair-code").value = "7K3QH-M9P";
    app.setOnlineHosts([{ host_id: "h1", label: "Host one" }]);
    expect(query<HTMLInputElement>("#pair-code").value).toBe("7K3QH-M9P");
  });

  it("submits the pair form", () => {
    app.showPair();
    app.setOnlineHosts([{ host_id: "h1", label: "Host one" }]);
    query<HTMLInputElement>("#pair-code").value = "7K3QH-M9P2X";
    submitForm();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.hostId).toBe("h1");
    expect(pairs[0]?.code).toBe("7K3QH-M9P2X");
    expect(pairs[0]?.label).toContain(" on ");
  });

  it("refuses to submit without a code", () => {
    app.showPair();
    app.setOnlineHosts([{ host_id: "h1", label: "Host one" }]);
    submitForm();
    expect(pairs).toHaveLength(0);
    expect(query("#pair-error").textContent).toBe("Enter the pairing code");
  });

  it("refuses to submit without a host", () => {
    app.showPair();
    app.setOnlineHosts([]);
    query<HTMLInputElement>("#pair-code").value = "7K3QH-M9P2X";
    submitForm();
    expect(pairs).toHaveLength(0);
    expect(query("#pair-error").textContent).toBe("No hosts online");
  });

  it("shows pair errors and the busy state", () => {
    app.showPair();
    app.setPairError("Wrong code");
    expect(query("#pair-error").textContent).toBe("Wrong code");
    app.setPairBusy(true);
    expect(query<HTMLButtonElement>("#pair-form button[type=submit]").disabled).toBe(true);
    expect(query<HTMLInputElement>("#pair-code").disabled).toBe(true);
    app.setPairBusy(false);
    expect(query<HTMLButtonElement>("#pair-form button[type=submit]").disabled).toBe(false);
  });

  it("lists paired hosts with connect buttons", () => {
    app.setPairedHosts([
      { host_id: "h1", host_spki: "s1", label: "Host one" },
      { host_id: "h2", host_spki: "s2", label: "Host two" },
    ]);
    app.showHosts();
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-connect]")];
    expect(buttons).toHaveLength(2);
    buttons[1]?.click();
    expect(connected).toEqual(["h2"]);
    query<HTMLButtonElement>("#pair-new").click();
    expect(pairAgains).toBe(1);
  });

  it("shows the connection state with retry on failure", () => {
    app.showSession("Host one");
    expect(query("#conn-state").textContent).toBe("connecting");
    app.setConnectionState("connected");
    expect(query("#conn-state").textContent).toBe("connected");
    expect(root.querySelector("#conn-retry")).toBeNull();
    app.setConnectionState("failed: Too many devices connected");
    expect(query("#conn-state").textContent).toBe("failed: Too many devices connected");
    query<HTMLButtonElement>("#conn-retry").click();
    expect(retries).toBe(1);
    expect(root.querySelector("#conn-pair-again")).toBeNull();
    query<HTMLButtonElement>("#conn-disconnect").click();
    expect(disconnects).toBe(1);
  });

  it("offers to pair again when the browser is no longer paired", () => {
    app.showSession("Host one");
    app.setConnectionState(`failed: ${connectFailMessage("unknown_device")}`);
    query<HTMLButtonElement>("#conn-pair-again").click();
    expect(pairAgains).toBe(1);
  });
});
