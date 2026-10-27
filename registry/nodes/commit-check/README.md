# commit-check

What this node is for: the proof step after a committer. It verifies a
commit landed since the spec started by comparing HEAD against the
spec-start marker.

Config: the `command` only. No `platform`, `model`, or `cli`
bindings.

What the installer must fill in: nothing for the basic form. For the
stronger "this run's own committer landed a commit" check — immune to
a concurrent commit from outside the run — switch the command to the
committed-head form:

```sh
test -n "{{spec_committed_head}}" && test "$(git rev-parse HEAD)" = "{{spec_committed_head}}"
```

That form requires a node with commit rights earlier in the graph.

Install:

```sh
canopy node install commit-check
```
