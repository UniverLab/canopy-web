# Canopy Graph Design Skill

**Loop orchestration skill** for turning multi-step work into reusable Canopy graphs with real MCP tooling constraints.

---

## Overview

This skill helps an agent turn a user goal into a structured Canopy graph made of:

- ordered specs
- `agent` nodes
- `check` nodes
- `gate` nodes
- routing edges between nodes

It is designed for **generic graphs**, not a single hardcoded coding pipeline, and it keeps the plan grounded in the graph tools that actually exist.

---

## What It Does

The skill guides an agent to:

1. understand the user goal and constraints
2. split the work into atomic specs
3. choose an appropriate graph pattern per spec
4. persist the graph through Canopy MCP tools
5. summarize the result before execution

It also supports refining existing graphs by inspecting first, then either extending the graph safely or recreating it when the current toolset cannot mutate the shape directly.

---

## When This Skill Triggers

Use it when the user asks to:

- plan or create a graph
- orchestrate several agents in background
- define checkpoints and approvals
- build developer/reviewer/verifier/committer flows
- convert a manual process into a Canopy graph
- update or refine a stored graph
- add retries, approvals, or pass/fail routing around agent work

---

## Skill Structure

```
canopy-graph-design/
├── SKILL.md              # Main skill definition
├── README.md             # This file
├── LICENSE               # MIT License
└── references/
    ├── graph-patterns.md
    ├── graph-validation.md
    └── mcp-tool-playbook.md
```

---

## MCP Tooling Covered

Creation flow:

- `graph_edit` `create`
- `graph_edit` `attach_spec`
- `graph_node` `add`
- `graph_edge` `add`
- `graph` `get`

Refinement flow:

- `graph` `list`
- `graph` `get`
- extend with `graph_edit` `attach_spec`, `graph_node` `add`, or `graph_edge` `add` when the change is append-only
- recreate as a new graph when the shape must change in ways the toolset cannot mutate directly

Execution flow:

- `graph_control` `run`
- `graph_control` `pause`
- `graph_control` `continue`
- `graph_control` `schedule_autorun` — resume a graph once, at an exact time (no polling)
- `agent_edit` `schedule` — re-enable a background agent once, at an exact time

---

## Usage

Reference it from agent configuration:

```yaml
skills:
  - name: canopy-graph-design
    path: skills/canopy-graph-design/SKILL.md
    triggers:
      - "create graph"
      - "plan graph"
      - "background pipeline"
      - "orchestrate agents"
      - "checkpoint flow"
```

---

## References

- **graph-patterns.md** — examples of reusable graph shapes + field notes from real failures
- **graph-validation.md** — the pre-run checklist (nine fatal shapes)
- **mcp-tool-playbook.md** — recommended create/extend/replace flow with the current MCP toolset

---

## License

MIT © Jheison Martinez

---

## Version

3.1 (2026-10-01) — catch-up with the graphs actually running.

- **Spec contract is the tagged `<spec>`** (seven sections, three required)
  instead of ROLE / WHAT / HOW; a spec decides, its reasoning goes to the
  knowledge layer; requirements end with the evidence the report must paste.
- **Ensembles** (parallel / round_robin / cascade), commit rights, mixed
  platforms and preflight before launch.
- **Hooks** (command, interactive by session name, graph chaining, agent).
- **Core rule 7: checks are hermetic, versioned in the repo and cheap**;
  mutation testing runs in CI.
- **Two reviewers, two questions** (presence vs behaviour).
- **Pattern 10: crew graph with a chained quality pass** (graph-patterns.md).
- Fixed: iteration budget is 5 per node/ensemble per spec (SKILL.md said 10).

2.2 (2026-08-27) — corrections from running two real queues, not from reading

- **The iteration budget is 5, not 10** (`DEFAULT_MAX_ITERATIONS_PER_NODE`,
  `graph_engine.rs:20`). The old number made retries look half as expensive as
  they are. When it runs out the graph ends `failed` with `blocker: null` and a
  last run of `pass` — no message says the ceiling was hit.
- **`graph_export` / `graph_import`** build a whole graph in **one call**, with
  all-or-nothing validation. Now the default path; hand-building is the
  fallback. A 9-node graph by hand is ~28 calls.
- **`graph_delete_node` / `graph_delete_edge` exist.** The old claim that any
  topology change forced recreating the graph was wrong.
- **What a node can see** (SKILL.md) — `{{previous_feedback}}` carries exactly
  one hop. This is why the triage relay must copy the reviewer's list verbatim,
  and why a long chain needs durable artifacts in the repo.
- **Pattern 9, Triage Relay** (graph-patterns.md) — routing a reviewer failure
  apart from an infrastructure failure.
- **`{{spec_start_head}}` replaces the `.git/canopy-prev-head` marker**, which
  no longer exists in canopy and could read as a false positive after a restart.
- **A spec decides, it never asks** (SKILL.md) — measured: 1 implementer round
  vs 4, same graph, same models.
- **`graph_preflight`** added to the flow, with its concurrent-probe false
  negative.
- Graph-validation rule 10: every node needs an exit for the statuses it can
  report — a whole-graph property no single `add_edge` call can catch.

2.0 (2026-07-14)

- **Design Expensive, Execute Cheap** (SKILL.md) — author specs and graphs with
  the most powerful model available; implement with mid-tier models; review
  with cheap narrow prompts. Spec quality is the biggest lever on graph
  economics.
- **The Spec Contract: ROLE / WHAT / HOW** (SKILL.md) — every spec must be
  executable by a colder, cheaper context than its author; embed values and
  commands instead of pointing at them.
- **Slimmer SKILL.md** — the nine fatal graph shapes moved to
  `references/graph-validation.md` (progressive disclosure); construction
  playbook condensed.

1.8 (2026-07-10)

- **Recovery Matrix** (mcp-tool-playbook.md) — how to move a graph out of every
  status, including `failed` (no direct tool yet; the `graph_schedule_autorun`
  bypass) and the post-restart `running` zombie (`graph_pause` → `graph_continue`;
  autorun cannot fire on `Running`).
- **Core Rule 6 + Graph Validation** (SKILL.md) — design for the process dying
  mid-run; the nine fatal graph shapes, each learned from a real broken run.
- **Pools are storage-only** (mcp-tool-playbook.md) — and the R1–R7 redesign
  replacing them: graph-level graph (the reusable team), standalone spec backlog,
  run-time pools, live pool mutation, node blueprints.
- **English prompts** — spec descriptions and node templates now default to
  English.

1.7 (2026-07-09) — restored after a stale skills-sync clobbered it; never committed

- **Graph Validation** (SKILL.md) — the fatal shapes: entry node, ambiguous edges,
  `config` typing, `check` timeout default, gate matching on serialized JSON.
- **Patterns 7 & 8** (graph-patterns.md) — *Gated Implement* and the
  *Resilience Branch* that triages a failed implement and schedules its own resume.
- **Resume semantics** (mcp-tool-playbook.md) — why `graph_run` refuses failed graphs
  but a scheduled trigger does not.

1.2 (2026-05-13)
