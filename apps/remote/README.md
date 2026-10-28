# Canopy remote

Reach your Canopy sessions from a browser at remote.univerlab.org: pair
once with the code `canopy` shows, pick a host, and drive its sessions —
or watch its graphs — over an encrypted peer-to-peer link. `web/` is the
browser app, `worker/` the blind signaling relay that introduces the two
ends (see its own README).

## Watching graphs

The home screen switches between **Sessions** and **Graphs**. Graphs lists
every graph running on the machine — name, status, `done/total` with a
progress bar, the current spec and the workdir — refreshed when shown and
every 10 seconds while visible.

Tapping a row opens the graph: the same plate the catalogue draws, with
the running node lit, the passed and failed nodes badged, and the queue
below it as a checklist that ticks as specs finish. The plate stands
vertical on a phone, horizontal past 720 px. Leaving the view (back,
another tab, a hidden page) stops the live updates; returning resumes
them. If the link drops, the view keeps its last state and says when it
arrived, then resumes on reconnect.

Watching is read-only: the remote never pauses, continues or resets a
graph. Against the fake host (`/fake.html` in development) two fixture
graphs — one running with an ensemble, one completed — exercise the whole
view, the running one advancing every 2 seconds.
