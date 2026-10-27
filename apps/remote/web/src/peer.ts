// SPDX-License-Identifier: Apache-2.0
// WebRTC connection to one host: TURN fetch, signed offer/answer through the
// relay, trickled ICE, one ordered data channel. Single-use: the connection
// manager builds a fresh peer per attempt.

import { b64decode, importSpkiVerifyKey, signOffer, verifyAnswer } from "./crypto.js";
import type { DeviceKey } from "./crypto.js";
import type { RelayFrame, RelaySocket } from "./relay.js";
import type { HostRecord } from "./store.js";

export const DATA_CHANNEL_LABEL = "canopy-session-v1";

export type PeerConnectionFactory = (config: RTCConfiguration) => RTCPeerConnection;
export type TurnFetcher = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function connectFailMessage(reason: string): string {
  if (reason === "unknown_device") {
    return "This browser is no longer paired";
  }
  if (reason === "stale") {
    return "Clock skew: check this device's time";
  }
  if (reason === "busy") {
    return "Too many devices connected";
  }
  return `Connection failed (${reason})`;
}

export type PeerEvent =
  | { type: "open" }
  | { type: "closed" }
  | { type: "failed"; reason: string }
  | { type: "message"; data: string }
  | { type: "ice"; state: string };

export interface PeerDeps {
  relay: RelaySocket;
  host: HostRecord;
  device: DeviceKey;
  fetchTurn?: TurnFetcher;
  createConnection?: PeerConnectionFactory;
  nowMs?: () => number;
}

interface AnswerBody {
  sdp: string;
  sig: string;
}

function asAnswer(body: unknown): AnswerBody | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "answer" || typeof row.sdp !== "string" || typeof row.sig !== "string") {
    return null;
  }
  return { sdp: row.sdp, sig: row.sig };
}

function asIceCandidate(body: unknown): RTCIceCandidateInit | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "ice" || typeof row.candidate !== "object" || row.candidate === null) {
    return null;
  }
  const init = row.candidate as Record<string, unknown>;
  if (typeof init.candidate !== "string") {
    return null;
  }
  return {
    candidate: init.candidate,
    sdpMid: typeof init.sdpMid === "string" ? init.sdpMid : null,
    sdpMLineIndex: typeof init.sdpMLineIndex === "number" ? init.sdpMLineIndex : null,
  };
}

function asConnectFail(body: unknown): string | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const row = body as Record<string, unknown>;
  if (row.t !== "connect_fail" || typeof row.reason !== "string") {
    return null;
  }
  return row.reason;
}

function isBye(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).t === "bye"
  );
}

async function loadIceServers(fetchTurn: TurnFetcher): Promise<RTCIceServer[]> {
  const res = await fetchTurn("/turn");
  if (!res.ok) {
    throw new Error("Could not load TURN credentials");
  }
  const data = await res.json();
  if (Array.isArray(data)) {
    return data as RTCIceServer[];
  }
  if (typeof data === "object" && data !== null) {
    const servers = (data as Record<string, unknown>).iceServers;
    if (Array.isArray(servers)) {
      return servers as RTCIceServer[];
    }
  }
  throw new Error("Could not load TURN credentials");
}

export class HostPeer {
  private readonly relay: RelaySocket;
  private readonly host: HostRecord;
  private readonly device: DeviceKey;
  private readonly fetchTurn: TurnFetcher;
  private readonly createConnection: PeerConnectionFactory;
  private readonly nowMs: () => number;
  private readonly handlers = new Set<(ev: PeerEvent) => void>();
  private readonly queuedCandidates: RTCIceCandidateInit[] = [];
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private unsubscribe: (() => void) | null = null;
  private hostKey: CryptoKey | null = null;
  private offerSig = "";
  private started = false;
  private state: "idle" | "starting" | "open" | "done" = "idle";
  private settleOpen: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(deps: PeerDeps) {
    this.relay = deps.relay;
    this.host = deps.host;
    this.device = deps.device;
    this.fetchTurn = deps.fetchTurn ?? ((url) => globalThis.fetch(url));
    this.createConnection = deps.createConnection ?? ((config) => new RTCPeerConnection(config));
    this.nowMs = deps.nowMs ?? (() => Date.now());
  }

