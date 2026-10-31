---
title: Resilient members
summary: Cascade and round-robin ensembles give one node a fallback ladder or a rotation across providers, so a quota death is not a failed run.
status: in use
implements:
  - graph:canopy-builder
figure: resilient-members.figure.json
sources:
  - title: How we built our multi-agent research system (Anthropic), resilience
    url: https://www.anthropic.com/engineering/multi-agent-research-system
---

# Resilient members

## The problem

Cheap models run out of quota, and harnesses fail mid-run. A node bound to a single provider turns either event into a failed run, even though the work itself was fine.

Worse, the plain gated shape fails the spec the moment implement dies, so nobody reads the failure. If the CLI died on a quota that resets at a known hour, that knowledge is thrown away.

## The pattern

Give a node several members instead of one.

- **Cascade:** the members form a ladder. If the first fails on quota or harness, the run falls through to the next.
- **Round robin:** the members take turns, so spend rotates across providers and no single quota is drained first.

Anthropic describes the same concern in its multi-agent write-up: restarts are costly, so the team "built systems that can resume from where the agent was when the errors occurred." Letting a node fall to another member is a cheaper cousin of that idea.

## Resilience branch

Give implement two exits. On pass it goes to the gate as usual; on fail it goes to a resilience node, so the failure is read instead of thrown away.

The resilience node is a cheap model on a different quota from the implementer, or it is dead exactly when needed. It either repairs a transient failure and reports pass, so implement retries, or recognizes exhaustion, schedules the graph's own wake-up at the reset time, and reports fail. The spec fails, but the graph wakes itself at that instant.

Give it the clock. Models do not know what time it is: a real run at night scheduled its wake-up for 6am the next day, a 23-hour stall. The prompt must require reading the current time first.

## Free-tier cascade

Several CLIs with generous free tiers and small ceilings: spend them in sequence before touching anything paid. One ensemble node of kind cascade does it in a single call, members ordered cheapest to dearest.

Members run one at a time. A failure falls through to the next cold; the first pass exits. A bounce resumes the member that last passed. A member with no infra retries falls through at once on a crash. The lab's committer is an ensemble too: several members, one commit.

### Routing on why a member failed

The cascade falls through on any failure: exhaustion, a network error, and wrong code all look the same. That is correct when members are equally capable and the goal is only to spend ceilings in order. It is wrong when wrong code should go to a fixer, not a weaker harness.

For that case a router variant reads the failure and routes on the reason. A router is only justified when the reason changes where the work goes; for spending tiers in sequence, the plain cascade is enough.

### The naive version and why it is a trap

A chain of fail edges from one implementer to the next looks like a cascade but is a trap. Fail conflates "my quota is gone" with "this code is wrong". A spec with a genuine bug burns every free tier on the same wrong task, ending the day with every ceiling spent and nothing done.

A chain only makes sense routing on why the node failed: one router for the whole cascade, each fail edge pointing at it. It sends exhaustion down the ladder, transients back for retry, and broken code out as a failed spec. Untested; build it only when the cascade must route on reason.

### Two things worth knowing before you build

**Exhaustion looks different on every harness.** Some CLIs exit non-zero naming the reset time; others stop responding and die on the node's timeout. A member that times out falls through to the next, which is usually wanted. A router generalizes across both.

**The engine has no memory of a spent harness.** If one spec burns the first tiers, the next spec starts at the top and rediscovers they are dead, for every remaining spec. Today the only lever parks the whole graph until a reset. A per-harness "unavailable until" does not exist yet.

## What we saw

Cascade and round robin reuse the ensemble idea from the parallel proposers: an ensemble already holds several members for one node, so the same structure holds fallbacks instead of parallel drafts. The lab has no measurements on how many runs this saved.

## In Canopy

`canopy-builder` ships this pattern: each of its five working roles is a round-robin ensemble — Designer, Implementer, Reviewer, Auditor and Documenter — and every member is an empty object, so no harness is baked in. From `graphs/canopy-builder/graph.json`:

```json
{
  "name": "Implementer",
  "kind": "round_robin",
  "commit_rights": false,
  "entry_from_node": "Plan check",
  "entry_condition": "pass",
  "extra_entry_sources": [
    {
      "from_node": "Full gates",
      "condition": "fail"
    }
  ],
  "on_pass_to": "Full gates",
  "on_fail_to": "Plan check",
  "min_pass": 4,
  "members": [
    {},
    {},
    {},
    {}
  ],
  "timeout_minutes": 120
}
```

The members take turns: spend rotates across providers, and a quota death rotates to the next member instead of failing the spec. Bind a different harness to each member at install time. The schema also allows `cascade`, where the members form a ladder and the first pass exits.

For the failure side of the same problem, `canopy-builder` carries a `Resilience` node: it reacts after a node fails, where members prevent the failure from ending the run.

## Try it

```sh
canopy graph install canopy-builder
```

To spend free tiers first: one cascade ensemble, cheapest to dearest, one pass enough to exit, short per-member timeouts, no infra retries. The honest limit is the missing memory above: each new spec rediscovers the spent tiers.
