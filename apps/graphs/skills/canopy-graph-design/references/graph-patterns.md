# Graph Patterns

Reusable graph patterns for Canopy graphs.

---

## 1. Feature Delivery Loop

Use when implementing a new feature with review and verification.

```text
implementer --always--> verifier --pass--> reviewer --pass--> finish_gate
                              \--fail-----------------------> implementer
reviewer --fail---------------------------------------------> implementer
finish_gate(pass_route=next_spec)
```

Best for:

- feature work
- larger refactors
- multi-step backend/frontend changes

---

## 2. Focused Bugfix Loop

Use when the graph has a strong deterministic check.

```text
fixer --always--> targeted_test --pass--> finish_gate
                         \--fail--------> fixer
finish_gate(pass_route=next_spec)
```

Best for:

- regressions
- failing test repairs
- crash fixes

---

## 3. Review-Driven Authoring

Use when quality of reasoning matters more than a shell check.

```text
author --always--> reviewer --pass--> approval_gate
                      \--fail--------> author
approval_gate(pass_route=next_spec, fail_route=author)
```

Best for:

- docs
- prompts
- architecture proposals
- migrations needing explicit approval language

---

## 4. External Intake to Internal Execution

Use when a first node extracts or discovers tasks.

```text
extractor --pass--> planner --pass--> implementer --always--> verifier
                                           ^                    |
                                           |-------fail---------|
```

Best for:

- reading tasks from issue trackers
- processing backlog files
- consuming MCP-fed work queues

---

## 5. Multi-Platform Cross-Check

Use when you want a second CLI/model family to catch what the first one missed, instead of a same-vendor reviewer marking its own work.

```text
implementer(claude/opus) --always--> crosscheck(opencode/qwen) --pass--> finish_gate
                                            \--fail-------------------> implementer(claude/opus)
finish_gate(pass_route=next_spec) --fail--> implementer(codex)
```

- `implementer` — `agent` node on one platform/model (e.g. `platform: "anthropic", model: "claude-sonnet-5"`).
- `crosscheck` — `check`/`agent` node on a **different** platform (e.g. `platform: "opencode", model: "qwen3-coder"`), reviewing the implementer's diff against the spec.
- `finish_gate` — routes on the cross-check verdict; on repeated failure, escalate to a third platform (e.g. `platform: "codex"`) rather than looping the same pair forever.

Best for:

- security-sensitive changes where a same-vendor blind spot is a real risk
- verifying that a fix isn't overfit to one model's interpretation of the spec
- setups where the user has multiple CLI subscriptions and wants them cross-validating each other

Rules:

- never assume the cross-check platform matches the implementer's — that defeats the purpose
- keep the cross-check prompt narrow (diff + spec + "find what's wrong"), not a re-implementation
- cap escalation depth (e.g. 1 cross-check retry, then 1 third-platform escalation) so the graph can't spin forever between two disagreeing models

---

## 6. Commit-on-Green Finish

Use only when the user explicitly allows commits inside the graph.

```text
implementer -> verifier -> reviewer -> commit_ready_gate
commit_ready_gate(pass)-> committer -> next_spec
commit_ready_gate(fail)-> implementer
```

Rules:

- commit node must not run before verification
- commit prompts should include commit policy and checkpoint expectations
- if commits are not allowed, replace `committer` with a summary/report node

---

## 7. Gated Implement (deterministic check before review)

The default shape for "an agent writes code, something must verify it, then it
lands". Three nodes, four edges.

```text
implement --pass--> check(build+tests) --pass--> review+commit
    ^                    |fail                        |fail
    +--------------------+<---------------------------+

implement --fail--> (no edge)   => spec fails honestly (e.g. CLI quota)
review    --pass--> (no edge)   => spec completed, advance
```

| from | cond | to |
|---|---|---|
| implement | `pass` | check |
| check | `pass` | review |
| check | `fail` | implement |
| review | `fail` | implement |

Why each piece:

- **`implement --pass-->`, never `always`.** An `always` edge routes a *failed*
  implement into the reviewer, which then approves work that was never written. A
  real run marked a spec `completed` with no commit behind it that way.
- **`check` sits before the reviewer**, so code that does not build or whose tests
  are red never reaches review. Another real run: the reviewer wrote
  `CHANGES_NEEDED: Implementation is broken` and the spec was still marked
  `completed`, because routing keyed on the run's status, not on the prose.
