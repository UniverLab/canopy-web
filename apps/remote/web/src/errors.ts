// SPDX-License-Identifier: Apache-2.0
// Host errors on their way to the browser: a harness/spawn failure must
// name the harness and the reason only — never the host's filesystem
// (no PATH, no home directory, no binary location). The frame router
// applies this at the crossing point, so every present and future
// caller — sheets, guests — is covered. Pure module: no DOM.

/**
 * The browser-safe form of a host error. A bad directory echoes what the
 * user typed (unknown_project passes untouched); a missing harness
 * becomes the canonical not-installed line; anything else keeps its
 * words with PATH values and absolute-path runs redacted.
 */
export function sanitizeRemoteError(code: string, message: string): string {
  // A bad directory echoes what the user typed, not the host's disk.
  if (code === "unknown_project") {
    return message;
  }
  const missing = /not\s+found|no such file|not installed|command not found|ENOENT/i.test(message);
  const cli = missing ? harnessToken(message) : null;
  if (cli !== null) {
    return `harness "${cli}" is not installed on this host`;
  }
  return stripPaths(message);
}

// The harness a not-found message complains about: a quoted name, a name
// after a harness/cli/spawn keyword, or the command a shell could not
// find. Quoted paths are paths, not names, and never match here.
function harnessToken(message: string): string | null {
  // "spawn failed" names no harness: the verbs stay out of the token.
  const keyword = message.match(/\b(?:harness|cli|spawn)\s+["']?(?!failed\b|exited\b)([\w][\w.-]*)["']?/i);
  if (keyword?.[1]) {
    return keyword[1];
  }
  const shellWord = message.match(/:\s*([\w][\w.-]*):\s*(?:command not found|no such file|not found)/i);
  if (shellWord?.[1]) {
    return shellWord[1];
  }
  const leading = message.match(/^([\w][\w.-]*):\s*(?:no such file|not found|not installed)/i);
  if (leading?.[1]) {
    return leading[1];
  }
  // A bare quoted name only counts as a harness inside an execution
  // context: without one the quotes name something else — a skill, a
  // preset, a file — and the message must pass through untouched.
  if (/spawn|harness|\bcli\b|command|execut|launch|ENOENT|PATH=|not installed/i.test(message)) {
    const quoted = message.match(/"([^"/\s]+)"/);
    if (quoted?.[1]) {
      return quoted[1];
    }
  }
  return null;
}

// PATH assignments and absolute-path runs become placeholders; anything
// without a slash the browser already knew (or the user typed) passes.
function stripPaths(message: string): string {
  return message
    .replace(/PATH=[^\s]*/g, "PATH=<redacted>")
    .replace(/(?<![\w])\/(?:[\w.~=-]+)(?:\/[\w.~=-]+)*/g, "<path>");
}
