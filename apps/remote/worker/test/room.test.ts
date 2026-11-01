// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index.js";
import { HOSTS_PROBE_PATH, UserRoom, newConnId } from "../src/room.js";
import type { RoomAttachment } from "../src/protocol.js";
import { FakeRoomState, FakeRoomSocket } from "./fakes.js";

const HOST_ID = "0123456789abcdef";
const OTHER_HOST_ID = "fedcba9876543210";
const GUEST_UID = 222;
const GUEST_LOGIN = "evicted-guest";

/** A bare v4 UUID, the room's connection id without its `d:` prefix. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function setup(): Promise<{ state: FakeRoomState; room: UserRoom }> {
  const state = new FakeRoomState();
  const room = new UserRoom(state);
  await room.ready;
  return { state, room };
}

/**
 * An accepted fake socket, with a fresh id like fetch assigns.
 * Mirrors fetch's accept path without the real pair.
 */
function attachFake(
  state: FakeRoomState,
  role: "device" | "host" | "guest",
  extra: { host_id?: string; label?: string; login?: string; uid?: number } = {},
): FakeRoomSocket {
  const socket = state.makeSocket();
  state.acceptWebSocket(socket);
  const attachment: RoomAttachment = { role, conn: newConnId(), ...extra };
  socket.serializeAttachment(attachment);
  return socket;
}

/** The conn of an attached fake socket, failing the test when missing. */
function connOf(socket: FakeRoomSocket): string {
  const conn = socket.deserializeAttachment()?.conn;
  if (conn === undefined) {
    throw new Error("expected the socket to carry a conn");
  }
  return conn;
}

function upgradeRequest(role: string, extra: Record<string, string> = {}): Request {
  const headers = new Headers({ upgrade: "websocket", "x-relay-role": role, ...extra });
  return new Request("https://user-room/", { headers });
}

/** A real client socket, narrowed to what the tests drive. */
interface TestClient {
  accept(): void;
  send(message: string): void;
  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void;
}

function clientOf(response: Response): TestClient {
  const client = (response as unknown as { webSocket?: TestClient }).webSocket;
  if (!client) {
    throw new Error("expected a 101 carrying a client socket");
  }
  return client;
}

function nextMessage(client: TestClient): Promise<string> {
  return new Promise((resolve) => {
    client.addEventListener(
      "message",
      (event) => resolve(String((event as unknown as { data: unknown }).data)),
      { once: true },
    );
  });
}

