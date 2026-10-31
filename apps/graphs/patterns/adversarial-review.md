---
title: Adversarial review
summary: Review the work with models of different families, one told to break it, and back the verdict with deterministic checks.
status: standard
implements:
  - graph:adversarial-developer
  - node:reviewer
figure: adversarial-review.figure.json
sources:
  - title: Building effective agents (Anthropic), evaluator-optimizer workflow
    url: https://www.anthropic.com/engineering/building-effective-agents
---

# Adversarial review

## The problem

A model that wrote a change is a poor judge of it, and a model of the same family as the author tends to share its blind spots. A friendly review passes work that a hostile one would reject. On cheap models, where a single pass is unreliable, that gap costs real runs.

## The pattern

Put at least two reviewers behind the implementer. One reads constructively. The other is told to assume the diff is wrong until every line earns its trust. Both must pass.

Run the reviewers on models from different families, so they do not fail in the same way. Then put deterministic checks (formatter, linter, tests) in front of them, so no reviewer is asked to judge what a command can decide.

Anthropic describes the shape in its evaluator-optimizer workflow: "one LLM call generates a response while another provides evaluation and feedback in a loop." The lab's version adds a second, adversarial evaluator and mixes model families.

## The pair

A reviewer asks "is this right?". An adversary asks "how do I break this?". Those are different jobs and they produce different findings.

The figure shows the serial pair: implement, then the gate, then the adversary, then the review that commits. Note the inverted edges. The adversary reports fail when it succeeds at breaking the change, and that routes back to implement. It reports pass when it could not break it, and that routes on to the review.

The adversary's prompt must demand a concrete reproduction: an input, a sequence, a race. Not an opinion, not a "this could be risky". An adversary that cannot produce one has not found anything, and saying so must be a legitimate, unpunished outcome, or it will invent findings to look useful.

The pair fits work that arrives from outside. An issue filed by a stranger is exactly the case where something should try to falsify the fix before it lands.

## What we saw

Early in Canopy, a bug defeated Opus 4.6. The operator spent many tokens on it without a fix. MiMo 2.5 solved it on the first try. The operator no longer remembers which bug it was.

This is one anecdote, and it proves nothing about which model is better. The lesson the lab took from it is that the models are different: MiMo's training may have covered a problem that Opus's did not. A reviewer from another family may see what the author's family cannot.

Since then, the lab's standard is adversarial review by models of different families, plus deterministic checks.

## In Canopy

A parallel ensemble holds the reviewers. Its `min_pass` is 2, so both members must pass. Member 1 uses the shared constructive prompt. Member 2 overrides it with the adversarial one. No member names a platform or model, so whoever installs the graph binds a different family to each.

The shape you add, with the prompt fields left out:

```json
{
  "name": "reviewers",
  "kind": "parallel",
  "commit_rights": false,
  "entry_from_node": "gate",
  "entry_condition": "pass",
  "on_pass_to": "commit",
  "on_fail_to": "implement",
  "min_pass": 2,
  "timeout_minutes": 30
}
```

The reviewers have no commit rights. A single committer lands the work only after both pass, and a failure routes back to the implementer.

The `adversarial-developer` graph is the baseline implementation of this pair: the reviewer fails bad diffs back, the auditor repairs what it finds, and deterministic gates judge what a command can decide. The standalone breaker agent — report FAIL with a concrete reproduction, or PASS — stays opt-in for work that arrives from outside, and is added to that loop as one more ensemble when it is wanted; the baseline ships no dedicated breaker.

## Try it

```sh
canopy graph install canopy-builder
```

Bind a different model family to each reviewer member of the pair you add.
