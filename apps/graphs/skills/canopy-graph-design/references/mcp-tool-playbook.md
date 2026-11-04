# MCP Tool Playbook

Recommended tool order for creating and refining Canopy graphs with the currently available MCP tools.

---

## Create a New Loop

### The default: one call 🔴

**`graph_edit {action: "import", document, workdir}` builds an entire graph in a single call.**
The document is what `graph` `export` returns: name, description, nodes (with full
prompts and commands) and edges. Edges reference nodes **by name**, not by id,
which is what makes it portable. Validation is **all-or-nothing** — if any part
is rejected, nothing is written.

Prefer it. Building a 9-node graph by hand is ~28 calls, each re-sending the
conversation; the same graph as a document is one. And a malformed document
fails loudly and atomically, where hand-built graphs fail *silently*: a missing
`fail` edge is a property of the whole shape that no individual `graph_edge` `add`
call can see (graph-validation rule 10).

- `graph {action: "export", graph_id}` produces the document. `graph_edit` `import`'s
  response lists every agent node left without a platform.
- Ids, workdir, specs and run state are never exported. The entry point is
  implicit: the node with no incoming edges.
- Import always creates a **new** graph; it never updates one. A name collision
  gets a numeric suffix, and the response says which name was used.
- `prompt_template` text rides inside the document, and a node's custom
  `prompt_preset` rides with its full text in the document's `prompt_presets`
  array (builtins — `implementer`, `reviewer`, `resilience` — are never
  bundled). `graph_edit` `import` installs each bundled preset into
  `<canopy_dir>/prompts/` when no file with that name exists; an identical
  local file is a no-op, and a differing one refuses the whole import naming
  the preset, so a locally edited preset is never overwritten. A preset the
  document neither bundles nor finds locally still refuses the whole import,
  naming every unknown preset.

- `graph {action: "validate", path? | document?}` (exactly one of `path`/`document`) runs
  every structural check `graph_edit` `import` runs plus the sharing rules, with no
  database and no workdir. Call it on a document you did not author, or are about to hand to
  someone else, before importing: it reads nothing local, so a green report
  means the document carries everything its nodes need (`graph_edit` `import` can
  still refuse to overwrite a locally edited preset file of the same name). It
  refuses a `prompt_preset` that is not bundled in the document or a builtin,
  and returns every problem found with a JSON path
  (`nodes[3].config.prompt_preset`) instead of only the first. A single node
  document (`format_version`, `name`, `kind`, `config`, optional
  `description`/`preset`) is validated the same way: slug name, authorable kind
  (`join` refused), known config keys, and no `platform`/`model`/`cli` anywhere
  in the config — those belong to the installer. The command line equivalent is
  `canopy graph validate <path> [--json]`.

- `graph_edit {action: "install", ref, workdir, name?, overwrite_presets?, accept?}` installs
  a graph published in the catalogue (base `https://graphs.univerlab.org`, the
  `graphs.catalogue_url` setting) in one call. `ref` is `<slug>` for an
  official graph or `<owner>/<repo>/<slug>` for a community one, each with an
  optional `@<ref>` version suffix; anything else is refused with the accepted
  forms. It makes exactly one GET through the catalogue — that request is what
  counts the install, and there is no other network traffic — then runs the
  same validation as `graph` `validate` (every problem listed, nothing written).
  Without `accept: true` it stops there: it writes nothing and returns
  `{needs_review: true, review}` where `review` is `{name, source, commands,
  prompts, attention}` — every shell command labelled by node or hook, every
  prompt with its first 3 lines and total line count, and the attention marks
  for dangerous shapes (pipe to shell, sudo, rm -rf, chmod 777, git push/--force,
  sensitive-path write, eval, base64 -d, pipe to python/node). **Show that
  review to your user and only then call again with `accept: true`** — official
  documents are never exempt, and a document the catalogue removed after a
  community report is refused with the reason and issue. With `accept: true` it
  installs the bundled presets with `graph_edit` `import`'s refusal rule, and imports
  through the same all-or-nothing path: always a new graph, a numeric suffix
  when the name is taken. `workdir` must be absolute and exist; `name`
  overrides the document's name. A local preset file whose content differs
  refuses the whole install naming the file unless `overwrite_presets: true`.
  The response carries the same review plus the new graph id and name, the
  workdir, the presets written, and the agent nodes still without a
  platform/model together with the next command to assign them. The command
  line equivalent is
  `canopy graph install <ref> [--workdir <dir>] [--name <name>]
  [--overwrite-presets] [--yes] [--show-prompts] [--json]` (workdir defaults to
  the current directory); the CLI prints the same review, then asks
  `Install <name> from <source>? [y/N]`, refuses without a TTY unless `--yes`,
  and never skips the review.

