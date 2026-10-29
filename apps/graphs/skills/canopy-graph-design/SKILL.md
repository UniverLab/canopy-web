---
name: canopy-graph-design
description: >
  Use this skill when the user wants to turn a recurring or multi-step process
  into a reusable Canopy graph, write specs for a backlog or pool, inspect or
  reshape an existing graph, or coordinate background agent/check/gate
  flows with approvals and retries. Prefer reusable graph patterns over
  one-off pipelines, and build against the MCP graph tools that actually exist
  in the environment.
license: MIT
metadata:
  author: jheison.martinez
  version: "3.22"
  framework: Canopy
  category: graph-orchestration
  last_updated: "2026-10-28"
---

# Graph Design

Design generic graphs for Canopy as editable graphs, not as one-off scripts.

This skill exists for planning and authoring **background graphs** — the team
graph and the specs it consumes — that users can later inspect, edit, and run
from Canopy.

---

## Mission

Translate a user goal into:

1. ordered specs in the tagged `<spec>` format, each carrying its own context
2. a reusable graph of `agent`, `check`, and `gate` nodes, with ensembles where
   one model is not enough
3. hooks that say what happens after: a log line, a follow-up graph, a message
   to the orchestrating session
4. a persisted graph built with MCP tools

The output must stay generic enough that different users can plug in different
CLIs, models, prompts, and verification commands.

---

## Design Expensive, Execute Cheap 🔴

**Design the graph and write the specs with the most powerful model the user
has access to.** Spec quality is the single biggest lever on graph economics:
a precise spec lets a cheap implementer land it in one or two iterations; a
vague spec makes even a strong implementer diverge, and divergence is paid in
iteration budget (5 entries per node or ensemble per spec), reviewer bounces,
and quota.

The asymmetry is deliberate:

- **Spec authoring / graph design** → strongest model available (one-time cost)
- **Implementation nodes** → mid-tier models guided by the spec's HOW
- **Review / resilience nodes** → cheap models with narrow, mechanical prompts

If the user is designing specs from a weak model's session, say so and
recommend switching for the authoring step.

---

## The Spec Contract: the tagged `<spec>` 🔴

Every spec must be executable by a colder, cheaper context than its author.
A spec that assumes the reader knows the conversation is a spec that will
diverge. `spec_edit` `create` takes one `<spec>` document with seven tagged sections;
three are required:

| Section | Carries |
|---|---|
| `<objective>` (required) | The outcome, and for a defect the measured evidence: the command, the input, the wrong output, the date, the commit. Observable, not aspirational. |
| `<functional_requirements>` (required) | Numbered, each one decided: exact files, functions, messages (quoted verbatim), exit codes, the tests to add by name and input, and the **evidence the report must paste** (the command run on a release build in a scratch dir and its output). This is what the reviewers check against. |
| `<non_functional_requirements>` | Size, speed, compatibility budgets. |
| `<constraints>` | What must not change; settled decisions. |
| `<in_scope>` | Files and modules the work may touch. |
| `<out_of_scope>` | Adjacent work that is explicitly someone else's. |
| `<guidelines>` (required) | Traps and house rules: where to run, what never to run, what never to write. |

Rules of thumb:

- If executing the spec correctly requires information that lives only in the
  author's head or chat history, the spec is not finished. Embed measured
  values and exact commands instead of pointing at where to find them.
- **A spec decides; it never asks.** If the text contains "choose", "consider",
  "if needed", "pick one" or "whichever you prefer", the author left their own
  work undone and handed it to the model with the *least* context in the chain.
  Measured on one queue, same graph and same models: the spec that named the
  defect at file:line with the decision already made landed in **1 implementer
  round**; the one that asked the implementer to choose between two semantics
  took **4**. Write the decision into the spec as settled. The *reasoning*
  behind it goes to the knowledge layer (`intelligence_upsert`), not into the
  spec — a spec carries the what and the how.
- **Demand evidence, not claims.** End the requirements with what the report
  must paste: the exact command on a release build in a scratch directory and
  its output. A reviewer can check a pasted output; it cannot check "verified".
