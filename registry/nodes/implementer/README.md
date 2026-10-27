# implementer

What this node is for: the implementer step of a spec loop. It
verifies the spec premise against the actual code, implements exactly
the spec, and reports — it never commits.

Config: `prompt_preset: implementer`, with the preset bundled in
`node.json`. No `platform`, `model`, or `cli` bindings.

What the installer must fill in: the harness that runs this node
(platform/model) at install time; nothing else.

Install:

```sh
canopy node install implementer
```
