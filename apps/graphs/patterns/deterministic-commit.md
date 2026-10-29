---
title: Deterministic commit
summary: A check node commits with the spec's own Conventional Commit subject, and a model never writes the commit.
status: in use
implements:
  - graph:canopy-loop
  - graph:canopy-loop-plain
figure: deterministic-commit.figure.json
sources:
  - title: Building effective agents (Anthropic), ground truth from the environment
    url: https://www.anthropic.com/engineering/building-effective-agents
---

# Deterministic commit

## The problem

A commit message written by a model drifts. It invents trailers, rewords the intent, or describes what the model thinks it did. The history then no longer matches the work that was asked for.

Drift compounds. Each commit that paraphrases its spec makes the log a worse record of what was decided, and a later reader cannot tell which wording was the instruction and which was the model's summary of itself.

## The pattern

Let the spec name its own commit. The spec's name is a Conventional Commit subject, `<type>(<scope>): <subject>`, and a deterministic check node runs the commit with that text verbatim. A model never writes it.

A second check proves the commit landed. Both are facts about the repo, so neither needs a judge.

Verbatim matters because the history is then an audit trail, not a retelling. The commit says what was asked, the diff says what was done, and any gap between them is visible instead of smoothed over by a helpful rewrite.

## What we saw

The lab names every spec as the subject its commit will carry, and keeps its graphs' commits verbatim from the spec name. The lab has no recorded origin story for it beyond that convention.

What the convention buys is boring history. No trailers to strip, no paraphrases to decode, no commit whose message describes work that is not in the diff.

## In Canopy

Both loop graphs carry this pattern as a check node with commit rights.
In `canopy-loop-plain` it is the `Commit` node, whose command stages
everything and commits with the spec's own message verbatim. From
`graphs/canopy-loop-plain/graph.json`:

```json
"config": {
  "command": "if [ -z \"$(git status --porcelain)\" ]; then echo 'tree clean: nothing to commit'; exit 0; fi; if [ -z \"$CANOPY_SPEC_COMMIT_MESSAGE\" ]; then echo 'CANOPY_SPEC_COMMIT_MESSAGE is empty'; exit 1; fi; git add -A && git commit -q -m \"$CANOPY_SPEC_COMMIT_MESSAGE\" && echo \"committed $(git log -1 --oneline)\"",
  "commit_rights": true
}
```

When the tree is already clean, the command passes without committing.
Pushing to the work branch is optional: add the push to the command if
the graph should publish the branch.

In `canopy-loop-plain` the documenter leaves its docs uncommitted, so
`Commit` lands the code and the docs together under the one subject.
`canopy-loop` commits twice the same way: `Commit spec` lands the
spec's own message after the completeness review, and `Commit auditor
fixes` lands `fix(<scope>): audit fixes for <name>` after the auditor's
repairs, and both push the branch when they succeed.

A second check can prove the commit landed — that HEAD moved since the
spec started — but neither loop needs one: the gates and the review
have already read the same change before it is committed, and the
history carries the spec's own subject. Add a proof check only where a
concurrent commit from outside the run could be mistaken for this one.

The model-committed version this pattern replaces is a model that
reviews the diff and then commits, with a concise message it writes
itself. Pick the deterministic commit when the message must match the
spec exactly, and the model-committer when the message needs judgment
the spec cannot carry.

## Try it

```sh
canopy graph install canopy-loop
canopy graph install canopy-loop-plain
```