- `node` `install {ref, overwrite_presets?, accept?}` installs one shareable node
  document published in the same catalogue (`graphs.catalogue_url`) — `ref`
  is `<slug>` or `<owner>/<repo>/<slug>`, each with an optional `@<ref>`
  suffix. It validates exactly as `graph` `validate` would (a graph document
  is refused), and follows the same `accept` gate as `graph_edit` `install`: without
  `accept: true` nothing is written and the review is returned for you to show
  your user; with it, the bundled `preset` goes into `<canopy_dir>/prompts/`
  with the same no-silent-overwrite rule as a graph install, and the document
  is written to
  `~/.canopy/nodes/<name>.json`, where it shadows a builtin of the same
  name. `node` `list` shows installed copies and the builtins embedded in the
  binary (`implementer`, `cargo-gates`, `reviewer-committer`,
  `commit-check`, `resilience`, `ensemble-proposers`), each marked
  `installed` or `builtin`; `node` `remove {name}` deletes an installed copy
  (a builtin with no override is refused). `graph_node {action: "add", node:
  "<name>", config_overrides: ...}` is the alternative to `kind` + `config`
  (shallow merge, overrides win); an agent node document carries no harness,
  so the overrides must supply `platform` (or `cli`/`crew`) or the call is
  refused naming the document. `graph_ensemble {action: "add", node:
  "ensemble-proposers", members: [...]}` supplies the shared prompt, member
  count and ensemble shape from the document, but every member still needs
  its own platform. The command line equivalents are `canopy node list
  [--json]`, `canopy node install <ref> [--overwrite-presets] [--yes]
  [--show-prompts] [--json]`, and `canopy node remove <name> [--json]` (all
  local, no daemon).

### Building by hand (when there is no document yet)

1. `graph_edit` `create` — set `trigger` here if the graph should fire on its own (see below); omit it for a manual-only graph
2. `graph_node` `add` for each node — insertion order sets `position`, and `position` is load-bearing (graph-validation rule 1)
3. `graph_edge` `add` for routing
4. `graph` `get` to verify the final shape against `references/graph-validation.md`
5. `graph` `export` it once it works, so the next one is a single call
6. `graph_control` `preflight` with `{graph_id}` — probes every distinct platform+model the graph references, before a real run spends anything on a harness that cannot answer. Confirm a `broken` verdict with `harness` `probe` (`{platform, model}`) on its own before rewiring anything: a pair preflight calls broken can answer fine when probed alone.
7. summarize the graph to the user
8. `graph_control` `run` only after explicit approval or direct instruction — not needed at all if a cron/watch trigger will fire it

Specs are **not** part of the graph any more: they live in the standalone
backlog (`spec_edit` `create`) and reach the graph through a queue — see the Queues
section below. `graph_edit` `attach_spec` binds a spec to the graph itself and is the older
shape; prefer `spec_edit` `create` + `queue`.

---

## Setting a Trigger (cron / watch / manual)

`graph_edit` `create` and `graph_edit` `update` both take an optional `trigger` object (`GraphTriggerParams`). Omit it on create for a manual loop; omit it on update to leave the current trigger untouched.

| Field | Applies to | Notes |
|---|---|---|
| `kind` | all | `"cron"`, `"watch"`, or `"manual"`. `"manual"` (or empty) clears any existing trigger. |
| `schedule` | cron | 5-field cron expression, required when `kind = "cron"`. Evaluated in local wall-clock time, same as agent triggers. |
| `path` | watch | Absolute path to a file or directory, required when `kind = "watch"`. |
| `events` | watch | List of `"create"`, `"modify"`, `"delete"`, `"move"`, or `"all"`. Required (non-empty) when `kind = "watch"`. |
| `debounce_seconds` | watch | Optional, default `2`. |
| `recursive` | watch | Optional, default `false`. |

