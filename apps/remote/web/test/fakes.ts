// SPDX-License-Identifier: Apache-2.0
// Test fakes: relay WebSocket, WebRTC peer connection, TURN fetch, page
// visibility. The relay and the network are always faked in tests.

import { b64encode, idFromSpki } from "../src/crypto.js";
import { RelaySocket } from "../src/relay.js";
import type { HostRecord } from "../src/store.js";

export interface SentEnvelope {
  to: string;
  body: Record<string, unknown>;
}

export class FakeWebSocket {
  readonly url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly sent: string[] = [];

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(from: string, body: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ from, body }) }));
  }

  receiveRaw(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
    this.close();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  envelopes(): SentEnvelope[] {
    return this.sent.map((raw) => JSON.parse(raw) as SentEnvelope);
  }
}

export interface RelayHarness {
  relay: RelaySocket;
  sockets: FakeWebSocket[];
  latest: () => FakeWebSocket;
}

export function createRelayHarness(): RelayHarness {
  const sockets: FakeWebSocket[] = [];
  const relay = new RelaySocket("wss://test.invalid/ws/device", (url) => {
    const ws = new FakeWebSocket(url);
    sockets.push(ws);
    return ws as unknown as WebSocket;
  });
  return {
    relay,
    sockets,
    latest: () => {
      const ws = sockets[sockets.length - 1];
      if (!ws) {
        throw new Error("no socket created yet");
      }
      return ws;
    },
  };
}

export async function connectRelay(harness: RelayHarness): Promise<FakeWebSocket> {
  const opened = harness.relay.connect();
  harness.latest().open();
  await opened;
  return harness.latest();
}

export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Waits for the socket's first send. The budget is wall-clock, not a tick
// count: the pairing handshake derives K_pair (600k-iteration PBKDF2) before
// it can send anything, and a loaded machine makes that slow enough to outlast
// a fixed number of timer ticks.
export async function waitForSend(ws: FakeWebSocket, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ws.sent.length === 0 && Date.now() < deadline) {
    await flush();
  }
  if (ws.sent.length === 0) {
    throw new Error("timed out waiting for a relay send");
  }
}

export class FakeDataChannel {
  readonly label: string;
  readonly ordered: boolean;
  readyState = "connecting";
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(label: string, options?: { ordered?: boolean }) {
    this.label = label;
    this.ordered = options?.ordered ?? false;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === "closed") {
      return;
    }
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
  }

  remoteOpen(): void {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  deliver(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

export class FakePeerConnection {
  readonly config: RTCConfiguration;
  localDescription: { type: string; sdp?: string } | null = null;
  remoteDescription: { type: string; sdp?: string } | null = null;
  connectionState = "new";
  onconnectionstatechange: ((ev: Event) => void) | null = null;
  onicecandidate: ((ev: { candidate: { toJSON: () => unknown } | null }) => void) | null = null;
  readonly channels: FakeDataChannel[] = [];
  readonly addedCandidates: unknown[] = [];
  readonly offerSdp: string;
  closed = false;

  constructor(config: RTCConfiguration, offerSdp?: string) {
    this.config = config;
    this.offerSdp = offerSdp ?? "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";
  }

  createDataChannel(label: string, options?: { ordered?: boolean }): RTCDataChannel {
    const channel = new FakeDataChannel(label, options);
    this.channels.push(channel);
    return channel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: "offer", sdp: this.offerSdp };
  }

  async setLocalDescription(desc: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: { type: string; sdp?: string }): Promise<void> {
    this.remoteDescription = desc;
  }

  async addIceCandidate(init: unknown): Promise<void> {
    this.addedCandidates.push(init);
  }

  close(): void {
    this.closed = true;
    for (const channel of this.channels) {
      channel.close();
    }
  }

  firstChannel(): FakeDataChannel {
    const channel = this.channels[0];
    if (!channel) {
      throw new Error("no data channel created yet");
    }
    return channel;
  }

  emitIceCandidate(init: Record<string, unknown>): void {
    this.onicecandidate?.({ candidate: { toJSON: () => init } });
  }

  setConnectionState(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
  }
}

export interface PeerHarness {
  peers: FakePeerConnection[];
  factory: (config: RTCConfiguration) => RTCPeerConnection;
  latest: () => FakePeerConnection;
}

export function createPeerHarness(offerSdp?: string): PeerHarness {
  const peers: FakePeerConnection[] = [];
  return {
    peers,
    factory: (config) => {
      const pc = new FakePeerConnection(config, offerSdp);
      peers.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    latest: () => {
      const pc = peers[peers.length - 1];
      if (!pc) {
        throw new Error("no peer connection created yet");
      }
      return pc;
    },
  };
}

export function createTurnFetcher(ok = true): {
  calls: string[];
  fetchTurn: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetchTurn: async (url: string) => {
      calls.push(url);
      return {
        ok,
        json: async () => ({ iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] }),
      };
    },
  };
}

export interface TestHost {
  record: HostRecord;
  privateKey: CryptoKey;
}

export async function createTestHost(label = "test host"): Promise<TestHost> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    record: { host_id: await idFromSpki(spki), host_spki: b64encode(spki), label },
    privateKey: pair.privateKey,
  };
}

export async function signTestAnswer(
  privateKey: CryptoKey,
  deviceId: string,
  offerSig: string,
  sdp: string,
): Promise<string> {
  const sig = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`canopy-remote/v1/answer\n${deviceId}\n${offerSig}\n${sdp}`),
  );
  return b64encode(new Uint8Array(sig));
}

export interface VisibilityHarness {
  visibility: { isVisible: () => boolean; onChange: (callback: () => void) => () => void };
  setVisible: (visible: boolean) => void;
}

// sessionStorage stand-in for the Prompt Builder draft: in memory, with
// switches for the browsers that throw on read or write.
export class FakeStorage {
  readonly map = new Map<string, string>();
  failReads = false;
  failWrites = false;

  getItem(key: string): string | null {
    if (this.failReads) {
      throw new Error("storage read denied");
    }
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error("storage write denied");
    }
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrites) {
      throw new Error("storage write denied");
    }
    this.map.delete(key);
  }

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  clear(): void {
    this.map.clear();
  }
}

export function createVisibilityHarness(initial = true): VisibilityHarness {
  let visible = initial;
  const listeners = new Set<() => void>();
  return {
    visibility: {
      isVisible: () => visible,
      onChange: (callback: () => void) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    setVisible: (next: boolean) => {
      visible = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}
