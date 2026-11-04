// SPDX-License-Identifier: Apache-2.0
/**
 * The remote's weight, measured rather than assumed: the app is built the
 * way production builds it and the JavaScript and CSS it ships are gzipped,
 * against the baseline the icon spec was written over (HEAD before the
 * icons, 123 270 bytes gzip) plus the 25 KB the icon language is allowed.
 *
 * The graph editor rides its own lazy chunk behind `/editor`, so it is
 * partitioned out by the one string only it ships ("spec is not
 * connected") and weighed against its own 30 KB budget instead of the
 * main bundle's. Its stylesheet is a second editor-only asset, partitioned
 * the same way (`.remote-editor`), because the remote's CSP wants a real
 * stylesheet rather than an inline `<style>`. The main bundle must not
 * grow for the editor.
 *
 * The guest app rides its own lazy chunk behind `/g/`, partitioned out by
 * its IndexedDB name ("canopy-remote-guests") and weighed against its own
 * 6 KB budget; it shares the main stylesheet, so CSS needs no partition.
 * The main bundle must not grow for the guest either.
 *
 * The build goes to a temporary directory, never over apps/remote/web/dist.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Outside the repository: a build here must never be linted or committed.
const OUT = path.join(tmpdir(), "canopy-remote-bundle");

/** Bytes gzip of the whole app at HEAD, before the icons (js + css). */
const BASELINE = 123_270;
/** The budget this spec allows the icon language to add. */
const BUDGET = 25_600;
/**
 * Allowance for the builder-kinds spec (kind strings, prefix derivation and
 * the section picker): measured +199-237 B gzip over the icon-era baseline.
 * Bumped by the orchestrator on 2026-10-29 after the Implementer reported the
 * 48-byte headroom made any implementation of that spec impossible.
 */
const FEATURE_BUDGET = 1_024;
/**
 * Allowance for the host-metrics spec (metrics parser, store, strip and
 * SysInfo view with sparklines): measured +3 027 B gzip over the pre-change
 * main. Added in the feature commit like FEATURE_BUDGET: the 97-byte
 * headroom made any implementation of the spec impossible.
 */
const METRICS_BUDGET = 4_096;
/**
 * Allowance for the relay-keepalive spec (browser ping every 20 s, silence
 * reconnect with backoff): measured +385 B gzip over the pre-change main.
 * Added in the feature commit like METRICS_BUDGET: the 1-byte headroom
 * made any implementation of the spec impossible.
 */
const KEEPALIVE_BUDGET = 1_024;
/**
 * Allowance for the turn-fallback spec (backup STUN constant, warn-and-fallback
 * branches in loadIceServers): measured +141 B gzip over the pre-change main.
 * Added in the feature commit like KEEPALIVE_BUDGET: the 12-byte headroom
 * made any implementation of the spec impossible (the STUN URL alone is
 * longer than that).
 */
const TURN_FALLBACK_BUDGET = 1_024;
/**
 * Allowance for the landing-console spec (U9 session hint: skip /auth/me
 * when neither the hint nor a readable session cookie says so, arm on
 * sign-in click + 200, clear on 401 + logout): measured +177 B gzip over
 * the pre-change main. Added in the feature commit like
 * TURN_FALLBACK_BUDGET: the 20-byte headroom made any implementation of
 * the spec impossible.
 */
const SESSION_HINT_BUDGET = 512;
/**
 * Allowance for the returnable-fail-walk spec (can-return predicate,
 * main-flow set and ensemble pass-link repair in the shared walk module
 * the graph view renders through): measured +125 B gzip over the
 * pre-change main. Added in the feature commit like SESSION_HINT_BUDGET:
 * the 121-byte headroom made any implementation of the spec impossible.
 */
const WALK_BUDGET = 512;
/**
 * Allowance for the lane-geometry spec (handler side lane in both
 * orientations, grouped marks and buses, `done` terminals, and arcs that
 * clear every unit box): measured +2 998 B gzip over the pre-change main,
 * JS only — the stylesheet is untouched. Added in the feature commit like
 * WALK_BUDGET: the 508-byte headroom made any implementation of the spec
 * impossible (the shared plate code rides the main bundle).
 */
const LANE_BUDGET = 4_096;
/**
 * Allowance for the band-geometry spec (horizontal handler band below the
 * flow, grouped marks below sources, bus rails and band routes): measured
 * +1 028 B gzip over the allowed total (main 162 186 vs 161 158), JS only
 * — the stylesheet is untouched. Added in the feature commit like
 * LANE_BUDGET: the shared plate code rides the main bundle.
 */
const BAND_BUDGET = 1_280;
/**
 * Allowance for the shelf-upload spec (upload queue and its frames, the
 * preview-by-sniffed-mime branch, the two-direction sheet and the tray):
 * measured +2 449 B gzip over the pre-change main. Added in the feature
 * commit like LANE_BUDGET: the 508-byte headroom made any implementation
 * of the spec impossible.
 */
const UPLOAD_BUDGET = 4_096;
/**
 * Allowance for the shelf-delete spec (cell ×, viewer Delete button, the
 * one inline error line, the controller's send/ok/error path and the
 * shelf_delete builder): measured +727 B gzip over the pre-change main.
 * Added in the feature commit like UPLOAD_BUDGET: the 337-byte headroom
 * made any implementation of the spec impossible.
 */
