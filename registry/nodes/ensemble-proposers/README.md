# ensemble-proposers

What this node is for: drafting solutions cheaply before spending
implementer quota. Three parallel members draft a concrete solution
for the same spec; a downstream implementer then builds from the
pre-digested drafts without ever seeing the blank spec.

Config: the shared `prompt_template` plus three unbound members. No
`platform`, `model`, or `cli` bindings anywhere — `min_pass` is
omitted, so every member must pass.

What the installer must fill in: the harness per member
(platform/model) at install time; nothing else.

Install:

```sh
canopy node install ensemble-proposers
```