- **Auto-fixing commands should not bounce work.** Run `cargo fmt --all` (which
  rewrites) rather than `cargo fmt -- --check` (which fails). Only genuine
  breakage — compiler, linter, tests — should route back to `implement`.
- **The reviewer commits only the files it reviewed.** `git add -A` sweeps a
  previous spec's uncommitted leftovers into this spec's commit.
- **Make the reviewer prove the commit.** Its prompt must require
  `git log -1 --oneline` before reporting pass. A reviewer once returned
  `{"committed": true, "tests_passed": 601}` for a commit that did not exist.

### Reviewer prompt discipline

Once `check` runs before the reviewer, green gates say only *"nothing is broken"* —
they say nothing about whether the spec was **honored**. That distinction is the
reviewer's entire job, and it is the thing a cheap model quietly skips. Say so
explicitly:

- Open with a **zero-indulgence** instruction: do not approve out of courtesy, for
  effort spent, or because it "almost" meets the spec.
- State that **green gates are not evidence of compliance**. A missing required
  test is `CHANGES_NEEDED` even when the code works perfectly.
- Require a **verdict per requirement**, written out *before* the decision. A
  reviewer that must enumerate is a reviewer that must look.
- Make the asymmetry explicit: *"when in doubt, CHANGES_NEEDED — a bounce costs
  minutes, a falsely-closed spec costs days."*
- Tell it what its unique contribution is: the deterministic nodes already own
  "compiles", "tests pass" and "commit exists". **Judgment is all it adds.**

Observed limit: with a small/fast reviewer model this raises the floor but does not
guarantee it. In one real run the spec demanded three tests, the prompt said
"verify the three tests", and a free `flash` model approved a diff carrying one.
The deterministic nodes still held — nothing broken merged — but scope compliance
slipped. Budget for that when picking the reviewer's model, or accept the gap
knowingly.