function nextClose(client: TestClient): Promise<number> {
  return new Promise((resolve) => {
    client.addEventListener(
      "close",
      (event) => resolve((event as unknown as { code: number }).code),
      { once: true },
    );
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("room fetch", () => {
  it("answers 426 without a websocket upgrade", async () => {
    const { room } = await setup();
    const response = room.fetch(new Request("https://user-room/"));
    expect(response.status).toBe(426);
  });

  it("answers 400 for a missing role or a host without an id", async () => {
    const { room } = await setup();
    const noRole = room.fetch(upgradeRequest("browser"));
    expect(noRole.status).toBe(400);
    const noId = room.fetch(upgradeRequest("host", { "x-relay-label": "devbox" }));
    expect(noId.status).toBe(400);
  });

  it("accepts a device and sends it the hosts list", async () => {
    const { state, room } = await setup();
    const response = room.fetch(upgradeRequest("device"));
    expect(response.status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(1);
    const attachment = state.getWebSockets()[0]?.deserializeAttachment();
    expect(attachment?.role).toBe("device");
    expect(attachment?.conn).toMatch(UUID_PATTERN);
    const client = clientOf(response);
    client.accept();
    expect(JSON.parse(await nextMessage(client))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
  });

  it("broadcasts to every device when a host connects", async () => {
    const { room } = await setup();
    const first = clientOf(room.fetch(upgradeRequest("device")));
    first.accept();
    expect(JSON.parse(await nextMessage(first))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
    const hostResponse = room.fetch(
      upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "devbox" }),
    );
    expect(hostResponse.status).toBe(101);
    expect(JSON.parse(await nextMessage(first))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: HOST_ID, label: "devbox" }] },
    });
    const second = clientOf(room.fetch(upgradeRequest("device")));
    second.accept();
    expect(JSON.parse(await nextMessage(second))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: HOST_ID, label: "devbox" }] },
    });
  });

  it("broadcasts to every device when a host disconnects", async () => {
    const { state, room } = await setup();
    const device = clientOf(room.fetch(upgradeRequest("device")));
    device.accept();
    await nextMessage(device);
    room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "devbox" }));
    await nextMessage(device);
    const hostSocket = state.getWebSockets().find(
      (socket) => socket.deserializeAttachment()?.role === "host",
    );
    if (hostSocket === undefined) {
      throw new Error("expected the host socket to be attached");
    }
    // The runtime drops a closed socket before calling webSocketClose.
    hostSocket.close(1000, "gone");
    state.remove(hostSocket);
    room.webSocketClose(hostSocket);
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
  });

  it("replaces a host that reconnects with the same id", async () => {
    const { state, room } = await setup();
    const first = clientOf(
      room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "old" })),
    );
    first.accept();
    const replaced = state.getWebSockets();
    const closed = nextClose(first);
    const second = clientOf(
      room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "new" })),
    );
    second.accept();
    expect(await closed).toBe(4000);
    // Mirror the runtime: the replaced socket leaves before its close lands.
    for (const socket of replaced) {
      state.remove(socket);
      room.webSocketClose(socket);
    }
    const device = clientOf(room.fetch(upgradeRequest("device")));
    device.accept();
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: HOST_ID, label: "new" }] },
    });
  });

  it("decodes a percent-encoded accented label on ingest", async () => {
    const { room } = await setup();
    const device = clientOf(room.fetch(upgradeRequest("device")));
    device.accept();
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
    const label = "caf\u00e9-\u00f1and\u00fa \u4e2d\u6587";
    const seen = nextMessage(device);
    const hostResponse = room.fetch(
      upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": encodeURIComponent(label) }),
    );
    expect(hostResponse.status).toBe(101);
    expect(JSON.parse(await seen)).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: HOST_ID, label }] },
    });
  });

  it("leaves plain ASCII and plus signs untouched", async () => {
    for (const label of ["devbox", "devbox+v2", "a+b c"]) {
      const { room } = await setup();
      const device = clientOf(room.fetch(upgradeRequest("device")));
      device.accept();
      expect(JSON.parse(await nextMessage(device))).toEqual({
        from: "relay",
        body: { t: "hosts", items: [] },
      });
      const seen = nextMessage(device);
      const hostResponse = room.fetch(
        upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": label }),
      );
      expect(hostResponse.status).toBe(101);
      expect(JSON.parse(await seen)).toEqual({
        from: "relay",
        body: { t: "hosts", items: [{ host_id: HOST_ID, label }] },
      });
    }
  });

  it("falls back to the raw string on malformed sequences without a 400", async () => {
    for (const raw of ["100%", "bad%2", "%ZZ", "%E0%A4%A", "caf%C3%A9%zz"]) {
      const { room } = await setup();
      const device = clientOf(room.fetch(upgradeRequest("device")));
      device.accept();
      expect(JSON.parse(await nextMessage(device))).toEqual({
        from: "relay",
        body: { t: "hosts", items: [] },
      });
      const seen = nextMessage(device);
      const hostResponse = room.fetch(
        upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": raw }),
      );
      expect(hostResponse.status).toBe(101);
      expect(JSON.parse(await seen)).toEqual({
        from: "relay",
        body: { t: "hosts", items: [{ host_id: HOST_ID, label: raw }] },
      });
    }
  });

  it("refuses the 9th device with 429 before the upgrade", async () => {
    const { state, room } = await setup();
    for (let index = 0; index < 8; index += 1) {
      const response = room.fetch(upgradeRequest("device"));
      expect(response.status).toBe(101);
    }
    expect(state.getWebSockets()).toHaveLength(8);
    const started = Date.now();
    const ninth = room.fetch(upgradeRequest("device"));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ninth.status).toBe(429);
    expect(await ninth.json()).toEqual({ error: "too_many_devices" });
    // No 101, so no socket to open: the browser never sees an open event.
    expect((ninth as unknown as { webSocket?: unknown }).webSocket ?? null).toBeNull();
    expect(state.getWebSockets()).toHaveLength(8);
  });
});

