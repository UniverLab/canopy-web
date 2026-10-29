---
title: Auditor fixes
summary: The auditor repairs what it finds, instead of writing change requests for another model to read.
status: in use
implements:
  - node:auditor
figure: reviewer-fixes.figure.json
sources:
  - title: Building effective agents (Anthropic), evaluator-optimizer workflow
    url: https://www.anthropic.com/engineering/building-effective-agents
---

# Auditor fixes

## The problem

A rejection is a message from one model to another. The implementer must read it, understand it and redo the work, and on a cheap model each round trip can lose detail or introduce a new fault. When the defect is small, the round trip costs more than the fix.

## The pattern

Let the auditor repair what it finds. Instead of a list of change requests, it edits the diff, and a later step commits. The loop back to the implementer is kept for the cases the auditor cannot repair.

This differs from the plain evaluator-optimizer loop Anthropic describes, in which "one LLM call generates a response while another provides evaluation and feedback in a loop." Here the evaluator can also write.

Repair wins when the defect is small and clear: a missed edge case, a wrong boundary, a test that asserts too little. The auditor already holds the full context, so the fix is one edit, not a handoff.

Bounce the work back when the defect is large or the implementer misread the spec. An auditor that rewrites half the diff is no longer auditing; it is implementing without the implementer's instructions, and its output deserves its own review.

## What we saw

The lab has no recorded origin story for this pattern, and no measurement of how often repairs beat a rejection. Treat the claim above as a design intent, not a result.

The practical rule is trust calibration. Give the repair licence to an auditor model strong enough to edit carefully, and keep the bounce loop behind it for everything else.

## In Canopy

The catalogue's `auditor` node reviews strictly against the spec with a licence to edit. Its prompt repairs what it objects to directly in the working tree, rewrites tests that would not fail without the feature, and runs the gate script once at the end. It never commits: a later node commits its fixes.

The gate script path is the one thing the prompt does not carry. Fill
in `<GATE-SCRIPT>` at install time with the project's deterministic
gates. From the prompt in `nodes/auditor/node.json`:

```
It is exactly what the gate node after you runs (formatting, the
linter at -D warnings, the dependency audit, the coverage floor, the
full suite); it may wait for the CPU lock first. Fix until it prints
GATES PASSED. If you changed nothing, do not run it.
```

The single run at the end is deliberate. The auditor proves its own
repairs without turning into a second implementer that iterates.

This differs from the catalogue's `reviewer` node, which fails a
bad diff back to the implementer with a list of what is wrong instead
of fixing it. `canopy-loop` splits the two jobs: its reviewer
only reports what is missing, its auditor repairs what it
finds, and a check node commits those repairs. Pick the arrangement
that matches how much you trust the model that repairs.

## Try it

```sh
canopy node install auditor
```
