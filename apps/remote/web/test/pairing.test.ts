// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { b64decode, b64encode, derivePairKey, generateDeviceKey, pairOkMac } from "../src/crypto.js";
import type { DeviceKey } from "../src/crypto.js";
import { defaultDeviceLabel, runPairing } from "../src/pairing.js";
import type { PairingDeps } from "../src/pairing.js";
import type { HostRecord } from "../src/store.js";
import { connectRelay, createRelayHarness, flush, waitForSend } from "./fakes.js";
import type { FakeWebSocket, RelayHarness } from "./fakes.js";
import {
  CODE,
  CODE_NORMALIZED,
  DEVICE_ID,
  DEVICE_SPKI_B64,
  HOST_ID,
  HOST_SPKI_B64,
  MAC_INIT,
  MAC_OK,
  nonceB,
  nonceH,
} from "./vectors.js";

let vectorDevice: DeviceKey;

beforeAll(async () => {
  const real = await generateDeviceKey();
  vectorDevice = {
    ...real,
    spki: b64decode(DEVICE_SPKI_B64),
    spkiB64: DEVICE_SPKI_B64,
    deviceId: DEVICE_ID,
  };
});

interface PairingSetup {
  harness: RelayHarness;
  ws: FakeWebSocket;
  saved: HostRecord[];
}

async function setupPairing(): Promise<PairingSetup> {
  const harness = createRelayHarness();
  const ws = await connectRelay(harness);
  return { harness, ws, saved: [] };
}

function pairOptions(setup: PairingSetup, overrides?: Partial<PairingDeps>) {
  return {
    relay: setup.harness.relay,
    hostId: HOST_ID,
    hostLabel: "canopy",
    code: CODE,
    deviceLabel: "Test browser",
    device: vectorDevice,
    saveHost: async (host: HostRecord) => {
      setup.saved.push(host);
    },
    randomNonce: nonceB,
    ...overrides,
  };
}

const pairOkBody = () => ({
  t: "pair_ok",
  host_spki: HOST_SPKI_B64,
  nonce_h: b64encode(nonceH()),
  mac: MAC_OK,
});

describe("runPairing", () => {
  it("sends pair_init with mac_init and stores the host on the mac_ok pair_ok", async () => {
    const setup = await setupPairing();
    const pending = runPairing(pairOptions(setup));
    await waitForSend(setup.ws);
    const [envelope] = setup.ws.envelopes();
    expect(envelope?.to).toBe(`h:${HOST_ID}`);
    expect(envelope?.body).toEqual({
      t: "pair_init",
      device_spki: DEVICE_SPKI_B64,
      device_label: "Test browser",
      nonce_b: b64encode(nonceB()),
      mac: MAC_INIT,
    });
    // The code never leaves the page.
    expect(setup.ws.sent.join("\n")).not.toContain("7K3QH");
    expect(setup.ws.sent.join("\n")).not.toContain(CODE_NORMALIZED);
    setup.ws.receive(`h:${HOST_ID}`, pairOkBody());
    await expect(pending).resolves.toEqual({
      host_id: HOST_ID,
      host_spki: HOST_SPKI_B64,
      label: "canopy",
    });
    expect(setup.saved).toEqual([{ host_id: HOST_ID, host_spki: HOST_SPKI_B64, label: "canopy" }]);
  });

  it.each([
    ["no_code", "No pairing code is open on this host"],
    ["expired", "The code expired; create a new one in canopy"],
    ["bad_code", "Wrong code"],
    ["weird", "Pairing failed (weird)"],
  ])("maps pair_fail %s", async (reason, message) => {
    const setup = await setupPairing();
    const pending = runPairing(pairOptions(setup));
    const assertion = expect(pending).rejects.toThrow(message);
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${HOST_ID}`, { t: "pair_fail", reason });
    await assertion;
    expect(setup.saved).toHaveLength(0);
  });

  it("refuses a pair_ok with a bad mac", async () => {
    const setup = await setupPairing();
    const pending = runPairing(pairOptions(setup));
    const assertion = expect(pending).rejects.toThrow("Host identity check failed");
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${HOST_ID}`, { ...pairOkBody(), mac: MAC_INIT });
    await assertion;
    expect(setup.saved).toHaveLength(0);
  });

  it("refuses a host_spki that does not match the host id", async () => {
    const setup = await setupPairing();
    const key = await derivePairKey(CODE_NORMALIZED, HOST_ID);
    const mac = await pairOkMac(
      key,
      DEVICE_SPKI_B64,
      DEVICE_SPKI_B64,
      b64encode(nonceB()),
      b64encode(nonceH()),
    );
    const pending = runPairing(pairOptions(setup));
    const assertion = expect(pending).rejects.toThrow("Host identity check failed");
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${HOST_ID}`, {
      t: "pair_ok",
      host_spki: DEVICE_SPKI_B64,
      nonce_h: b64encode(nonceH()),
      mac,
    });
    await assertion;
  });

  it("maps an undecodable host_spki to the identity check failure", async () => {
    const setup = await setupPairing();
    const key = await derivePairKey(CODE_NORMALIZED, HOST_ID);
    const badSpki = "!!!not-base64!!!";
    const mac = await pairOkMac(
      key,
      badSpki,
      DEVICE_SPKI_B64,
      b64encode(nonceB()),
      b64encode(nonceH()),
    );
    const pending = runPairing(pairOptions(setup));
    const assertion = expect(pending).rejects.toThrow("Host identity check failed");
    await waitForSend(setup.ws);
    setup.ws.receive(`h:${HOST_ID}`, {
      t: "pair_ok",
      host_spki: badSpki,
      nonce_h: b64encode(nonceH()),
      mac,
    });
    await assertion;
    expect(setup.saved).toHaveLength(0);
  });

  it("rejects a malformed code without sending", async () => {
    const setup = await setupPairing();
    await expect(runPairing(pairOptions(setup, { code: "bogus" }))).rejects.toThrow(
      "Invalid pairing code",
    );
    expect(setup.ws.sent).toHaveLength(0);
  });

  it("times out when the host never answers", async () => {
    const setup = await setupPairing();
    await expect(runPairing(pairOptions(setup, { timeoutMs: 1 }))).rejects.toThrow(
      "Pairing timed out",
    );
  });

  it("ignores frames that are not the host reply", async () => {
    const setup = await setupPairing();
    const pending = runPairing(pairOptions(setup));
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitForSend(setup.ws);
    setup.ws.receive("relay", { t: "hosts", items: [] });
    setup.ws.receive("h:other", pairOkBody());
    await flush();
    await flush();
    expect(settled).toBe(false);
    setup.ws.receive(`h:${HOST_ID}`, pairOkBody());
    await expect(pending).resolves.toBeDefined();
  });
});

describe("defaultDeviceLabel", () => {
  it("looks like <browser> on <platform>", () => {
    expect(defaultDeviceLabel()).toContain(" on ");
  });
});
