// SPDX-License-Identifier: Apache-2.0
/**
 * Fakes the worker tests inject instead of stubbing globals.
 *
 * fakeFetch answers from a route table and records every URL it was asked
 * for. FakeRoomState is a Map-free hibernation stand-in whose `storage`
 * getter throws, so any accidental storage touch fails the test that
 * made it. Closing a fake socket drops it from its state, mirroring the
 * runtime, which removes a closed socket before calling webSocketClose.
 */
import type { RoomAttachment } from "../src/protocol.js";
import type { RoomSocket, RoomState } from "../src/room.js";

/** One stubbed upstream answer. `body` is JSON-encoded, `text` stays raw. */
export interface Stub {
  /** Matched against the full request URL: exact string or part of it. */
  url: string;
  status: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: string[];
  /** The raw body sent with each call, in the same order as `calls`. */
  bodies: string[];
  /** Intercept paths explicitly NOT stubbed (a miss). */
  missing: string[];
}

/** Build a substitutable fetch over a route table, longest URL first. */
export function fakeFetch(stubs: Stub[]): FakeFetch {
  const ordered = [...stubs].sort((a, b) => b.url.length - a.url.length);
  const calls: string[] = [];
  const bodies: string[] = [];
  const missing: string[] = [];
  const fetchImpl = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    bodies.push(typeof init?.body === "string" ? init.body : "");
    for (const stub of ordered) {
      if (!url.includes(stub.url)) {
        continue;
      }
      const headers = new Headers({ "content-type": "application/json", ...stub.headers });
      const payload = stub.text ?? (stub.body === undefined ? "" : JSON.stringify(stub.body));
      return new Response(payload, {
        status: stub.status,
        headers,
      });
    }
    missing.push(url);
    return new Response("{}", { status: 404, headers: new Headers() });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, bodies, missing };
}

/** A socket the tests drive by hand: every send and close is recorded. */
export class FakeRoomSocket implements RoomSocket {
  attachment: RoomAttachment | null = null;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];

  constructor(private readonly state?: FakeRoomState) {}

  accept(): void {}

  serializeAttachment(attachment: RoomAttachment): void {
    this.attachment = attachment;
  }

  deserializeAttachment(): RoomAttachment | null {
    return this.attachment;
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.state?.remove(this);
  }

  /** The parsed bodies of everything sent to this socket. */
  frames(): Array<{ from: string; body: unknown }> {
    return this.sent.map((text) => JSON.parse(text) as { from: string; body: unknown });
  }
}

/** Hibernation state for direct room tests; storage access throws. */
export class FakeRoomState implements RoomState {
  private sockets: RoomSocket[] = [];

  get storage(): never {
    throw new Error("UserRoom must never touch storage");
  }

  acceptWebSocket(socket: RoomSocket): void {
    this.sockets.push(socket);
    // Real pair sockets can only send once accepted; the runtime accepts
    // them inside the real state, so the fake does it here. Fakes no-op.
    socket.accept();
  }

  getWebSockets(): RoomSocket[] {
    return [...this.sockets];
  }

  /** Drop a closed socket, like the runtime does. */
  remove(socket: RoomSocket): void {
    this.sockets = this.sockets.filter((candidate) => candidate !== socket);
  }

  /** A fresh fake socket bound to this state. */
  makeSocket(): FakeRoomSocket {
    return new FakeRoomSocket(this);
  }
}