Trade-off: the reviewer's honesty is still load-bearing for the **commit** itself.
Close that with a fourth node, `review --pass--> check_committed`, routing back to
`implement` on failure. Verify by **comparing `HEAD`**, not by matching the commit
message (the agent may drop the conventional-commit scope) and not by wall-clock
(the previous spec's commit is recent too).

The engine hands you the comparison point: **`{{spec_start_head}}`** expands to the
HEAD recorded when this spec started, per spec and per run.

```bash
test -z "$(git status --porcelain -- src/)" \
  && test "$(git rev-parse HEAD)" != "{{spec_start_head}}"
```

Earlier revisions of this file taught a marker file (`.git/canopy-prev-head`)
written by the gates node. **That is obsolete** — the marker no longer exists
anywhere in canopy, and it carried a real hazard `{{spec_start_head}}` does not:
the file survived daemon and PC restarts pointing at a stale HEAD, so a resumed
flow could read "HEAD moved" for a commit that never happened.

## 8. Resilience Branch (triage a failed implement)

Pattern 7 fails the spec the moment `implement` dies, so **nobody ever reads the
failure**. If the CLI died on a quota that resets at a known hour, that knowledge
is thrown away. Give `implement` two exits.

```text
implement --pass--> check --pass--> review+commit
    |                  |fail             |fail
    |fail              v                 v
    v               implement <----------+
resilience
    --pass--> implement     (fixed it -> retry)
    --fail--> (no edge)     (spec fails, but the autorun is already scheduled)
```

The `resilience` node (cheap model, short timeout) reads the failed implement's
output and:

1. repairs transient failures (bad command, missing dep) and reports **pass**, so
   the implement retries;
2. on quota exhaustion (`"You've hit your session limit · resets <time>"`), parses
   the time, calls `graph_control {action: "schedule_autorun", graph_id, at}`,
   then reports **fail** —
   the spec fails, but the graph wakes itself at exactly that moment;
3. **cleans the worktree if the dead implement left it dirty.** A quota death can
   land mid-edit; the next attempt would otherwise start on a dirty tree.

Rules:

- `implement`'s `pass` and `fail` conditions are disjoint, so this adds no
  ambiguity. Every node ends up with an incoming edge, so make `implement`
  `position: 1` — the engine falls back to the lowest position when no source node
  exists.
- Keep `resilience` on a different platform/quota than `implement`, or it will be
  dead exactly when you need it.
- Cap it: a `resilience -> implement -> resilience` cycle is bounded by the
  per-node iteration budget, but a resilience node that always reports pass will
  burn all five attempts.
- **Give the resilience node the clock.** Models do not know the current time, and
  "resets 6am" is ambiguous without it. A real run at 01:52 scheduled the autorun
  for 6am **of the next day** — a 23-hour stall. The prompt must require running
  `date -Iseconds` first, computing the next instant strictly after now, and
  sanity-checking that the result is less than 24 h away.

---

## Failure modes (field notes)

Real breakages seen running these patterns at scale. The engine is strict about
graph shape and fails hard, so validate before `graph_control` `run` (checklist in
`SKILL.md` → "Graph Validation").

### The `implement <-> review` cycle has no entry node

The most natural retry shape — `implement --always--> review` plus
`review --fail--> implement` — is a **cycle where every node has an incoming
edge**. The engine resolves a spec's start node as the one with no incoming edge,
so this shape historically failed *instantly* with `"Spec has no entry node"`:
graph `failed`, zero runs, `started_at == completed_at`. The engine now falls back
to the **lowest-`position`** node, so set the intended start to `position: 1` and
treat `position` as load-bearing. Don't depend on node insertion order.

### Duplicate outgoing edges → `"ambiguous outgoing edges"`

If two edges leave the same node, both match a result, and they point at
**different targets**, edge selection aborts and fails the whole graph — *after* the
node's work is done, so it's easy to miss in review. Byte-identical duplicates
(same target and condition) are now deduped instead of fatal, but still dedupe by
`(from_node, condition)` before calling `graph_edge` `add`. A `pass` edge and a `fail`
edge from the same node are fine.

### Node `config` sent as a JSON-encoded string

The MCP schema for `graph_node` `add`/`graph_node` `update` once declared `config` as an
untyped value, so clients serialized it to a *string*. The node stored fine and
then died mid-run with `"missing a platform/cli"`. The schema now declares
`"type": "object"` and serde rejects non-objects at parse time — but if you build
nodes by any other route (direct SQL), verify the stored config is an object.

### Agent CLI not resolvable by the daemon

Nodes spawn their CLI from the **daemon's** environment, not your shell. A binary
on your `$PATH` but not the daemon's fails to spawn mid-run — under systemd the
service PATH is minimal and may be a stale hand-written snapshot. Use an absolute
`binary` in `~/.canopy/config.toml` (re-read per node, no daemon restart needed)
or put its dir on the daemon's PATH. Beware: reinstalling the service rewrites
the unit file and can silently drop a hand-added PATH line.

### Agent quota / session limit mid-graph

A long multi-spec graph can outrun a CLI's session/usage quota. The agent node exits
non-zero with *"You've hit your session limit · resets &lt;time&gt;"* in its `stdout`.

- **Big spec → long run → burnt quota.** This is the real reason to keep specs
  small. It is not a graph bug.
- **Completed specs are skipped on relaunch**, so recovery is cheap: reset the graph
  (and the stalled spec) status and `graph_control` `run` again; it resumes at the first
  non-completed spec.
- **Don't poll with a recurring cron.** Use pattern 8: a resilience node parses the
  reset time and calls `graph_control {action: "schedule_autorun", graph_id, at}`,
  which wakes the
  scheduler exactly once at that instant. A blind cron retry wastes attempts
  against the per-node iteration budget.
- Spreading implement and review across different platforms (pattern 5) means one
  quota ceiling doesn't stall everything.

### A quota death can leave a dirty worktree

The CLI may work for many minutes, write a dozen files, *then* hit its limit and
exit non-zero. The spec fails with uncommitted, half-finished work on disk, and the
next attempt starts from there. Rule of thumb: if the partial work **compiles**,
keep it (the implement completes it); if it **doesn't**, discard it. Back it up
either way with `git stash create` + `git stash store`, which does not touch the
worktree.

### A daemon restart orphans the running graph

The graph row stays `running` with no process behind it. Scheduled autoruns cannot
rescue it (`is_fireable()` excludes `Running`). Recover with `graph_control` `pause` →
`continue` with `mode: retry_current_node`; the spec's own `running` status makes the
engine resume at its last node, so nothing is re-implemented. See the Recovery
Matrix in `mcp-tool-playbook.md`.

---

## 9. Triage Relay (route a reviewer failure, and carry its words)

Pattern 8 sends a *dead* implement to resilience. This one handles the other
failure: the reviewer ran fine and **asked for changes**. Those two look
identical to the engine — both are `fail` — but they need opposite responses.

```text
review --fail--> triage --pass--> implement   (a real change-request: go fix it)
                     \--fail----> resilience  (nobody reviewed: quota, empty, timeout)
```

The triage node is a **router**: a cheap model that reads one piece of text and
picks one of two exits. It does not read code, open files, or judge whether the
reviewer was right.

Its second job is the one that is easy to miss, and it exists because of a hard
engine constraint:

### `{{previous_feedback}}` carries exactly ONE hop 🔴

`previous_output` is **overwritten** at every step (`graph_engine.rs:1487`), never
accumulated. A node sees the immediately previous node's output and nothing
before it.

So on `review --fail--> triage --pass--> implement` there are **two** hops, and
the reviewer's change list reaches the implementer *only because the triage node
re-emits it*. Its prompt must say so in as many words:

> The next worker sees ONLY your summary. It never sees the text above.
> Anything you leave out is lost. Do not summarise, do not shorten, do not
> renumber — copy the list.

Consequences worth designing around:

- **A relay running on a cheap model is load-bearing.** It may decide to
  summarise a twenty-line change list into "fix the tests". Budget for that when
  choosing its model, and make the copying instruction the loudest part of the
  prompt.
- **Long chains lose their beginning.** In `architect → tester → implementer`,
  the implementer sees the tester and the architect's design is gone. Either
  every node relays the previous one (each copy a chance to drop something), or
  each node writes its artifact **to the repo** so the next reads it from disk.
  Tests are durable by nature; a design document is not unless someone writes it
  down.
- **When in doubt, route to the implementer.** A real change-request sent
  onward costs one cycle; a real review mistaken for a quota failure stops the
  graph for a human.

---

## 10. Crew Graph with a Chained Quality Pass

The production shape for a repo that receives a queue of specs on a feature
branch. Every agent step is an ensemble (see `SKILL.md` → Ensembles), every
verification is a deterministic check, and code quality is a second graph that
runs after the queue instead of inside every spec.

```text
Start -> Lock repo (gitkit lock) -> Designer[round_robin]
      -> plan-present check ($GITDIR/loop-design.md exists; fail -> Designer)
      -> Implementer[round_robin] -> Full gates (fail -> Implementer)
      -> Reviewer 1 presence[round_robin] (fail -> Implementer)
      -> Unlock -> Committer[cascade, commit_rights] -> Check committed
      -> Relock -> Reviewer 2 exercise+fix[round_robin]
      -> Full gates again (fail -> Reviewer 2) -> Commit R2 fixes (check)

every check --error--> Resilience (pattern 8) --pass--> plan-present check
lock/commit checks --fail--> "Veredicto humano" (exit 1 with the verdict text)
```

- **The designer writes its plan to disk** (`$GITDIR/loop-design.md`, outside
  the tree) and a check refuses to continue without it. Pattern 9's one-hop
  limit is why: the implementer, both reviewers and the bounced implementer
  all read the plan from disk, never from a relay.
- **The repo is locked while agents edit** and unlocked only around the
  committer, so a human (or another graph) cannot commit into the middle of a
  spec; the R2-fixes check commits with the spec's scope read from HEAD.
- **Hooks**: `on_spec_completed`/`on_completed` append to a log;
  `on_failed`/`on_blocked` wake the orchestrating session by name with the
  node and blocker; `on_completed` also launches the quality graph with a
  graph hook (`target_graph_id` + `idea`).

The **quality graph** is spec-less: it runs with an `idea` ("make the strict
gate green, then kill every mutant in the diff against develop") instead of a
queue.

```text
Lock -> Quality gate (fail -> Fixer[round_robin]) -> Reviewer[round_robin]
     -> Commit -> Mutants (CI, sharded) (fail -> Fixer) -> Unlock
```

- **Mutation testing runs in CI, never on the machine running the daemon.** A
  local run exhausted memory and the kernel killed the daemon with every graph
  on it. The check node dispatches the workflow, waits for the run to be
  *completed* (not for a watch command to return), reruns shards the runner
  lost once, and reports a shard that never reported as INCOMPLETE with its
  log — never as a pass.
- **The Fixer never applies a mutation by hand** to see what happens; it reads
  the survivor list and adds the test that kills it.
- **Equivalent mutants are excluded, not argued.** An exclusion names the
  function and the operator (never a line number, which moves), carries a
  one-line proof as its comment, and the Reviewer checks the proof. A proof
  that only holds because the code is dead means the fix is deleting the dead
  code, not excluding the mutant.
