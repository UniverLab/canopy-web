---
title: Deterministic gates
summary: Shell checks decide pass or fail, never an LLM judge, and a failure carries its reason into the next prompt.
status: standard
implements:
  - graph:canopy-builder
  - graph:adversarial-developer
  - node:full-gates-cargo
  - node:full-gates-web
figure: deterministic-gates.figure.json
sources:
  - title: Building effective agents (Anthropic), ground truth from the environment
    url: https://www.anthropic.com/engineering/building-effective-agents
  - title: How we built our multi-agent research system (Anthropic), deterministic safeguards
    url: https://www.anthropic.com/engineering/multi-agent-research-system
---

# Deterministic gates

## The problem

An LLM asked "does this pass?" can be wrong, flattered, or tired. On a cheap model it is also another paid call. Whether the formatter is clean and the tests are green is a fact about the repo, not an opinion.

## The pattern

Let a shell command decide. The gate runs the formatter, the linter and the tests, and its exit code is the verdict. No model sits in the judging seat.

A gate that only says "fail" teaches the next attempt nothing. So the failure's output goes into the next prompt, and the implementer sees why it was sent back.

Anthropic's agent guidance makes the same point about grounding: agents should "gain 'ground truth' from the environment at each step." Its multi-agent write-up also pairs model judgment with deterministic safeguards such as retries and checkpoints.

Three rules make this shape work, and each was learned by watching it not work.

**The implement edge is `pass`, never `always`.** An `always` edge routes a failed implement into the reviewer, which then approves work that was never written. A real run marked a spec completed with no commit behind it that way.

**The check sits before the reviewer.** Code that does not build never reaches review. Without that order, the reviewer writes up the breakage and the spec is marked completed anyway, because routing keys on the run's status, not on its prose.

**Auto-fixing commands must not bounce work.** Run the formatter in rewrite mode, which fixes, not in check mode, which fails. Only genuine breakage should route back to implement.

Use it for essentially everything. Start here and add shape only when a specific failure justifies it.

## What we saw

The lab runs cheap, unreliable models with tight quota. Its standard loop puts the gates before any reviewer, so a reviewer's quota is never spent on code that does not compile.

The lab has not measured how much this saves. It is a design choice, not a benchmark.

## Handing plans down

A plan from one node to the next travels through spec notes, not files. A designer node writes its plan with `spec_note_write` instead of a temp file no later node can find, and a verify step checks the notes file for the plan's heading. Every agent prompt already carries the notes, so nothing needs deleting and nothing goes stale.

## In Canopy

A `check` node holds the command. Edges route `pass` forward and `fail` back to the implementer. In `adversarial-developer`, the gate that follows the implementer and its two edges look like this:

```json
{
  "from_node": "Full gates",
  "to_node": "Reviewer",
  "condition": "pass"
},
{
  "from_node": "Full gates",
  "to_node": "Implementer",
  "condition": "fail"
}
```

The implementer's prompt reads `{{previous_feedback}}` and must address every point in it, which is how a failure's reason reaches the next attempt.

The `full-gates-cargo` node is the Rust version of the gate, from `nodes/full-gates-cargo/node.json`:

```json
{
  "format_version": 1,
  "name": "full-gates-cargo",
  "kind": "check",
  "description": "The Rust full gate: one check command runs `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings` and `cargo test --all-features`. The project should add its dependency audit and coverage floor to the command.",
  "config": {
    "command": "cargo fmt --all -- --check && cargo clippy --all-targets --all-features -- -D warnings && cargo test --all-features",
    "mutex": ["cpu"],
    "timeout_seconds": 6000
  }
}
```

A TypeScript or web project installs `full-gates-web` instead: the same shape, with a command that runs the install, the lint, the typecheck, the unit tests, the build and the end-to-end tests.

In the catalogue the gate command is the `<GATE-SCRIPT>` placeholder. Replace it with the command that runs your own formatter, linter, dependency audit, coverage floor and test suite. Until you do, the placeholder fails, so a graph cannot pass its gates by doing nothing.

## Keep hardening the gate

An earlier catalogue carried a second graph whose whole job was to cover a finished change with tests. The lab dropped that shape. A separate test-review graph inspects one change at a time, while the gate every change must pass stays exactly as weak as it was, and work that nobody pointed the second graph at goes on shipping untested.

Harden the one gate instead, so every spec meets the same bar. Put the test budget inside it: a cap on added-plus-removed lines, so a "fix" that rewrites the suite is refused. Keep the strict lint thresholds there, the dependency audit, and the coverage floor. Then a suite that ballooned, a suppressed lint and a stale dependency all fail the same command as a broken build, on every spec, without anyone deciding to run a review that day.

## Try it

```sh
canopy graph install canopy-builder
canopy node install full-gates-cargo
canopy node install full-gates-web
```
