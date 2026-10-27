# single-committer

What this graph is for: the spec loop with a harder review bar. Two
reviewers — one constructive, one adversarial — must both pass before
a single committer makes the final check and lands exactly one
commit. Only the committer commits. Every failure routes back to the
implementer for another attempt.

Nodes in order:

1. `start-check` (check) — refuses a dirty worktree before anything runs.
2. `lock-repo` (check) — takes the repo lock for this spec.
3. `implementer` (agent) — implements exactly the spec; never commits.
4. `full-gates` (check) — the deterministic gates (installer placeholder).
5. `reviewers` (parallel ensemble, no commit rights) — member 1 reviews constructively, member 2 reviews adversarially; both must pass.
6. `committer` (agent, commit rights) — final check against the spec plus the reviewers' verdict, then exactly one commit.
7. `commit-check` (check) — proves a commit landed since the spec started.
8. `unlock` (check) — releases the repo lock.
9. `human-verdict` (check) — waits up to 24h for a human verdict file; anything but approval routes back to the implementer.

Fail edges: `full-gates`, the `reviewers` quorum, `committer`,
`commit-check`, and `human-verdict` all route `fail` back to
`implementer`.

What the installer must fill in:

- Harness: every agent node and ensemble member carries no `platform`/`model` — bind one per agent node (`implementer`, `committer`) and per reviewer member at install time.
- Gate command: `full-gates` is a failing placeholder. Replace it with the project's deterministic gates (formatter, linter, tests).
- Workdir: point the installed graph at the repository it should run in.
- Verdict file: a human approves by writing a line containing `VERDICT: APPROVED` to `.canopy/verdict` in the workdir; any other content (e.g. `VERDICT: REJECTED` plus notes) sends the spec back to the implementer.

The commit check uses the `{{spec_start_head}}` form. For the stronger
"this run's own committer landed a commit" check — immune to a
concurrent commit from outside the run — switch it to:

```sh
test -n "{{spec_committed_head}}" && test "$(git rev-parse HEAD)" = "{{spec_committed_head}}"
```

Install:

```sh
canopy graph install single-committer
```
