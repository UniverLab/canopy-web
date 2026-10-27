// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index.js";
import { UserRoom } from "../src/room.js";
import type { RoomAttachment } from "../src/protocol.js";
import { FakeRoomState, FakeRoomSocket } from "./fakes.js";
import roomSource from "../src/room.ts?raw";

const HOST_ID = "0123456789abcdef";
const OTHER_HOST_ID = "fedcba9876543210";

function setup(): { state: FakeRoomState; room: UserRoom } {
  const state = new FakeRoomState();
  return { state, room: new UserRoom(state) };
}

/**
 * An accepted fake socket, with the conn the room would have assigned.
 * Mirrors fetch's accept path without the real pair.
 */
function attachFake(
  state: FakeRoomState,
  room: UserRoom,
  role: "device" | "host",
  extra: { host_id?: string; label?: string } = {},
): FakeRoomSocket {
  const socket = state.makeSocket();
  state.acceptWebSocket(socket);
  const conn = String(room.nextConn);
  room.nextConn += 1;
  const attachment: RoomAttachment = { role, conn, ...extra };
  socket.serializeAttachment(attachment);
  return socket;
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
  it("answers 426 without a websocket upgrade", () => {
    const { room } = setup();
    const response = room.fetch(new Request("https://user-room/"));
    expect(response.status).toBe(426);
  });

  it("answers 400 for a missing role or a host without an id", () => {
    const { room } = setup();
    const noRole = room.fetch(upgradeRequest("browser"));
    expect(noRole.status).toBe(400);
    const noId = room.fetch(upgradeRequest("host", { "x-relay-label": "devbox" }));
    expect(noId.status).toBe(400);
  });

  it("accepts a device and sends it the hosts list", async () => {
    const { state, room } = setup();
    const response = room.fetch(upgradeRequest("device"));
    expect(response.status).toBe(101);
    expect(state.getWebSockets()).toHaveLength(1);
    expect(state.getWebSockets()[0]?.deserializeAttachment()).toEqual({ role: "device", conn: "1" });
    const client = clientOf(response);
    client.accept();
    expect(JSON.parse(await nextMessage(client))).toEqual({
      from: "relay",
      body: { t: "hosts", items: [] },
    });
  });

  it("broadcasts to every device when a host connects", async () => {
    const { room } = setup();
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
    const { state, room } = setup();
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
    const { state, room } = setup();
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

  it("refuses the 9th device with code 4008", async () => {
    const { state, room } = setup();
    for (let index = 0; index < 8; index += 1) {
      const response = room.fetch(upgradeRequest("device"));
      expect(response.status).toBe(101);
    }
    expect(state.getWebSockets()).toHaveLength(8);
    const ninth = clientOf(room.fetch(upgradeRequest("device")));
    ninth.accept();
    expect(await nextClose(ninth)).toBe(4008);
    expect(state.getWebSockets()).toHaveLength(8);
  });
});

describe("routing", () => {
  it("delivers device to host and host to device with rewritten sources", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "offer", sdp: "v=0" } }));
    expect(host.frames()).toEqual([{ from: "d:1", body: { t: "offer", sdp: "v=0" } }]);
    room.webSocketMessage(host, JSON.stringify({ to: "d:1", body: { t: "answer", sdp: "v=0" } }));
    expect(device.frames()).toEqual([{ from: `h:${HOST_ID}`, body: { t: "answer", sdp: "v=0" } }]);
  });

  it("bounces unknown targets and role-mismatched prefixes", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    room.webSocketMessage(device, JSON.stringify({ to: "h:deadbeefdeadbeef", body: { t: "offer" } }));
    room.webSocketMessage(device, JSON.stringify({ to: "d:1", body: { t: "offer" } }));
    room.webSocketMessage(host, JSON.stringify({ to: "d:999", body: { t: "answer" } }));
    room.webSocketMessage(host, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "answer" } }));
    const errors = [{ from: "relay", body: { t: "error", code: "no_target" } }];
    expect(device.frames()).toEqual([...errors, ...errors]);
    expect(host.frames()).toEqual([...errors, ...errors]);
  });

  it("drops frames over 64 KiB and delivers frames of exactly 64 KiB", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
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

  it("rejects malformed and binary frames", () => {
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    room.webSocketMessage(device, "not json");
    room.webSocketMessage(device, JSON.stringify({ body: 1 }));
    room.webSocketMessage(device, JSON.stringify({ to: 42 }));
    room.webSocketMessage(device, new ArrayBuffer(4));
    const errors = [{ from: "relay", body: { t: "error", code: "bad_frame" } }];
    expect(device.frames()).toEqual([...errors, ...errors, ...errors, ...errors]);
  });
});

describe("pair_init rate limit", () => {
  it("allows 20 pair_init frames per 10 minutes from either role", () => {
    vi.useFakeTimers();
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    const host = attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
    for (let index = 0; index < 19; index += 1) {
      room.webSocketMessage(device, JSON.stringify({ to: `h:${HOST_ID}`, body: { t: "pair_init" } }));
    }
    room.webSocketMessage(host, JSON.stringify({ to: "d:1", body: { t: "pair_init" } }));
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

  it("opens the window again after 10 minutes", () => {
    vi.useFakeTimers();
    const { state, room } = setup();
    const device = attachFake(state, room, "device");
    attachFake(state, room, "host", { host_id: HOST_ID, label: "devbox" });
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

describe("no storage", () => {
  it("never touches the storage API: the source says so", () => {
    expect(roomSource).not.toContain(".storage");
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
    const clients: TestClient[] = [];
    for (let index = 0; index < 8; index += 1) {
      const response = await stub.fetch(upgradeRequest("device"));
      expect(response.status).toBe(101);
      const client = clientOf(response);
      client.accept();
      clients.push(client);
    }
    const ninth = clientOf(await stub.fetch(upgradeRequest("device")));
    ninth.accept();
    expect(await nextClose(ninth)).toBe(4008);
  });
});
