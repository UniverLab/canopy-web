---
title: Parallel proposers
summary: Several cheap models draft the same spec in parallel, then one implementer builds on the best ideas.
status: in use
implements: []
figure: parallel-proposers.figure.json
sources:
  - title: Mixture-of-Agents Enhances Large Language Model Capabilities (Wang et al.)
    url: https://arxiv.org/abs/2406.04692
  - title: Fusion Router (OpenRouter documentation)
    url: https://openrouter.ai/docs/guides/routing/routers/fusion-router
  - title: Building effective agents (Anthropic), parallelization
    url: https://www.anthropic.com/engineering/building-effective-agents
---

# Parallel proposers

## The problem

One cheap model, one attempt, one set of blind spots. Spending a strong model on every spec is not affordable under tight quota, and a blank spec is the hardest thing to hand to a weak implementer.

## The pattern

Ask several models for a draft of the same spec at the same time. Then give one implementer the drafts and let it build on the best ideas. The implementer never faces the blank spec.

The canonical use spends the expensive model once, on a pre-digested problem. Three cheap drafts go in, the quorum consolidates them into one document, and the paid implementer writes the code. That is one expensive run instead of one expensive exploration plus one expensive implementation.

The idea has published precedent. The Mixture-of-Agents paper by Wang et al. arranges several LLMs in layers, where each agent uses the previous layer's outputs as additional context. Anthropic lists parallelization as a workflow: "running the same task multiple times to get diverse outputs."

Use it for problems where the approach is the hard part and the typing is not.

## The mirror image

The same unit works in reverse: two or three cheap reviewers read the same diff, and the quorum consolidates their findings into one verdict. Drafting and reviewing are both pre-digestion; only the direction differs.

## What we saw

The lab took the idea from OpenRouter's fusion mode. OpenRouter documents it as a panel of models answering the same prompt in parallel, with an analyst model comparing the answers. It states that the analyst "doesn't merge them." The lab's version is simpler: the drafts go straight to an implementer.

With a similar technique, the operator got reasoning from cheaper models comparable to Fable 5. This is an observation from the lab's own use. It is not a benchmark, and the lab has no controlled comparison.

Parallel drafts cost more calls. OpenRouter estimates a three-model panel at roughly four to five times a single completion, and the lab does not claim the trade is free.

## In Canopy

An ensemble is one unit, not several hand-wired nodes. A parallel ensemble takes two to eight members, and the sequential kinds take more, because they dispatch one member at a time. Both caps can be raised in settings.

Create it with a single call that makes the members, the quorum, and the entry and exit edges together. Wiring several parallel `pass` edges out of one node by hand is the ambiguous-outgoing-edges mistake, and it aborts the run.

A parallel ensemble node holds the proposers. All members share one prompt template, and each member is an empty object so that nobody's platform or model is baked in. The catalogue ships no proposers node: build the ensemble in the graph you own, give it the draft prompt, set `min_pass` to the member count so every draft must pass, and bind a different model to each member at install time. The figure on this page carries the same shape, with the wiring left out:

```json
{
  "name": "drafters",
  "kind": "parallel",
  "min_pass": 3,
  "members": [
    {},
    {},
    {}
  ],
  "timeout_minutes": 30
}
```

Three drafters run at once and their outputs go straight to one implementer, which is the point: the drafts are pre-digestion, and the paid model only writes.