describe("hosts probe", () => {
  it("answers false with no host attached, without needing an upgrade", async () => {
    const { state, room } = await setup();
    attachFake(state, "device");
    const response = room.fetch(new Request(`https://user-room${HOSTS_PROBE_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hasHost: false });
  });

  it("answers true while a host is attached and false after it leaves", async () => {
    const { state, room } = await setup();
    attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const present = room.fetch(new Request(`https://user-room${HOSTS_PROBE_PATH}`));
    expect(present.status).toBe(200);
    expect(await present.json()).toEqual({ hasHost: true });
    host.close();
    const gone = room.fetch(new Request(`https://user-room${HOSTS_PROBE_PATH}`));
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ hasHost: false });
  });

  it("keeps the upgrade check for every other non-upgrade path", async () => {
    const { room } = await setup();
    expect(room.fetch(new Request("https://user-room/")).status).toBe(426);
    const post = room.fetch(new Request(`https://user-room${HOSTS_PROBE_PATH}`, { method: "POST" }));
    expect(post.status).toBe(426);
  });
});

describe("close handshake", () => {
  it("echoes the client's close code and reason", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    room.webSocketClose(device, 1000, "gone");
    expect(device.closed).toEqual([{ code: 1000, reason: "gone" }]);
  });

  it("still announces the gone socket after echoing its close", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const hostSocket = state.getWebSockets().find(
      (socket) => socket.deserializeAttachment()?.role === "host",
    );
    if (hostSocket === undefined) {
      throw new Error("expected the host socket to be attached");
    }
    room.webSocketClose(hostSocket, 1001, "away");
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "hosts", items: [] } }]);
  });

  it("still announces the gone socket when the echo throws", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    host.close = () => {
      state.remove(host);
      throw new Error("echo failed");
    };
    expect(() => room.webSocketClose(host, 1000, "gone")).toThrow("echo failed");
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "hosts", items: [] } }]);
  });
});

