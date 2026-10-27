# resilience

What this node is for: the on-call medic after a failure or blocker.
It diagnoses exactly one cause — quota, transient glitch, or genuine
defect — and routes to the right next step. It never fixes the work
itself.

Config: `prompt_preset: resilience`, with the preset bundled in
`node.json`. No `platform`, `model`, or `cli` bindings.

What the installer must fill in: the harness that runs this node
(platform/model) at install time; nothing else.

Install:

```sh
canopy node install resilience
```