Example — nightly cron graph via `graph_edit`:

```json
{
  "action": "create",
  "name": "nightly-docs-sync",
  "workdir": "/home/user/project",
  "trigger": { "kind": "cron", "schedule": "0 2 * * *" }
}
```

Example — clearing a trigger back to manual via `graph_edit` `update`:

```json
{ "action": "update", "graph_id": "...", "trigger": { "kind": "manual" } }
```

A fireable graph (cron/watch) will not re-trigger itself while it is already `Running` or `Paused` — no need to guard against overlapping runs when designing the graph.

---

## Refine an Existing Loop

1. `graph` `list` or `graph` `get`
2. inspect current specs, nodes, edges, and statuses
3. choose the lowest-risk path:
   - **surgical mutation** with `graph_edit` `update`, `graph_edit` `update_spec`, `graph_node` `update`, or `graph_edge` `update` for targeted changes
   - **extend** with `graph_edit` `attach_spec`, `graph_node` `add`, or `graph_edge` `add` when the change is additive
   - **recreate** when the graph shape must change drastically
4. `graph` `get` again
5. summarize the effective diff or migration path

### Available Mutation Tools

| Tool | What it changes |
|---|---|
| `graph_edit` `update` | name, description, workdir |
| `graph_edit` `update_spec` | name, description, position, parallelizable |
| `graph_node` `update` | name, kind, config, position |
| `graph_edge` `update` | condition (`pass`/`fail`/`error`/`always`/`route`) and, since CB11, the target node |
| `graph_edge` `delete` | removes one edge by id |
| `graph_node` `delete` | removes a node **and cascades to every edge naming it** — and, if that node is an
ensemble's entry or exit, to the ensemble row itself (CB52 made the members and join go with it instead of
being orphaned) |
| `graph_node` `copy` | duplicates a node's config into this or another graph, optionally wiring it and shallow-merging `config_overrides` |

**Retargeting an edge is `graph_edge` `delete` + `graph_edge` `add`.** Earlier
revisions of this file said no delete tools existed and that any topology change
forced recreating the graph — that has not been true for a while, and following
it means recreating graphs for nothing.

Both delete actions are **rejected while the graph is running** (pause first), and
`graph_node` `delete` refuses the graph's entry node.

Editing a node's `config` while a graph runs **is** safe: the graph is
snapshotted per spec, so the change takes effect on the next one. Changing the
*topology* of a running graph is not.

`graph_edit` `attach_spec` while a graph runs **is** safe too: bound specs are read
live at every advance, so a spec bound mid-run joins the running dispatch in
position order — after the current spec's position in its place, or right
after the current spec if bound earlier. The run never reports completion
while a bound spec is still pending: it fails naming the spec in
`graph_failed`, and `graph_control` `continue` runs it.

---

## Mutation Heuristics

### Prefer surgical mutation when:

- a single node, spec, or edge needs a config tweak or rename
- the graph topology stays the same
- you want to preserve run history tied to the graph ID

### Prefer extend-in-place when:

- the graph identity should remain stable
- the new behavior can be added without deleting or rewriting existing graph structure
- users already rely on the current graph ID and shape

### Prefer recreate when:

- the graph graph shape changed drastically
- most specs are being replaced
- a clean new draft is easier to reason about

---

## Safety Rules

- do not auto-run after create unless the user explicitly asked for execution
- do not assume one CLI or one model provider
- do not insert commit nodes unless the user explicitly allows graph-managed commits
- preserve strong verification nodes for code graphs
- use `graph_report_blocker` when a node needs human input — do not hard-fail silently
- use `graph_control` `pause` + `graph_control` `continue` for graceful retry/skip flows

## Runtime Lifecycle

