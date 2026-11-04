---
title: Event intake
summary: A graph that fires on a watched file, turning outside events into specs while nobody is watching.
status: in use
implements: []
figure: event-intake.figure.json
sources:
  - title: GitHub webhooks documentation
    url: https://docs.github.com/en/webhooks
---

# Event intake

## The problem

Work arrives while nobody is watching. Issues are filed at night, feeds update on their own schedule, and a graph that only starts by hand waits for a human to notice. The issue sits until morning, and morning has its own work.

## The pattern

A graph does not have to be started by hand. It can fire on a cron slot or a filesystem watch, which makes it the back half of an event pipeline whose front half is anything that can write a file.

The front half does not need a public endpoint. A real webhook needs a tunnel, a forwarding service, something listening. For work that can wait five minutes, one cron line polling for new items and writing a file is strictly simpler and stays local. Use a real webhook only when the latency actually matters.

The intake node is a normal agent node whose job is to turn the file into a spec and queue it. Once it does, the rest of the graph is the gated loop and knows nothing about where the work came from.

**The gap**: a watch-triggered graph is told that it fired, never what fired it. The watcher logs the changed path and then calls the engine with only the graph id. If the script writes to one well-known path, the intake node just reads that path and the gap costs nothing, which is why this is a solved pattern today. It bites the moment a directory is watched and the intake needs to know which file arrived.

## What we saw

The lab runs intake against a single well-known path: a poll script writes one file, the graph fires on it, the intake node reads it. Within that shape the missing payload has never cost a run. Directory watch stays out of reach until the engine passes the path along.

## In Canopy

The figure shows the full pipeline: the outside event, the script that writes the inbox file, the watch, the intake node, and then the gated loop of implement, gate, and review.

No catalogue document implements this pattern yet. The back half is a trigger watching that file plus the intake prompt below; the front half is one script in front of them.

## Try it

An issue labeled for automation gets a branch and a proposed fix by morning. The front half is one cron line running a script like this every ten minutes:

```bash
#!/usr/bin/env bash
# ~/bin/canopy-issue-inbox.sh — run from cron every 10 minutes
set -euo pipefail
INBOX="$HOME/.canopy/inbox/github-issue.json"
mkdir -p "$(dirname "$INBOX")"

gh issue list --repo you/yourrepo --label auto --state open \
  --limit 1 --json number,title,body > "$INBOX.tmp"

# Only publish when there is actually an issue, and write atomically so the
# watcher never reads a half-written file.
if [ "$(jq 'length' < "$INBOX.tmp")" -gt 0 ]; then
  mv "$INBOX.tmp" "$INBOX"
else
  rm -f "$INBOX.tmp"
fi
```

The atomic move matters. A watcher fires on the first write event, and a graph that starts reading a file another process is still writing will read half an issue.

The back half is a graph watching that file. The intake node turns the file into work and stops:

```text
# [ROLE]
Turn one GitHub issue into one spec. You do not fix anything.

# [HOW]
1. Read the inbox file.
2. Reproduce the problem well enough to state it precisely. An issue is a
   report, not a specification.
3. Write the spec: objective, functional requirements, in scope, out of
   scope, acceptance. Where the issue is ambiguous, choose the narrowest
   reading and say so in OUT OF SCOPE.
4. Queue it for the graph.
5. Report pass with the spec id.
```

From there it is the gated loop, plus an adversary before the commit:

```text
# [ROLE]
Your job is to BREAK the change in the diff below. You succeed by finding a
concrete way it fails.

# [HOW]
- Produce a reproduction: an input, a sequence, a race, a boundary. Not an
  opinion, not a "this could be risky".
- Report FAIL if you broke it — include the reproduction.
- Report PASS if you could not. That is a real result and an expected one.
- Do not fix anything. Breaking and repairing are different jobs.
```

The adversary's fail means it succeeded. Wire its fail edge back to implement and its pass edge on to the commit.

Three things to keep an eye on. The graph never learns which file woke it, so the intake reads a fixed path and watching a directory does not work today. The script must be idempotent, or the same issue rewritten produces the same spec twice. And nothing here pushes: the graph commits on a branch, and opening the pull request stays a human decision, which is the correct default for work done unattended.