  onEvent(handler: (ev: PeerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(ev: PeerEvent): void {
    for (const handler of this.handlers) {
      handler(ev);
    }
  }

  private get target(): string {
    return `h:${this.host.host_id}`;
  }

  async connect(): Promise<void> {
    if (this.started) {
      throw new Error("Peer is already running");
    }
    this.started = true;
    this.state = "starting";
    try {
      const iceServers = await loadIceServers(this.fetchTurn);
      this.hostKey = await importSpkiVerifyKey(b64decode(this.host.host_spki));
      const pc = this.createConnection({ iceServers });
      this.pc = pc;
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this.channel = channel;
      channel.onopen = () => {
        if (this.state !== "starting") {
          return;
        }
        this.state = "open";
        this.settleOpen?.resolve();
        this.settleOpen = null;
        this.emit({ type: "open" });
      };
      channel.onclose = () => this.remoteClosed();
      channel.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") {
          this.emit({ type: "message", data: ev.data });
        }
      };
      pc.onconnectionstatechange = () => {
        this.emit({ type: "ice", state: pc.connectionState });
      };
      pc.onicecandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (ev.candidate) {
          this.relay.trySend(this.target, { t: "ice", candidate: ev.candidate.toJSON() });
        }
      };
      this.unsubscribe = this.relay.onFrame((frame: RelayFrame) => {
        if (frame.from === this.target) {
          void this.onHostFrame(frame.body);
        }
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp;
      if (!sdp) {
        throw new Error("Could not create an offer");
      }
      const ts = String(Math.floor(this.nowMs() / 1000));
      this.offerSig = await signOffer(this.device.privateKey, this.host.host_id, ts, sdp);
      this.relay.send(this.target, {
        t: "offer",
        device_id: this.device.deviceId,
        ts,
        sdp,
        sig: this.offerSig,
      });
      await new Promise<void>((resolve, reject) => {
        this.settleOpen = { resolve, reject };
      });
    } catch (err) {
      this.teardown(true);
      throw err instanceof Error ? err : new Error("Connection failed");
    }
  }

  // Session-layer frames to the host. False when there is no open data
  // channel; the caller decides whether to retry or drop.
  send(data: string): boolean {
    if (this.state !== "open" || !this.channel || this.channel.readyState !== "open") {
      return false;
    }
    try {
      this.channel.send(data);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.state === "starting") {
      this.settleOpen?.reject(new Error("Connection closed"));
      this.settleOpen = null;
    }
    this.teardown(true);
  }

  private fail(reason: string): void {
    if (this.state === "done") {
      return;
    }
    this.settleOpen?.reject(new Error(reason));
    this.settleOpen = null;
    this.teardown(true);
    this.emit({ type: "failed", reason });
  }

  private remoteClosed(): void {
    if (this.state === "done") {
      return;
    }
    this.settleOpen?.reject(new Error("Connection closed before it opened"));
    this.settleOpen = null;
    this.teardown(false);
    this.emit({ type: "closed" });
  }

  private async onHostFrame(body: unknown): Promise<void> {
    if (this.state === "done" || this.state === "idle") {
      return;
    }
    const failReason = asConnectFail(body);
    if (failReason !== null) {
      this.fail(connectFailMessage(failReason));
      return;
    }
    if (isBye(body)) {
      this.remoteClosed();
      return;
    }
    const candidate = asIceCandidate(body);
    if (candidate !== null) {
      await this.addRemoteCandidate(candidate);
      return;
    }
    const answer = asAnswer(body);
    if (answer !== null) {
      await this.onAnswer(answer);
    }
  }

  private async onAnswer(answer: AnswerBody): Promise<void> {
    if (!this.pc || !this.hostKey || this.offerSig === "") {
      return;
    }
    if (this.pc.remoteDescription) {
      return;
    }
    const valid = await verifyAnswer(
      this.hostKey,
      this.device.deviceId,
      this.offerSig,
      answer.sdp,
      answer.sig,
    );
    if (!valid) {
      this.fail("Host identity check failed");
      return;
    }
    try {
      await this.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch {
      this.fail("Connection failed");
      return;
    }
    const queued = this.queuedCandidates.splice(0, this.queuedCandidates.length);
    for (const init of queued) {
      await this.addRemoteCandidate(init);
    }
  }

  private async addRemoteCandidate(init: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || this.state === "done") {
      return;
    }
    if (!this.pc.remoteDescription) {
      this.queuedCandidates.push(init);
      return;
    }
    try {
      await this.pc.addIceCandidate(init);
    } catch {
      // A malformed candidate must not kill the connection.
    }
  }

  private teardown(sendBye: boolean): void {
    const first = this.state !== "done";
    this.state = "done";
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onmessage = null;
      try {
        this.channel.close();
      } catch {
        // Already closed.
      }
      this.channel = null;
    }
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      try {
        this.pc.close();
      } catch {
        // Already closed.
      }
      this.pc = null;
    }
    if (sendBye && first && this.offerSig !== "") {
      this.relay.trySend(this.target, { t: "bye" });
    }
  }
}