describe("routing", () => {
  it("delivers device to host and host to device with rewritten sources", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const deviceConn = connOf(device);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer", sdp: "v=0" } }));
    expect(host.frames()).toEqual([{ from: `d:${deviceConn}`, body: { t: "offer", sdp: "v=0" } }]);
    room.webSocketMessage(host, JSON.stringify({ to: `d:${deviceConn}`, body: { t: "answer", sdp: "v=0" } }));
    expect(device.frames()).toEqual([{ from: `h:${HOST_ID}`, body: { t: "answer", sdp: "v=0" } }]);
  });

  it("bounces unknown targets and role-mismatched prefixes", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const deviceConn = connOf(device);
    room.webSocketMessage(device, JSON.stringify({ to: "h:deadbeefdeadbeef", body: { t: "offer" } }));
    room.webSocketMessage(device, JSON.stringify({ to: `d:${deviceConn}`, body: { t: "offer" } }));
    room.webSocketMessage(host, JSON.stringify({ to: `d:${newConnId()}`, body: { t: "answer" } }));
    room.webSocketMessage(host, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "answer" } }));
    const errors = [{ from: "relay", body: { t: "error", code: "no_target" } }];
    expect(device.frames()).toEqual([...errors, ...errors]);
    expect(host.frames()).toEqual([...errors, ...errors]);
  });

  it("drops frames over 64 KiB and delivers frames of exactly 64 KiB", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const prefix = `{"to":"h:${HOST_ID}","body":"`;
    const suffix = `"}`;
    const fitting = `${prefix}${"x".repeat(65536 - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(fitting).length).toBe(65536);
    room.webSocketMessage(device, fitting);
    expect(host.sent).toHaveLength(1);
    const oversized = `${fitting}x`;
    room.webSocketMessage(device, oversized);
    expect(host.sent).toHaveLength(1);
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "error", code: "too_large" } }]);
  });

  it("pins the exact envelope bytes a host matches", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const deviceConn = connOf(device);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer", sdp: "v=0" } }));
    expect(host.sent).toEqual([`{"from":"d:${deviceConn}","body":{"t":"offer","sdp":"v=0"}}`]);
    room.webSocketMessage(host, JSON.stringify({ to: `d:${deviceConn}`, body: { t: "answer" } }));
    room.webSocketMessage(device, JSON.stringify({ to: "h:deadbeefdeadbeef", body: { t: "offer" } }));
    expect(device.sent).toEqual([
      `{"from":"h:${HOST_ID}","body":{"t":"answer"}}`,
      `{"from":"relay","body":{"t":"error","code":"no_target"}}`,
    ]);
  });

  it("pins the exact hosts notice bytes", async () => {
    const { room } = await setup();
    const device = clientOf(room.fetch(upgradeRequest("device")));
    device.accept();
    expect(await nextMessage(device)).toBe(`{"from":"relay","body":{"t":"hosts","items":[]}}`);
    const seen = nextMessage(device);
    room.fetch(upgradeRequest("host", { "x-relay-host-id": HOST_ID, "x-relay-label": "devbox" }));
    expect(await seen).toBe(
      `{"from":"relay","body":{"t":"hosts","items":[{"host_id":"${HOST_ID}","label":"devbox"}]}}`,
    );
  });

  it("rejects malformed and binary frames", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    room.webSocketMessage(device, "not json");
    room.webSocketMessage(device, JSON.stringify({ body: 1 }));
    room.webSocketMessage(device, JSON.stringify({ to: 42 }));
    room.webSocketMessage(device, new ArrayBuffer(4));
    const errors = [{ from: "relay", body: { t: "error", code: "bad_frame" } }];
    expect(device.frames()).toEqual([...errors, ...errors, ...errors, ...errors]);
  });
});

describe("pair_init rate limit", () => {
  it("allows 20 pair_init frames per 10 minutes from either role", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const deviceConn = connOf(device);
    for (let index = 0; index < 19; index += 1) {
      room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    room.webSocketMessage(host, JSON.stringify({ to: `d:${deviceConn}`, body: { t: "pair_init" } }));
    expect(host.sent).toHaveLength(19);
    expect(device.sent).toHaveLength(1);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.frames()).toEqual([
      { from: `h:${HOST_ID}`, body: { t: "pair_init" } },
      { from: "relay", body: { t: "error", code: "rate_limited" } },
    ]);
    expect(host.sent).toHaveLength(19);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } }));
    expect(host.sent).toHaveLength(20);
  });

  it("opens the window again after 10 minutes", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    for (let index = 0; index < 20; index += 1) {
      room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.sent).toHaveLength(1);
    vi.advanceTimersByTime(600001);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.sent).toHaveLength(1);
  });
});

describe("per-socket frame budget", () => {
  it("passes 30 frames, then closes the 31st with 4009 without forwarding", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const frame = JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } });
    for (let index = 0; index < 30; index += 1) {
      room.webSocketMessage(device, frame);
    }
    expect(host.sent).toHaveLength(30);
    expect(device.closed).toEqual([]);
    room.webSocketMessage(device, frame);
    expect(device.closed).toEqual([{ code: 4009, reason: "rate_limited" }]);
    expect(host.sent).toHaveLength(30);
    expect(device.sent).toEqual([]);
  });

  it("passes a paced trickle of 60 frames over 30 seconds", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const frame = JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } });
    for (let index = 0; index < 60; index += 1) {
      room.webSocketMessage(device, frame);
      vi.advanceTimersByTime(500);
    }
    expect(host.sent).toHaveLength(60);
    expect(device.closed).toEqual([]);
  });

  it("budgets each socket apart: one burst never closes its neighbor", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const first = attachFake(state, "device");
    const second = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const frame = JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } });
    for (let index = 0; index < 31; index += 1) {
      room.webSocketMessage(first, frame);
    }
    expect(first.closed).toEqual([{ code: 4009, reason: "rate_limited" }]);
    room.webSocketMessage(second, frame);
    expect(second.closed).toEqual([]);
    expect(host.sent).toHaveLength(31);
  });

  it("charges binary and oversized frames against the budget too", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    for (let index = 0; index < 15; index += 1) {
      room.webSocketMessage(device, new ArrayBuffer(4));
      room.webSocketMessage(device, "x".repeat(65537));
    }
    expect(device.sent).toHaveLength(30);
    expect(device.closed).toEqual([]);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } }));
    expect(device.closed).toEqual([{ code: 4009, reason: "rate_limited" }]);
    expect(device.sent).toHaveLength(30);
  });

  it("refills the budget after the window passes", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    const host = attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    const frame = JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } });
    for (let index = 0; index < 30; index += 1) {
      room.webSocketMessage(device, frame);
    }
    vi.advanceTimersByTime(10000);
    room.webSocketMessage(device, frame);
    expect(device.closed).toEqual([]);
    expect(host.sent).toHaveLength(31);
  });
});

describe("keepalive", () => {
  it("enables auto-response for plain-text pings in the constructor", async () => {
    const { state } = await setup();
    const pair = state.getWebSocketAutoResponse();
    expect(pair?.request).toBe("ping");
    expect(pair?.response).toBe("pong");
  });

  it("answers app pings to the relay with a pong", async () => {
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    room.webSocketMessage(device, JSON.stringify({ to: "relay", body: { t: "ping" } }));
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "pong" } }]);
    expect(device.sent).toEqual([`{"from":"relay","body":{"t":"pong"}}`]);
  });

  it("keeps pings outside the pair_init quota", async () => {
    vi.useFakeTimers();
    const { state, room } = await setup();
    const device = attachFake(state, "device");
    attachFake(state, "host", { host_id: HOST_ID, label: "devbox" });
    for (let index = 0; index < 20; index += 1) {
      room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    // The quota is spent, but a ping still pongs instead of rate-limiting.
    room.webSocketMessage(device, JSON.stringify({ to: "relay", body: { t: "ping" } }));
    expect(device.frames()).toEqual([{ from: "relay", body: { t: "pong" } }]);
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.frames()).toEqual([
      { from: "relay", body: { t: "pong" } },
      { from: "relay", body: { t: "error", code: "rate_limited" } },
    ]);
  });
});

describe("connection ids", () => {
  it("conn_ids_are_unique_uuids", () => {
    const ids = Array.from({ length: 100 }, () => `d:${newConnId()}`);
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) {
      expect(id).toMatch(/^d:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe("eviction", () => {
  it("room_state_survives_eviction", async () => {
    // Workerd never evicts on demand, so the test replays one by hand: a
    // room populates its state, its writes drain, and a fresh room over
    // the same storage adopts the carried sockets.
    const shared = new Map<string, unknown>();
    const firstState = new FakeRoomState(shared);
    const first = new UserRoom(firstState);
    await first.ready;
    const device = attachFake(firstState, "device");
    const deviceConn = connOf(device);
    const guest = attachFake(firstState, "guest", { login: GUEST_LOGIN, uid: GUEST_UID });
    const guestConn = connOf(guest);
    const host = attachFake(firstState, "host", { host_id: HOST_ID, label: "devbox" });
    const inviteHash = "e7".repeat(32);
    first.webSocketMessage(
      host,
      JSON.stringify({
        to: "room",
        body: {
          t: "guest_allow",
          uids: [GUEST_UID],
          invites: [{ code_hash: inviteHash, uid: GUEST_UID, expires: 9999999999 }],
        },
      }),
    );
    for (let index = 0; index < 20; index += 1) {
      first.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    expect(host.sent).toHaveLength(20);
    await firstState.drainWrites();

    const secondState = new FakeRoomState(shared);
    secondState.adopt(firstState.getWebSockets());
    const second = new UserRoom(secondState);
    await second.ready;
    expect(second.guestAllow).toEqual([GUEST_UID]);
    expect(second.guestInvites).toEqual([{ code_hash: inviteHash, uid: GUEST_UID, expires: 9999999999 }]);
    expect(second.pairInit).toEqual(first.pairInit);
    expect(second.pairInit).toHaveLength(20);

    // Carried sockets keep routing under their old addresses.
    second.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } }));
    expect(host.frames().at(-1)).toEqual({ from: `d:${deviceConn}`, body: { t: "offer" } });
    second.webSocketMessage(host, JSON.stringify({ to: `d:${deviceConn}`, body: { t: "answer" } }));
    expect(device.frames().at(-1)).toEqual({ from: `h:${HOST_ID}`, body: { t: "answer" } });
    second.webSocketMessage(guest, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer" } }));
    expect(host.frames().at(-1)).toEqual({
      from: `d:${guestConn}`,
      login: GUEST_LOGIN,
      uid: GUEST_UID,
      body: { t: "offer" },
    });

    // The invites survived: the invited guest connects, a stranger 403s.
    const invited = second.fetch(
      upgradeRequest("guest", {
        "x-relay-login": "second",
        "x-relay-uid": String(GUEST_UID),
        "x-relay-invite-hash": inviteHash,
      }),
    );
    expect(invited.status).toBe(101);
    const stranger = second.fetch(
      upgradeRequest("guest", {
        "x-relay-login": "stranger",
        "x-relay-uid": "999",
        "x-relay-invite-hash": inviteHash,
      }),
    );
    expect(stranger.status).toBe(403);

    // The pair quota survived too: the next attempt rate-limits.
    second.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    expect(device.frames().at(-1)).toEqual({ from: "relay", body: { t: "error", code: "rate_limited" } });
  });
});

describe("live room", () => {
  it("round-trips through the real Durable Object", async () => {
    const namespace = (env as unknown as Env).USER_ROOM;
    const stub = namespace.get(namespace.idFromName("room-self-test"));
    const deviceResponse = await stub.fetch(upgradeRequest("device"));
    expect(deviceResponse.status).toBe(101);
    const device = clientOf(deviceResponse);
    device.accept();
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
    // Listen before the host fetch: the broadcast can land while stub.fetch
    // itself is still resolving.
    const withHost = nextMessage(device);
    const hostResponse = await stub.fetch(
      upgradeRequest("host", { "x-relay-host-id": OTHER_HOST_ID, "x-relay-label": "live" }),
    );
    expect(hostResponse.status).toBe(101);
    const host = clientOf(hostResponse);
    host.accept();
    expect(JSON.parse(await withHost)).toEqual({
      from: "relay",
      body: { t: "hosts", items: [{ host_id: OTHER_HOST_ID, label: "live" }] },
    });
    const atHost = nextMessage(host);
    device.send(JSON.stringify({ to: `h:${OTHER_HOST_ID}`, body: { t: "offer" } }));
    const received = JSON.parse(await atHost) as { from: string; body: unknown };
    expect(received.body).toEqual({ t: "offer" });
    const atDevice = nextMessage(device);
    host.send(JSON.stringify({ to: received.from, body: { t: "answer" } }));
    expect(JSON.parse(await atDevice)).toEqual({
      from: `h:${OTHER_HOST_ID}`,
      body: { t: "answer" },
    });
  });

  it("refuses the 9th device on the real object", async () => {
    const namespace = (env as unknown as Env).USER_ROOM;
    const stub = namespace.get(namespace.idFromName("room-self-ninth"));
    for (let index = 0; index < 8; index += 1) {
      const response = await stub.fetch(upgradeRequest("device"));
      expect(response.status).toBe(101);
      clientOf(response).accept();
    }
    const started = Date.now();
    const ninth = await stub.fetch(upgradeRequest("device"));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(ninth.status).toBe(429);
    expect(await ninth.json()).toEqual({ error: "too_many_devices" });
  });

  it("answers app pings on the real object", async () => {
    const namespace = (env as unknown as Env).USER_ROOM;
    const stub = namespace.get(namespace.idFromName("room-self-ping"));
    const deviceResponse = await stub.fetch(upgradeRequest("device"));
    expect(deviceResponse.status).toBe(101);
    const device = clientOf(deviceResponse);
    device.accept();
    expect(JSON.parse(await nextMessage(device))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
    const pong = nextMessage(device);
    device.send(JSON.stringify({ to: "relay", body: { t: "ping" } }));
    expect(JSON.parse(await pong)).toEqual({
      from: "relay",
      body: { t: "pong" },
    });
  });

  it("closes a bursting socket with 4009 on the real object", async () => {
    const namespace = (env as unknown as Env).USER_ROOM;
    const stub = namespace.get(namespace.idFromName("room-self-budget"));
    const deviceResponse = await stub.fetch(upgradeRequest("device"));
    expect(deviceResponse.status).toBe(101);
    const device = clientOf(deviceResponse);
    device.accept();
    await nextMessage(device);
    const hostResponse = await stub.fetch(
      upgradeRequest("host", { "x-relay-host-id": OTHER_HOST_ID, "x-relay-label": "live" }),
    );
    expect(hostResponse.status).toBe(101);
    clientOf(hostResponse).accept();
    const closed = nextClose(device);
    const frame = JSON.stringify({ to: `h:${OTHER_HOST_ID}`, body: { t: "offer" } });
    for (let index = 0; index < 60; index += 1) {
      device.send(frame);
    }
    expect(await closed).toBe(4009);
  });
});
