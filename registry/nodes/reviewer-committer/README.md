# reviewer-committer

What this node is for: the review-and-commit step of a spec loop. It
reviews the diff strictly against the spec and, when the spec is fully
satisfied, lands exactly one commit. Give it commit rights in the
installing graph so the engine attributes the commit to it.

Config: `prompt_preset: reviewer`, with the preset bundled in
`node.json`. No `platform`, `model`, or `cli` bindings.

What the installer must fill in: the harness that runs this node
(platform/model), plus commit rights, at install time; nothing else.

Install:

```sh
canopy node install reviewer-committer
```
