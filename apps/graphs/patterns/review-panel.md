---
title: Review panel
summary: An experiment, each reviewer owns one axis, security, performance, maintainability, or project patterns, and every axis must pass.
status: experiment
implements: []
figure: review-panel.figure.json
sources:
  - title: Mixture-of-Agents Enhances Large Language Model Capabilities (Wang et al.)
    url: https://arxiv.org/abs/2406.04692
---

# Review panel

This pattern is an experiment. The lab has designed it but not run it.

## The problem

One reviewer reads for everything and covers nothing well. Security, performance, maintainability, and the project's own patterns each deserve a full read, and a single pass over a large diff gives each a skim. The result is a review that approves correct-looking code with a whole dimension unexamined.

## The pattern

Run an ensemble where each member reviews a different axis: one reads for security, one for performance, one for maintainability, one for the project's own patterns. Per-member prompt overrides make this one call instead of four sequential nodes, and all four axes run in parallel.

**`min_pass` means the wrong thing here.** With homogeneous members, two of three reads as "a majority agrees" and that is sensible. With specialists, each member owns a different axis, so three of four reads as "one whole dimension of quality may fail and we ship anyway." Every axis must pass.

But all-must-pass with four cheap models means the grumpiest one blocks every change forever. The honest requirement is not a vote count at all. It is severity: block on a real finding, record a nitpick. The quorum counts votes and cannot express that.

The workable version today sets the threshold to all members and pushes the severity discipline into each member's prompt: fail only on a defect in your axis that would matter in production; everything else goes in the report, not the verdict. That raises the floor without pretending the engine understands severity.

## What we saw

Nothing yet. The panel is designed, with the severity problem above as its known open question. Until the engine can tell a blocking finding from a note, the prompt discipline carries that weight alone.

## In Canopy

The figure shows the panel as one parallel ensemble between the gate and the commit: implement, then the gate, then the four specialists, then the commit. A fail from the quorum routes back to implement.

No catalogue document implements this pattern yet.

## Try it

Today the same coverage can be built from four plain agent nodes chained in series. Slower than parallel, identical in coverage:

```text
gates --pass--> review-security --pass--> review-performance
review-performance --pass--> review-maintainability --pass--> review-patterns
review-patterns --pass--> commit
any review --fail--> implement
```

Any specialist failing bounces the work, which is the semantics wanted and which a vote count cannot express.

One template serves all four, with one axis substituted. The last rules are what keep a cheap model from turning into a style bot:

```text
# [ROLE]
You review one diff on ONE axis: SECURITY. Other reviewers own the other
axes. Do not review theirs.

# [WHAT]
Injection, authz, secrets in code or logs, unsafe deserialization, TOCTOU,
anything that widens what an attacker can reach.

# [HOW]
- Cite file:line for every finding.
- FAIL only for a defect on your axis that would matter in production.
- Everything else — style, taste, a nicer way to write it — goes in your
  report, never in your verdict.
- Finding nothing is a legitimate and expected outcome. Do not manufacture
  a finding to look useful.

# [SPEC]
{{spec_content}}
```

That last rule is not politeness. A model that believes an empty report reflects badly on it will produce findings, and a panel of four such models will bounce every change forever.

The same panel collapses into one parallel ensemble with per-member prompt overrides, one per axis, and the threshold set to the member count. Wall-clock drops to the slowest reviewer instead of the sum. If you publish the result, the repo README explains how.