- **Name what must never be touched.** Agents run with the user's HOME: say
  which caches, configs and binaries are off limits (`~/.local/bin`, the
  tool's own config dir, anything a `new`/`refresh` command would overwrite).
- **Name the spec with the commit it will become**: a Conventional Commits
  title, `fix(tui): open F1 from inside a session`. Canopy parses the type and
  scope, stores the subject, numbers the spec by change type (`FIX-7`) and
  builds its commit message; commit nodes read it as `{{spec_commit_message}}`
  or `$CANOPY_SPEC_COMMIT_MESSAGE`, so the commit is deterministic. Never write
  a code by hand, in the name or the commit. A graph with `require_spec_type`
  refuses untyped specs in its queue.
- Narrow intent: one defect or one feature per spec. Big specs outrun CLI
  session quotas mid-run — that alone justifies splitting.
- Write specs and node prompts in **English** — models follow English
  instructions more reliably.

---

## Spec Groups: shared warm context 🟡

By default every spec in a queue runs from a **cold** harness session — the
implementer re-analyzes the repo from scratch. Specs that build on each other
can instead share **one warm session**: the `group` argument on
`queue` `add_spec` tags members into a named group, and a grouped spec resumes
the session captured by the previous **successfully-completed** sibling in that
group instead of starting cold. That carries the earlier spec's mental model
(files already read, decisions already made) forward into the next.

**Group only a sequence over the same surface** — `T1 theme struct → T2 header
consumes it → T3 panels consume it → …`, or one feature split into ordered
steps. Grouping pays off exactly when step N assumes step N-1's code.

**Do not group unrelated specs.** A shared session pollutes context: an
independent bugfix inheriting an unrelated feature's session reasons over stale
assumptions. Isolation is the correct default; grouping is the exception you
justify. Separate bugs and unrelated areas stay ungrouped and cold.

- **Order is load-bearing.** The warm session flows in queue order, so the
  foundational spec must sit first in the group.
- **Only success seeds the session.** If a grouped spec fails, the next sibling
  starts cold rather than resuming a broken session — a failed run is not a
  context worth inheriting.
- Grouping is a property of queue membership, not of the spec: the same spec
  can be ungrouped in one queue and grouped in another. Set it when adding
  (`queue` `add_spec` with `group`; a grouped add lands after the group's last
  pending member), or change it in place with `queue` `set_group` (or
  `canopy queue group`). `queue` `set_group` moves the member next to its group.
- A group's pending members must stay contiguous. `queue` `reorder` refuses an
  order that would split a group and changes nothing; reorder around the group
  instead.

---

## What A Node Can See 🔴

`{{previous_feedback}}` carries the output of the **immediately previous node
only**. The engine overwrites the previous output at every step and never
accumulates it — so a node has no access to
anything that happened two hops back.

This is the constraint that shapes every graph longer than three nodes:

- On `review --fail--> triage --pass--> implement`, the reviewer's change list
  reaches the implementer **only because the triage node copies it forward**.
  That relay is not bureaucracy; remove it and the feedback is gone.
- On `architect --> tester --> implement`, the implementer sees the tester and
  the architect's design has vanished. Either every node relays the previous
  one — each copy a chance to drop something, usually on a cheap model — or
  **each node writes its artifact to the repo** and the next reads it from
  disk. Tests are durable by nature; a design document is not unless someone
  writes it down.

Design the chain short, or give it durable ground to stand on. See
`references/graph-patterns.md` → pattern 9.

**Spec notes are the shared working memory.** Every spec carries one note per
owner (per node, or per ensemble when the writer is a member). A node records
its plan, decisions or open questions with `spec_edit` `note_write`
(`run_id`, `body`)
(body at most 2 500 characters). Every later agent node of the same spec
receives the notes in a `[SPEC NOTES]` section (5 000-character budget, never
truncated mid-note), so a Designer's plan reaches the implementer without a
temp file. Notes survive bounces, resumes and `graph_control` `continue`.
`graph_control` `reset` keeps them unless `clear_notes: true`. Read a spec's notes with
`spec` `notes` or `canopy spec notes <spec-id>`.

---

## Ensembles: a crew instead of one model 🔴

A single agent node dies with its platform: one quota reset, one gateway
outage, and the spec fails. An **ensemble** puts several members (each its own
platform + model, optionally its own `prompt_override`) behind one logical
step, created with `graph_ensemble` `add` and reshaped with
`graph_ensemble` `update` without touching member nodes. Three kinds:

| Kind | Behaviour | Use it for |
|---|---|---|
| `parallel` (default) | Every member runs; the step passes when `min_pass` of them pass. | Review panels where independent votes matter; give members different `prompt_override` angles (correctness, security, conventions). |
| `round_robin` | One member per entry, rotating on every re-entry. | Designer, implementer, reviewers: a bounce lands on a *different* model with fresh eyes, and quota spreads across platforms. |
| `cascade` | Members in order; the first pass wins. | The committer: a cheap reliable model first, fallbacks behind it. |

Rules:

- **Mix platforms in every ensemble.** Members on one platform share one quota
  and die together. Before a run, `graph_control` `preflight` probes every distinct
  platform+model pair; replace a pair it reports broken before launching, not
  after the first failure.
- **A crew is a snapshot of today's quota, not part of the design.** Which
  platforms have quota changes from week to week: subscriptions run dry,
  weekly limits reset, free tiers come and go. Pick members right before each
  launch, or before resuming a paused graph, from what is available at that
  moment. Then run `graph_control` `preflight`. Give graphs that run at the same time the
  same crew, so a provider outage hits them alike and one fix covers both. Do
  not rewrite the crews of idle graphs in advance: an idle graph's crew is
  chosen when it next runs. When a provider's quota comes back, its models go
  back into the rotation.
- **Exactly one commit holder.** `commit_rights` marks the ensemble (or node)
  allowed to write git history; every other prompt says "never commit".
- **Chain without relay nodes.** `on_pass_to`/`on_fail_to` accept another
  ensemble's id, and `add_entry_from` lets several nodes enter one ensemble
  (a failing gate and a bouncing reviewer both entering the implementer).
- **Order members by cost of a wasted turn.** In a `round_robin` the first
  member takes the first attempt: put the strongest model where a wrong first
  attempt is expensive (the designer), the cheapest where attempts are mostly
  mechanical (the committer).
- The attempt ceiling applies per ensemble: 5 entries per spec per run
  (`graphs.max_iterations_per_node`).
- **Member caps are per kind and configurable.** A `parallel` ensemble takes
  2–8 members by default (`graphs.ensemble_max_members_parallel`, up to 16). A
  `cascade` or `round_robin` takes 2–16 (`graphs.ensemble_max_members_sequential`,
  up to 32). Do not assume the old fixed 8.
- **Bind a crew instead of copying members.** A crew is a named, ordered member
  list (`crew` `create`). An ensemble or node binds it with `crew: "name"` (the
  node config, or `graph_ensemble` `add`/`graph_ensemble` `update`), so a role's
  members are written once. `crew` `update` reaches every bound ensemble at its
  next dispatch. `crew` `delete` is refused while anything binds the crew. Use
  `crew` `assignments` to see every harness/model a graph uses, with no prompt text.
- **Unavailable members are skipped, not edited.** Declare a platform or model
  out with `harness` `roster_set` (optionally `until`). Dispatch then skips it: a parallel
  quorum counts only the available members, cascade falls through, and
  round_robin steps over it. An ensemble with too few members left blocks the
  spec, with a blocker that names the pair. It does not burn an attempt. Clear
  the entry with `harness` `roster_clear`. `graph_control` `preflight` never probes an unavailable
  pair.

---

## Hooks: what happens after 🟡

A graph's work is not finished when its last node passes: someone has to know,
and often something else has to start. `graph_edit` `update` takes an event-keyed
`hooks` map (`on_spec_completed`, `on_completed`, `on_failed`, `on_blocked`),
each an ordered list. Each hook is exactly one mode:

- **command** — a shell line with the `CANOPY_HOOK_*` variables exported
  (`GRAPH_NAME`, `SPEC_NAME`, `NODE`, `BLOCKER`, …). **Never start a canopy
  binary from a hook**: daemon-startup recovery kills live runs, including the
  one that fired the hook. Do not use a hook as a run log either: the engine
  already records the history. Read it with `graph` `events` (or
  `canopy graph log`), so no `printf >> file` hook is needed.
- **interactive** — a prompt delivered into a live session by
  `target_session_name` (resolved by name on every fire) or by
  `target_session_id` (exact; it survives a restart or resume canopy
  recognizes — same id, same name — but a resume canopy does not recognize
  comes back as a new session with a fresh id and a fresh generated name,
  and firing then fails naming the old id). Prefer the name. Use it to
  wake the orchestrating session on `on_failed` / `on_blocked` with `{{node}}`
  and `{{blocker}}`, and on `on_completed` with what to review. The daemon's
  scheduler delivers the message on its next tick whether or not a TUI is
  attached; if the target session is gone by then, the prompt is preserved
  for recall in that project and a notification says the session was not
  found. The target session itself keeps running in the daemon meanwhile.
- **graph** — `target_graph_id` launches another graph in-process, with a
  `queue_id` or an `idea`. Use it to chain phases (pattern 10: a spec graph
  hands its branch to a spec-less quality graph).
- **agent** — a one-shot agent run with platform/model/prompt.

Hooks are not retroactive: one registered after its event fired does not fire.
Hooks are read when each event fires, so a `graph_edit` `update` of hooks on a running
graph changes the events still to come. The response names those events. A
failing hook is recorded and never changes the graph's status.

---

## Core Rules

### 1. Model processes as graphs, not lists

- `agent` — produces or analyzes work
- `check` — verifies with commands or deterministic checks
- `gate` — decides the next route based on prior output
- `router` — routes by token matching. With `"decision": true` it asks the
  platform's decision model (a typed-choice classifier, no agent spawned) which
  declared route to take, with an optional `min_confidence` that sends
  low-confidence answers to the fallback. The platform must declare
  `decision_args` in the registry, or the node is refused.

If the graph needs iteration, use edges and gates. If it is linear, keep it
simple.

### 2. Preserve genericity

Never assume one CLI platform, one model vendor, one review style, or one
commit strategy. Any node may use Copilot, OpenCode, Kimi, local MCP-driven
agents, or other supported CLIs. Design prompts and checks accordingly —
platform-specific behavior belongs in the platform registry, never hardcoded
into prompts.

### 3. Ask before irreversible behavior

Before you create or run a graph, clarify: draft or run; which verification
commands are authoritative; whether commits are allowed inside the graph;
whether blockers should pause or hard-fail.

### 4. A graph does not have to be run by hand

`graph_edit` `create`/`graph_edit` `update` accept an optional `trigger`: **manual** (default),
**cron** (5-field expression, local wall-clock), or **watch** (file/dir
changes with debounce). A one-off migration is almost always manual; a
recurring maintenance sweep is a candidate for cron or watch. See
**[references/mcp-tool-playbook.md](references/mcp-tool-playbook.md)** for the
exact fields.

### 5. Reuse patterns, adapt prompts

Reuse graph patterns from
**[references/graph-patterns.md](references/graph-patterns.md)**, but adapt node
prompts, CLI/model selection, verification commands, retry routing, and
blocker behavior to the project.

### 6. Design for the process dying mid-run

Loops outlive daemon restarts and PC reboots badly unless you plan for it:

- A restart leaves the graph `running` with nobody executing it (a zombie).
  Recovery is `graph_control` `pause` → `continue` with `mode: retry_current_node` — see the
  Recovery Matrix in `mcp-tool-playbook.md`. Scheduled autoruns can NOT
  rescue a `running` zombie.
- Resume at (or before) an idempotent node. Deterministic checks that
  recompile and re-run tests are safe re-entry points; marker files written
  by earlier nodes are stale after a restart.
- Give failure knowledge somewhere to go: a resilience branch (pattern 8)
  that triages the failed implement — quota deaths schedule their own
  autorun instead of silently losing the reset time.
- A daemon stop or crash finalizes the killed node as **interrupted** and
  routes no edge, so its fail edge never fires. On the next start the graph
  is `Paused` with the spec `Interrupted`. `graph_control` `continue` with
  `mode: retry_current_node` re-runs that same node with the same input.
- A parallel or round-robin ensemble that ends with no verdict pauses with a
  blocker and marks the spec `interrupted`, not `failed`. Edit the members if
  they are at fault, then `graph_control` `continue` with `mode: retry_current_node`.
  A `graph_control` `run` on a blocked graph is refused, so a blind relaunch cannot hide the blocker.
- **Directed run.** When everything before a node is already good, start a
  spec at that node: `graph_control` `continue` with `mode: run_from_node` (and
  `spec_id`), or `graph_control` `run` with `start_node_id` for the first spec. It
  reuses the recorded output of every earlier node and refuses, naming the node, when a reachable
  prompt or check needs output that was never recorded, or when an upstream
  node's latest run failed. An ensemble member is the exception: it is judged
  by the ensemble's quorum — its join node's run for the spec — so a member
  that failed while the quorum passed is a satisfied prerequisite, and a
  failed quorum refuses the run and names the join. On an idea-driven
  graph (run with an `idea`, no bound specs) the same calls resume the stored
  idea run — `{{spec_content}}` renders the idea the graph last ran with and
  no spec needs naming; an idea graph that has never run is refused, naming
  `graph_control` `run` with an `idea` as the way to start one.
- A spec that ends `Failed` or `Interrupted` blocks the next spec on that
  workdir only when its recorded dirty paths overlap the ones dirty now;
  `Skipped` specs never block, and a record naming files no longer dirty never
  blocks. A spec resuming exactly the dirt its own latest run recorded (the
  restart-recovery case) proceeds without `allow_dirty_start`. Otherwise
  `graph_control` `run` refuses and names the blocking spec: finish, reset or remove
  that spec, or set `allow_dirty_start`.
- **Sandboxed runs.** `graph_control` `run` with `sandbox: true` runs the graph in a temporary
  git worktree on a `canopy/sandbox-*` branch instead of the operator's
  checkout. A completed run removes it only when the branch holds no unique
  commits and the worktree has no uncommitted files; a **failed run always
  keeps it**, so `graph_control` `continue` resumes inside that worktree (a resume whose
  worktree is gone is refused, naming the sandbox id — it never falls back to
  the original workdir). Land or discard a leftover sandbox through the
  `sandbox` MCP tool — `list`/`get` to inspect (`graph` `get` reports the
  graph's newest sandbox as `{id, status}`), then `land` or `discard`
  (`discard` needs `force: true` to delete unique commits) — never with a
  raw `git merge`, and never relaunch a fresh run over the same work.

### 6b. Who supervises the graph — the recovery hierarchy

There are three places recovery logic can live. Order them by determinism,
and push each responsibility as far up this list as it can go:

1. **Engine guards (deterministic, always right):** boot reconcile of zombie
   runs, empty-spec-set launch errors, stale-spec recovery, pool-aware
   autoruns. Anything expressible as a state-machine rule belongs HERE, in
   the daemon — not in any agent's prompt.
2. **The in-graph resilience node (LLM, language only):** its unique value is
   reading prose the engine can't parse — "resets 5:10pm" — and converting it
   into one scheduling call. Keep it on a platform that reliably COMPLETES
   runs; a resilience that times out is a resilience that doesn't exist.
3. **An external watcher agent (LLM on cron): last resort, and know the cost.**
   Field evidence from running one at scale: it saved two overnight runs, and
   it also *falsely completed* a graph by relaunching without its pool, left
   another stuck in `draft` by resetting and never relaunching, mangled its
   own report JSON for hours, and burned a run every 15 minutes to conclude
   "healthy". An LLM watcher acts on state it half-understands with tools
   that let it half-recover. If you deploy one anyway: give it a closed
   decision table, forbid every mutating call not in that table (especially
   pool-less `graph_control` `run`), and prefer wiring its enable/disable to the
   resilience node so it only lives during recovery windows.

Rule of thumb: **no LLM in the deterministic part of the critical path.**
When you catch a watcher doing state-machine work, that work is an engine
feature request — file it, don't re-prompt.

### 7. Checks are hermetic, versioned and cheap

A check node runs with the user's HOME and environment. Make it safe to run a
hundred times:

- **Put the gate in the repo** (`scripts/check-*.sh`) and call it from the
  node, so agents run the exact same gate before reporting pass and the gate
  is reviewed like code. Scope it to the spec's change with
  `--changed "{{spec_start_head}}"`.
- **Check commands take markers, not `{{spec_content}}`.** Use `{{spec_name}}`,
  `{{spec_id}}`, `{{workdir}}` and the commit markers. They are shell-quoted, so
  do not wrap them in other quotes. For the spec text, read
  `"$CANOPY_SPEC_FILE"`. For the notes, read `"$CANOPY_SPEC_NOTES_FILE"`. Any
  unknown `{{…}}` fails the node before the command runs. `graph_control`
  `preflight` reports it first.
- **Never touch state outside the repo**: no tool command that refreshes a
  cache from the network, rewrites a user config, or installs a binary. If the
  tool under test has such a command, the gate renders or copies around it.
- **Offload what can kill the machine.** A local mutation-testing run once
  exhausted memory and took the daemon down with every graph on it; it runs in
  CI now, and the graph only waits for the result.
- **Never run the orchestrator itself** (a `canopy` binary) from a check or
  hook.

---

## Construction Playbook

1. **Understand the target outcome** — deliverable, hard constraints, allowed
   tools/CLIs, required validations, parallelism.
2. **Split into specs** — ordered, independently understandable, small enough
   to validate, each a tagged `<spec>`. Bugs before quality work before
   features.
3. **Pick a graph shape** — linear, review loop, verify loop, gated implement
   (pattern 7), resilience branch (pattern 8), crew graph with a chained
   quality pass (pattern 10), or a fusion/join shape. Decide which nodes are
   ensembles and wire the hooks.
   **Route the implement's success edge with `pass`, never `always`.**
4. **Validate the graph** — read
   **[references/graph-validation.md](references/graph-validation.md)**
   immediately before creating: entry node, ambiguous edges, timeouts, gate
   tokens, PATH resolution. Every rule there broke a real run.
5. **Persist via MCP tools** — prefer **`graph_edit` `import`**, which builds the whole
   graph in one call and validates it all-or-nothing; fall back to
   `graph_edit` `create` → nodes → edges only when there is no document yet, and
   `graph` `export` the result so the next one is a single call. Run
   **`graph` `validate`** on any document you did not author, or are about to
   hand to someone else — it runs import's checks without writing anything.
   A graph already published in the catalogue needs neither document nor
   hand-building: **`graph_edit` `install` with `{ref, workdir, ...}`** (CLI
   `canopy graph install <ref>`) fetches it through graphs.univerlab.org —
   which is what counts the install — validates it, installs its bundled
   presets and imports it as a new graph in one call. It writes nothing on
   the first call: without **`accept: true`** it returns `{needs_review:
   true, review}` — every shell command the document runs, every prompt's
   first 3 lines and line count, and the attention marks for dangerous
   shapes — so show that review to your user, then call again with `accept:
   true` (official documents included; never auto-accept). A draft from the
   editor (`canopy graph install draft:<id>` / `graph_edit {action: "install",
   ref: "draft:<id>"}`, id 26 lowercase base32 characters) is the same flow with
   two extra rules: it lives 30 minutes and **one** install — the review
   call's fetch consumes it and the daemon parks that body for `accept:
   true`, so a refusal or an error means it is gone; ask for a new link
   rather than retrying — and nobody reviewed it, so the review you show is
   the user's only check. A single reusable node needs neither hand-building
   nor a full graph document:
   **`node` `install {ref}`** (CLI `canopy node install <ref>`) fetches the node
   document through the same catalogue and ref grammar, under the same
   `accept` gate, then `graph_node
   {action: "add", node: "<name>", config_overrides: ...}` (or `graph_ensemble
   {action: "add", node: "ensemble-proposers", members: [...]}` for the builtin ensemble,
   whose members still need a platform each) instantiates it — an agent
   node document carries no harness, so the overrides must supply
   `platform` (or `cli`/`crew`). Then `graph_control` `preflight`
   before spending a real run. Order, deletes, recovery and the
   export/import contract in
   **[references/mcp-tool-playbook.md](references/mcp-tool-playbook.md)**.
6. **Summarize before running** — graph name, specs in order, graph, chosen
   CLIs/models/checks, and what still needs user confirmation. Only call
   `graph_control` `run` after explicit approval or direct instruction.

---

## Authoring Guidelines

### Agent nodes

Explicit configs: platform, model, `prompt_template` (e.g.
`{{spec_content}}\n\n{{previous_feedback}}`), `timeout_minutes`. Prompts state
the goal, expected outputs, constraints, and when to report blocker vs fail.

Placeholders are checked when you write the node, not when a member spawns:
`{{output:<name>}}` must name a node in the same graph — an ensemble has no
readable output, so reference its quorum node — and anything the engine cannot
bind is refused by `graph_node` `add`/`graph_node` `update` (and by
`graph_ensemble` `add`/`graph_ensemble` `update` for the shared prompt and every
override). Escape a marker meant as literal text as `\{{...}}`.

`prompt_preset` names a preset file (`<canopy_dir>/prompts/<name>.md`, or a builtin:
`implementer`, `reviewer`, `resilience`), and export bundles every custom
preset the graph's agent nodes reference — the full text travels in the
document's `prompt_presets` array, so a shared graph arrives with working
nodes and no sidecar files. On import each bundled preset is installed when
absent locally; an identical local file is a no-op, and a differing one
refuses the import naming the preset — a locally edited preset is never
overwritten. A preset the document neither bundles nor finds locally still
refuses the whole import, naming every unknown preset. When you hand a document
to another machine, bundle its presets and run `graph` `validate`: it refuses a
`prompt_preset` that is neither bundled nor builtin, so no node of the shared
document depends on a preset that happens to be installed here. `graph_edit` `install`
follows the same refusal rule, and is the only graph call that can replace a
differing local preset on purpose (`overwrite_presets: true`, CLI
`--overwrite-presets`).

### Check nodes

Real verification, not vague "looks good" logic:
`cargo fmt --all && cargo clippy --all-targets -- -D warnings && cargo test`,
`npm test`, `pytest tests/auth -q`, domain-specific smoke checks. Cap noisy
output (`| tail -60`) so a 65 KB test log never rides into the next node's
argv. Set `timeout_seconds` explicitly.

### Gate nodes

Use gates when routing depends on semantics, not just exit codes. Gate on a
strict token (`APPROVED`), never on a word that can appear in narration.

### Two reviewers, two questions

Split review so each reviewer has one checkable question:

- **Reviewer 1 — presence.** Every numbered requirement located at
  `file:line`, every requested test found by name, nothing out of scope. It
  does not run anything and does not judge taste.
- **Reviewer 2 — behaviour.** It exercises the change the way a user would
  (a release build run in a scratch dir, the output inspected) and fixes what
  it finds in the working tree; a deterministic check re-runs the gates and a
  check node commits its fixes.

A presence reviewer that also judges behaviour does neither well; a behaviour
reviewer that never ran the binary has not reviewed.

---

## Progressive Disclosure

- **[references/graph-patterns.md](references/graph-patterns.md)** — reusable
  graph patterns (including pattern 10, the crew graph with a chained quality
  pass) + field notes from real failures. Read when choosing a shape.
- **[references/graph-validation.md](references/graph-validation.md)** — the
  pre-run checklist. Read immediately before persisting a graph.
- **[references/mcp-tool-playbook.md](references/mcp-tool-playbook.md)** —
  tool order, triggers, mutation heuristics, recovery matrix. Read immediately
  before creating, extending, or recovering a graph.

See **[README.md](README.md)** for overview and usage.
