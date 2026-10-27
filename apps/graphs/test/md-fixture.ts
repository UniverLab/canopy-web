// SPDX-License-Identifier: Apache-2.0
/**
 * The quality-bubble README as the markdown renderer's snapshot subject:
 * the real document at test/fixtures/graphs/quality-bubble/README.md,
 * copied verbatim (backticks escaped for the template literal), carrying a
 * numbered list, a dashed list, inline code and a fenced block.
 */

/** Verbatim copy of test/fixtures/graphs/quality-bubble/README.md. */
export const QUALITY_BUBBLE_README = `# quality-bubble

What this graph is for: covering the change already in the worktree
with honest tests, with no spec to write. The bubble tests the current
uncommitted change by design, so it has no lock and no clean-tree
start check — run it with the change already present but uncommitted.
Every failure routes back to the implementer for another attempt.

Nodes in order:

1. \`implementer\` (agent) — writes a small, focused set of tests for the uncommitted change; never commits.
2. \`test-run\` (check) — runs the project's tests (installer placeholder).
3. \`test-size-cap\` (check) — rejects a bloated diff: added plus removed lines must stay within the cap.
4. \`anti-cheat-reviewer\` (agent, commit rights) — rejects cheating tests (copied expectations, tests that cannot fail, disabled tests, over-mocking) and lands exactly one commit when the tests honestly cover the change.

Fail edges: \`test-run\`, \`test-size-cap\`, and \`anti-cheat-reviewer\`
all route \`fail\` back to \`implementer\`.

What the installer must fill in:

- Harness: every agent node carries no \`platform\`/\`model\` — bind one per agent node (\`implementer\`, \`anti-cheat-reviewer\`) at install time.
- Gate command: \`test-run\` is a failing placeholder. Replace it with the project's test command.
- Size cap: \`test-size-cap\` caps the diff at 600 added-plus-removed lines. Adjust the cap to the project's test budget (marked \`EDIT ME\` in the command).
- Workdir: point the installed graph at the repository it should run in.

Install:

\`\`\`sh
canopy graph install quality-bubble
\`\`\`
`;
