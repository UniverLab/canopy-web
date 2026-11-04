// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import process from "node:process";

/**
 * Width of the per-suite port window: e2ePort(base, salt, envName) lands
 * in [base, base + E2E_PORT_SPAN). The suite bases (smoke, serve,
 * graphs) sit further apart than this, so the windows never overlap.
 *
 * @type {number}
 */
export const E2E_PORT_SPAN = 512;

/**
 * A Playwright webServer port that survives sibling checkouts and stale
 * runs on the same machine. A fixed port fails the second concurrent
 * `test:e2e` with "already used" (reuseExistingServer stays false: a
 * reused server can be wedged or serve another checkout's build), so the
 * first config load spreads the port over E2E_PORT_SPAN by checkout salt
 * plus process id, then pins it in process.env[envName] — which the
 * worker processes inherit, so every worker's own config load agrees on
 * the one server's port. Callers pass import.meta.dirname as salt:
 * distinct checkouts hash apart, and distinct processes in one checkout
 * differ by pid. Setting the env var before the run pins a stable port
 * for debugging.
 *
 * @param {number} base - the suite's window start.
 * @param {string} salt - per-checkout salt (the config's import.meta.dirname).
 * @param {string} envName - the variable carrying the pinned port.
 * @returns {number} the port for this run's webServer, baseURL and health URL.
 */
export function e2ePort(base, salt, envName) {
  const pinned = process.env[envName];
  if (pinned !== undefined) {
    if (!/^\d+$/.test(pinned) || Number(pinned) < 1 || Number(pinned) > 65535) {
      throw new Error(`${envName}=${pinned} is not a port: want 1-65535`);
    }
    return Number(pinned);
  }
  const hash = createHash("sha256").update(salt, "utf8").digest().readUInt32BE(0);
  const port = base + ((hash + process.pid) % E2E_PORT_SPAN);
  process.env[envName] = String(port);
  return port;
}
