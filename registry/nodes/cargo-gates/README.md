# cargo-gates

What this node is for: the deterministic gate step of a Rust spec
loop. One check command runs the formatter, the linter, and the test
suite.

Config: the `command` only. No `platform`, `model`, or `cli`
bindings.

What the installer must fill in: nothing — unless the project is not
Rust, in which case replace the command with the project's own gates.

Install:

```sh
canopy node install cargo-gates
```
