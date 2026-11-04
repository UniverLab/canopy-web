# canopy-builder

What this graph is for: the loop the lab actually runs on its own
branches. One spec at a time, on one locked repository: a designer plans
into a spec note, an implementer writes the code, a deterministic gate
script decides whether it holds, the reviewer locates every
requirement, the auditor repairs what it objects to in the working
tree, the gates run again, a single check node commits with the
spec's own message, and the docs are written and committed
before the repository is relocked.

Each of the five working roles is a round-robin ensemble, so a member
that hits a quota or a harness failure rotates to the next one instead
of failing the spec, and `gitkit` holds the repository so only this
graph's committer nodes may commit while the loop runs.

Use it when all of these are true:

- the work is a queue of specs on one branch of one repository;
- you have several harnesses or models to bind, not just one;
- you want every commit decided by a command, never by a model's mood;
- a failed spec should stop and be read, not be retried forever.

For a single spec, or a repo where a lock would only get in the way,
install [adversarial-developer](../adversarial-developer) first.

The flow, in order (nodes and ensembles):

1. `Start` (check) — a no-op, so the graph has exactly one node with no incoming edge.
2. `Lock repo` (check) — `gitkit lock` for eight hours. A lock that cannot be taken ends the spec at `Human verdict`.
3. `Designer` (round-robin ensemble, no commit rights) — investigates and saves the plan as its spec note. The note is the deliverable; every member writes the same note.
4. `Plan check` (check) — fails when the notes file has no `## Designer` heading, so an empty designer never reaches the implementer.
5. `Implementer` (round-robin ensemble, no commit rights) — implements the plan, leaves the tree uncommitted.
6. `Full gates` (check) — `<GATE-SCRIPT>`, holding the `cpu` mutex so two graphs do not compile at once.
7. `Reviewer` (round-robin ensemble) — locates every requirement at `file:line`. It does not fix and does not commit.
8. `Auditor` (round-robin ensemble) — reads the working tree (nothing is committed yet), repairs what it objects to, and never commits.
9. `Full gates after auditor` (check) — the same gate script over those repairs.
10. `Commit spec` (check, commit rights) — the single commit with `$CANOPY_SPEC_COMMIT_MESSAGE` (implementation and auditor fixes together), relocks, and pushes the branch.
11. `Unlock for documenter` (check) — releases the lock, because the documenter commits docs.
12. `Documenter` (round-robin ensemble, commit rights) — writes the user docs the change needs and commits them.
13. `Check docs committed` (check) — fails on a dirty tree, then pushes.
14. `Relock repo` (check) — takes the lock back for the rest of the queue.
15. `Human verdict` (check) — a deliberate stop. A FAIL that is a judgment ends the spec here instead of spinning.
16. `Resilience` (agent, the graph's infra node) — triages one failure as quota, glitch or defect, and can schedule the graph's own wake-up at a quota reset.

Fail and recovery edges:

- `Implementer` fail → `Plan check`, which passes the spec straight back to the `Implementer` unless the plan note is gone, in which case the `Designer` ensemble runs again
- `Full gates` fail → `Implementer`
- `Reviewer` fail → the `Implementer` ensemble
- `Auditor` fail → the `Implementer` ensemble
- `Full gates after auditor` fail → `Auditor`
- `Plan check` fail → the `Designer` ensemble
- `Check docs committed` fail → the `Documenter` ensemble
- `Documenter` fail → `Human verdict`
- `Designer` fail → `Resilience`
- `Resilience` pass → `Plan check`

Every `error` edge goes to `Resilience`, and a fail from `Lock repo`,
`Unlock for documenter`, `Relock repo`, `Commit spec`
or `Resilience` ends at `Human verdict`.

What to set before installing:

- **The gate script.** `<GATE-SCRIPT>` appears twice as a command and in
  the implementer's and the auditor's prompt. Replace it with the
  command that runs the project's own gates: formatter, linter at `-D
  warnings`, dependency audit, coverage floor and the full test suite. If
  your script takes the spec's starting commit, write
  `<GATE-SCRIPT> "{{spec_start_head}}"`, which is the form the lab uses.
- **gitkit.** The lock nodes and the committer node call `gitkit lock`
  and `gitkit unlock`, and a completion hook unlocks the repository when
  the run ends. Install gitkit on the path the daemon sees, and reword
  the `--reason` text to name your own queue.
- **Harnesses.** No node or member carries a `platform` or a `model`. Each
  ensemble has four empty members (`Documenter` has two), and `min_pass` is
  4 for the four-member ones and 1 for the `Documenter`; bind a platform and
  a model to every member, and keep them on different vendors where you can.
- **The push.** The committer node and `Check docs committed` run a
  plain `git push -u origin <branch>`. That needs a credential helper the
  daemon can use; add one to the command if your remote needs it.

Install:

```sh
canopy graph install canopy-builder
```