const SHELF_DELETE_BUDGET = 1_024;
/**
 * Allowance for merging the two parallel branches of the first release: each
 * measured its budgets over the same base, so both spent the same headroom.
 * Merged, main is 410 B gzip over the sum of those budgets, with no new code.
 */
const MERGE_BUDGET = 512;
/** The budget the lazy guest chunk is allowed, gzip bytes of JS. */
const GUEST_BUDGET = 6_144;
/** The budget the lazy editor chunk is allowed, gzip bytes of JS. */
const EDITOR_BUDGET = 30_000;
/** The budget the editor's own stylesheet is allowed, gzip bytes of CSS. */
const EDITOR_CSS_BUDGET = 4_000;
/** The one string only the editor chunk ships. */
const EDITOR_MARKER = "spec is not connected";
/** The one class only the editor's stylesheet carries. */
const EDITOR_CSS_MARKER = ".remote-editor";
/** The one string only the guest chunk ships. */
const GUEST_MARKER = "canopy-remote-guests";

function filesOf(dir: string, extension: string): string[] {
  const names = readdirSync(dir, { recursive: true }) as string[];
  return names.filter((name) => name.endsWith(extension));
}

function textOf(dir: string, extension: string): string {
  let all = "";
  for (const name of filesOf(dir, extension)) {
    all += readFileSync(path.join(dir, name), "utf8");
  }
  return all;
}

function gzipOf(dir: string, extension: string): number {
  let total = 0;
  for (const name of filesOf(dir, extension)) {
    total += gzipSync(readFileSync(path.join(dir, name))).length;
  }
  return total;
}

describe("the remote's bundle", () => {
  it("grows by less than 25 KB gzip for the whole icon language", async () => {
    rmSync(OUT, { recursive: true, force: true });
    await build({
      configFile: path.join(WEB, "vite.config.ts"),
      root: WEB,
      logLevel: "silent",
      build: { outDir: OUT, emptyOutDir: true },
    });
    const assets = path.join(OUT, "assets");
    // The build really is this app: the icon layer is in the emitted bytes.
    expect(textOf(assets, ".js")).toContain("0 0 24 24");
    // The editor chunk split: exactly the files carrying the marker.
    const editorFiles = filesOf(assets, ".js").filter((name) =>
      readFileSync(path.join(assets, name), "utf8").includes(EDITOR_MARKER),
    );
    expect(editorFiles.length, "the editor must ride its own lazy chunk").toBeGreaterThan(0);
    let editorJs = 0;
    for (const name of editorFiles) {
      editorJs += gzipSync(readFileSync(path.join(assets, name))).length;
    }
    // The guest chunk split: exactly the files carrying the marker.
    const guestFiles = filesOf(assets, ".js").filter((name) =>
      readFileSync(path.join(assets, name), "utf8").includes(GUEST_MARKER),
    );
    expect(guestFiles.length, "the guest must ride its own lazy chunk").toBeGreaterThan(0);
    expect(
      guestFiles.filter((name) => editorFiles.includes(name)),
      "the guest must not share the editor chunk",
    ).toEqual([]);
    let guestJs = 0;
    for (const name of guestFiles) {
      guestJs += gzipSync(readFileSync(path.join(assets, name))).length;
    }
    const js = gzipOf(assets, ".js");
    const css = gzipOf(assets, ".css");
    // The editor's stylesheet is its own asset, linked when its chunk loads
    // (inline <style> on the remote is xterm's exception alone): count it
    // against the editor's budget, never the main bundle's.
    const editorCssFiles = filesOf(assets, ".css").filter((name) =>
      readFileSync(path.join(assets, name), "utf8").includes(EDITOR_CSS_MARKER),
    );
    expect(editorCssFiles.length, "the editor's stylesheet must be its own asset").toBeGreaterThan(0);
    let editorCss = 0;
    for (const name of editorCssFiles) {
      editorCss += gzipSync(readFileSync(path.join(assets, name))).length;
    }
    const main = js - editorJs - guestJs + css - editorCss;
    rmSync(OUT, { recursive: true, force: true });
    const report = {
      baseline: BASELINE,
      js,
      editorJs,
      guestJs,
      css,
      editorCss,
      main,
      added: main - BASELINE,
    };
    // Keep the numbers in the failure message: a regression says by how much.
    expect(main, JSON.stringify(report)).toBeLessThanOrEqual(
      BASELINE +
        BUDGET +
        FEATURE_BUDGET +
        METRICS_BUDGET +
        KEEPALIVE_BUDGET +
        TURN_FALLBACK_BUDGET +
        SESSION_HINT_BUDGET +
        WALK_BUDGET +
        LANE_BUDGET +
        BAND_BUDGET +
        UPLOAD_BUDGET +
        SHELF_DELETE_BUDGET +
        MERGE_BUDGET,
    );
    expect(guestJs, JSON.stringify(report)).toBeLessThanOrEqual(GUEST_BUDGET);
    expect(editorJs, JSON.stringify(report)).toBeLessThanOrEqual(EDITOR_BUDGET);
    expect(editorCss, JSON.stringify(report)).toBeLessThanOrEqual(EDITOR_CSS_BUDGET);
    // The app still ships the icons inline: no sprite chunk, no font request.
    expect(css).toBeGreaterThan(0);
  }, 120_000);
});