| Action | Tool |
|---|---|
| Start execution | `graph_control` `run` |
| Halt after current node | `graph_control` `pause` |
| Retry current node | `graph_control` `continue` with `mode: retry_current_node` |
| Skip to next spec | `graph_control` `continue` with `mode: skip_next_spec` |
| Start a spec at a chosen node (directed run) | `graph_control` `continue` with `mode: run_from_node` (`node_id`, optional `spec_id`); the first spec of a `graph_control` `run` can use `start_node_id` instead. Reuses earlier nodes' recorded output; refused while the graph has an active run |
| Re-open a failed/completed graph | `graph_control` `reset` (optionally `{specs:[…]}`; a named spec's execution count is zeroed, a reset without `specs` keeps it), then `graph_control` `run` |
| Resume once at an exact future time | `graph_control` `schedule_autorun` with `{graph_id, at}` |
| Re-enable an agent once at an exact time | `agent_edit` `schedule` with `(id, at)` |
| Node reports success/failure | `graph_complete_node` |
| Node blocked, needs human | `graph_report_blocker` |

---

## Recovery Matrix (graph status → how to move it)

Learned from real incidents; each row was needed at least once.

| Loop state | How to recover |
|---|---|
| `draft` / `pending` | `graph_control` `run` |
| `paused` | `graph_control` `continue` (`mode: retry_current_node` or `mode: skip_next_spec`) |
| `running` but the daemon restarted (zombie: no child process behind it) | `graph_control` `pause`, then `graph_control` `continue` with `mode: retry_current_node`. Do **not** wait for a scheduled autorun: `is_fireable()` excludes `Running`, so it will never fire. A clean stop or crash that killed a node already leaves the graph `paused` with the spec `interrupted`; `graph_control` `continue` with `mode: retry_current_node` then re-runs that same node. |
| `paused` with a blocker from a no-verdict ensemble | Fix the members with `graph_ensemble` `update` if they are at fault, then `graph_control` `continue` with `mode: retry_current_node`, which re-enters the ensemble without re-running passed nodes. A `graph_control` `run` on a blocked graph is refused. |
| `failed` with blocker `… cannot complete: N bound spec(s) still pending (…)` | The run finished the work it had, but a spec bound mid-run was left pending — nothing was lost. `graph_control` `continue` with `mode: retry_current_node` runs it; no reset needed. |
| `failed` | `graph_control` `reset` (clears the failed state, keeps completed specs), then `graph_control` `run` for a single clean launch. `graph_control` `reset` with no `specs` resets only non-completed specs, so `graph_control` `run` resumes at the first pending one — nothing already done is re-implemented. To redo only what failed instead, `graph_control` `continue` with `mode: retry_current_node` is now accepted on a `failed` graph too: it restarts the failed spec at the node it failed on as a directed run (upstream outputs reused) and clears that spec's execution count; `graph_control` `continue` with `mode: skip_next_spec` skips the failed spec directly. |
| `completed` | `graph_control` `reset` with `{specs:[…]}` to re-open specific specs, then `graph_control` `run`. |
| `failed` with `blocker: null`, last run `pass` | The per-node **iteration budget ran out** (5 — graph-validation rule 7), not a crash. Check the last run's `iteration` before relaunching: the work is usually nearly done and the reviewer already left a precise list, so finishing it by hand and marking the spec `completed` (`spec_edit` `set_status`) costs far less than another five rounds. |
| `failed` in a queue-driven graph, when only the failed member's tail must be redone | `graph_control` `continue` with `mode: run_from_node` (`node_id=…`, `spec_id=…`) — see *Restarting one member* below. Omit `spec_id` and the failed member is the default. |
| `failed` on an idea-driven graph (spec-less, run with an `idea`) | `graph_control` `continue` with `mode: retry_current_node` or `mode: run_from_node` resumes that idea run directly — the graph stores the idea it last ran with, `{{spec_content}}` renders it, and the blank bookkeeping spec's node history (so `{{previous_feedback}}` still carries the failure) is kept. No `spec_id` to name. An idea graph that has never run is refused: start it with `graph_control` `run` passing an `idea`. |
| `failed` with blocker `… failed N time(s) across separate graph executions (limit 3) …` | The per-spec **execution limit** (default 3; genuine verdicts only). `graph_control` `reset` with `{specs:[<spec id>]}` zeroes that spec's count — worktree untouched — then `graph_control` `run`; or give an explicit directive (`graph_control` `run` with `start_node_id`, `graph_control` `continue` with `mode: run_from_node` / `mode: retry_current_node`), which clears it automatically and replies `Execution limit reset for spec '…'`. Automatic re-runs (autorun, cron) never clear it. |
| `paused` with a blocker listing dirty paths between queue specs | The **between-specs dirty-tree guard** held the queue at the next spec instead of failing it. Ways out: `graph_control` `continue` with `mode: run_from_node` on that spec, clean the tree by hand then `graph_control` `continue` with `mode: skip_next_spec`, or `allow_dirty_start: true` via `graph_edit` `update`. |

**Prefer `graph_control` `reset` + `graph_control` `run` over `graph_control` `schedule_autorun` for manual recovery.**
`graph_control` `schedule_autorun` auto-resets and resumes when it fires — convenient, but its
resume-and-launch path can double-launch a graph that already has an in-flight run,
which routes a superseded run down the fail edge and (with a resilience node there)
can spin an implement→resilience→implement loop. Use autorun only for the case it is
built for: a quota death converting a stated reset time into one future resume. For
resuming *now*, `graph_control` `reset` then a single `graph_control` `run` avoids the double-launch.

Two asymmetries worth knowing:

- **`graph_control` `run` freezes the spec list at launch; `graph_control` `continue` re-reads it.** Adding
  a spec and then resuming with `graph_control` `continue` picks it up; adding one mid-run
  does not.
- A commit-check that keys on a marker file (e.g. `.git/canopy-prev-head`) survives
  daemon/PC restarts pointing at a stale HEAD. Delete the marker in pre-flight, and
  only resume at or before the gates node that rewrites it.

---

## Queues: runtime spec lists the engine runs through a graph

The redesign landed. A graph is now a reusable **graph** (the "team"), and the
specs it runs come from a standalone backlog (`spec_edit` `create` / `spec` `list`)
collected into a **queue** the graph executes in order:
`graph_control {action: "run", graph_id, queue_id, workdir?}`. Build the graph once (~13 calls), then
point different queues at it across workdirs — the graph's own bound specs are
typically empty when it runs a queue. (`pool` is the old name for the same
thing; the `queue` tool supersedes `graph_pool_*`, and `queue_id` wins over the
deprecated `pool_id` argument.)

| Action on `queue` | What it does |
|---|---|
| `create` | create an empty queue |
| `add_spec {queue_id, spec_id, group?}` | append a backlog spec; optional `group` shares a warm session (below) |
| `remove_spec` | drop a spec from the queue |
| `reorder {queue_id, spec_ids}` | total reorder — pass **every** member exactly once, in the desired order; refused if it would split a group's pending members |
| `set_group {queue_id, spec_id, group?}` | set or clear (omit `group`) one member's group in place; the member moves next to its group |
| `list {queue_id?}` | one queue's ordered members, or all queues in summary |

**Warm-context groups.** `group` on `queue` `add_spec` makes a spec resume the
session of the previous **successfully-completed** sibling in the same group
instead of analyzing the repo cold — see *Spec Groups* in `SKILL.md`. Group
only an ordered sequence over the same surface; leave unrelated specs ungrouped.
A grouped add lands after the group's last pending member. To (re)group an
existing member, use `queue` `set_group` (or `canopy queue group`), not remove and
re-add. `queue` `reorder` keeps each group's pending members contiguous and
refuses an order that would split one.

**Membership vs. status.** `queue` actions change membership only; a spec's
run status (pending / completed / failed) lives on the spec, so removing and
re-adding a spec does not re-run an already-completed one — `graph_control` `run` still
resumes at the first non-completed member.

**Restarting one member.** `graph_control` `continue` with `mode: run_from_node`
(`node_id=…`, `spec_id=…`) on a queue-driven graph restarts the member you name,
at the node you name. The chosen member becomes the graph's current spec: the members
queued before it are marked `skipped`, the members after it run in their usual
order, and a member left `running` by a stale state goes back to `pending` for
a later run. Omit `spec_id` and the default is the running/interrupted member,
else the failed one, else the next pending one. The node you name always runs
first — including the node an ensemble fans out from: that node runs, and
routing then fans out to the ensemble from there. The reply names the same
spec and the same first node the engine will run ("Directed run: spec '…'
starts at node '…'"), so read it before assuming which spec was picked up.

---

## Language

Write spec descriptions and node prompt templates in **English** — models follow
English instructions more reliably, and the reviewer/implementer contract gets
stricter compliance.
