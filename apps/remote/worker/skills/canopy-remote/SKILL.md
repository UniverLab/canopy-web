---
name: canopy-remote
description: >
  Use this skill when the user wants to reach a Canopy host from a browser:
  how remote.univerlab.org pairs a device, what the relay endpoints do, and
  which channel carries the session. Read-only guidance only; it never touches
  a live session.
license: MIT
metadata:
  author: jheison.martinez
  version: "1.0"
  category: remote-access
  last_updated: "2026-10-29"
---

# Canopy Remote

Reach a Canopy host from any browser through `https://remote.univerlab.org`.

## What it is

A blind signaling relay plus a browser app. The browser signs in with GitHub,
pairs with a host over an end-to-end channel, and then drives that host's
Canopy sessions from the page. The relay proves both ends belong to the same
GitHub account and forwards opaque envelopes; it never reads them.

## How pairing works

1. The browser opens `/auth/login` and signs in with GitHub (identity only,
   no scope). It keeps an HMAC-signed `cr_session` cookie, 12 hours.
2. The host runs `canopy remote pair`, which prints a short pairing
   code. The browser opens `/pair#<code>`.
3. Browser and host run the pairing handshake through the relay. The pairing
   secret is derived on both ends; the relay only forwards the frames.
4. Paired hosts reconnect on later visits without a new code, until the
   device forgets them.

## The session channel

After pairing, the browser and the host talk end to end: terminal bytes,
session snapshots, file-shelf transfers and graph state flow over a channel
the relay cannot read. The relay's `/ws/device` and `/ws/host` sockets carry
the envelopes, and `/turn` mints short-lived TURN credentials so the media
can find a path. Either a valid session cookie or a verified host bearer
unlocks `/turn`; nothing here is anonymous after login.

## Endpoints

- `GET /auth/login` — start the GitHub sign-in.
- `GET /auth/callback` — the OAuth landing; sets `cr_session`.
- `POST /auth/logout` — clear the session.
- `GET /auth/me` — the signed-in identity, or 401.
- `GET /ws/device` — the browser's relay socket (session cookie).
- `GET /ws/host` — the host's relay socket (host bearer).
- `GET /turn` — TURN credentials for either end (either credential).

The machine-readable index is `/.well-known/api-catalog`, and the plain-text
service summary is `/llms.txt`.

## What this skill never does

It describes the public service only. It never opens a socket, never sends a
pairing frame, never reads a session, and never handles a cookie, a token or
a pairing code.
