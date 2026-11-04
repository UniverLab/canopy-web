// SPDX-License-Identifier: Apache-2.0
/**
 * Fakes the worker tests inject instead of stubbing globals.
 *
 * fakeFetch answers from a route table and records every URL it was asked
 * for. FakeRoomState is a hibernation stand-in over a Map-backed storage:
 * two states sharing one map model an eviction, the second room loading
 * what the first saved. Closing a fake socket drops it from its state,
 * mirroring the runtime, which removes a closed socket before calling
 * webSocketClose.
 */
import type { RevokedKV } from "../src/auth.js";
import type { AssetsFetcher } from "../src/index.js";
import type { RoomAttachment } from "../src/protocol.js";
import { HOSTS_PROBE_PATH, type AutoResponsePair, type RoomSocket, type RoomState } from "../src/room.js";
import type { RoomNamespace, RoomStub } from "../src/ws.js";

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

/**
 * A Map-backed stand-in for the object's storage. One map shared by two
 * states models an eviction: the second room loads what the first saved.
 */
export class FakeStorage {
  constructor(private readonly entries: Map<string, unknown> = new Map()) {}

  get(keys: string[]): Promise<Map<string, unknown>> {
    const found = new Map<string, unknown>();
    for (const key of keys) {
      if (this.entries.has(key)) {
        found.set(key, this.entries.get(key));
      }
    }
    return Promise.resolve(found);
  }

  put(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.entries.set(key, value);
    }
    return Promise.resolve();
  }
}

/** Hibernation state for direct room tests, over a Map-backed storage. */
export class FakeRoomState implements RoomState {
  readonly storage: FakeStorage;
  private sockets: RoomSocket[] = [];
  private autoResponse: AutoResponsePair | null = null;
  private pending: Array<Promise<unknown>> = [];

  constructor(shared?: Map<string, unknown>) {
    this.storage = new FakeStorage(shared);
  }

  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  waitUntil(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  /** Await every storage write the room handed to `waitUntil`. */
  drainWrites(): Promise<void> {
    const writes = this.pending;
    this.pending = [];
    return Promise.all(writes).then(() => undefined);
  }

  /** Adopt carried sockets, modelling the sockets an eviction keeps. */
  adopt(sockets: RoomSocket[]): void {
    this.sockets.push(...sockets);
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

  setWebSocketAutoResponse(pair?: AutoResponsePair): void {
    this.autoResponse = pair ?? null;
  }

  getWebSocketAutoResponse(): AutoResponsePair | null {
    return this.autoResponse;
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

/**
 * How the TURN room stand-in answers the hosts probe: a boolean serves
 * `{hasHost}` for every room, while the strings fail the probe the way a
 * sick room would — a throw, a 500, or a 200 without `hasHost`.
 */
export type TurnRoomBehavior = boolean | "throw" | "bad-status" | "malformed";

/**
 * A room binding for TURN tests: it records which room each grant probed
 * and answers the hosts probe per `behavior`. Any non-probe path 404s,
 * so a query to the wrong path fails the test that made it.
 */
export class FakeTurnNamespace implements RoomNamespace {
  names: string[] = [];
  probed: string[] = [];

  constructor(private readonly behavior: TurnRoomBehavior = true) {}

  idFromName(name: string): unknown {
    this.names.push(name);
    return name;
  }

  get(id: unknown): RoomStub {
    void id;
    return {
      fetch: (request: Request): Promise<Response> => {
        this.probed.push(new URL(request.url).pathname);
        if (new URL(request.url).pathname !== HOSTS_PROBE_PATH) {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        if (this.behavior === "throw") {
          throw new Error("room down");
        }
        if (this.behavior === "bad-status") {
          return Promise.resolve(new Response("{}", { status: 500 }));
        }
        if (this.behavior === "malformed") {
          return Promise.resolve(
            new Response(JSON.stringify({ hosts: [] }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ hasHost: this.behavior }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    };
  }
}

/**
 * A Map-backed SESSION_REVOKED namespace: jti -> exp, with every `put`
 * and the TTL it asked for recorded.
 */
export class FakeRevokedKV implements RevokedKV {
  private entries = new Map<string, string>();

  /** Every `put` the code made, with the TTL it asked for. */
  putOptions: Array<{ key: string; expirationTtl?: number }> = [];

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.entries.set(key, value);
    this.putOptions.push(
      options?.expirationTtl === undefined
        ? { key }
        : { key, expirationTtl: options.expirationTtl },
    );
    return Promise.resolve();
  }

  /** True when a jti is stored. */
  has(key: string): boolean {
    return this.entries.has(key);
  }
}

/**
 * The `[assets]` binding stand-in: the Worker under test has no built
 * `../web/dist`, so this serves one canned index.html and 404s the rest.
 * The HTML carries the app's mount point, so a fallback test can tell it
 * from a JSON 404 without parsing.
 */
export class FakeAssets implements AssetsFetcher {
  constructor(
    private readonly html = `<html><head><title>Canopy remote</title></head><body><div id="app"></div></body></html>`,
  ) {}

  fetch(input: Request): Promise<Response> {
    const pathname = new URL(input.url).pathname;
    if (pathname !== "/index.html") {
      return Promise.resolve(new Response("not found\n", { status: 404 }));
    }
    return Promise.resolve(
      new Response(this.html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  }
}
