# Canopy remote

Reach your Canopy sessions from a browser at remote.univerlab.org: pair
once with the code `canopy` shows, pick a host, and drive its sessions —
or watch its graphs — over an encrypted peer-to-peer link. `web/` is the
browser app, `worker/` the blind signaling relay that introduces the two
ends (see its own README).

## Working in a session

The key bar under the terminal carries what a phone keyboard lacks. Ctrl and
Shift are one-shot modifiers: a tap arms the key and opens the keyboard, the
next key goes out with it, and a second tap disarms it. On a phone, only
Ctrl, Shift, and a tap on the terminal pane open the keyboard; other bar keys
keep a dismissed keyboard closed, and you can always reopen it with Ctrl,
Shift, or a pane tap. While the keyboard is up the session view follows it:
the terminal and the key bar stay above it and the pane keeps its last rows in
view, with the session bar, terminal controls and size row stepping aside.

**Copy** opens the terminal's text in a sheet where the phone's own long-press
selection works, with Copy selection and Copy all. With a mouse, drag over the
terminal and use the floating Copy button or `Ctrl+Shift+C`; plain `Ctrl+C`
always stays an interrupt for the session.

**Close** ends the session on the host, not just this device's view: the
first tap arms a "Close?" confirm for a few seconds, the second sends
`kill{req,id}` and the view returns to the sessions list with a "Session
closed" note. A host refusal shows its message beside the title and the
button re-arms.

The **Prompt Builder** sends now or later: Schedule picks a date and time, and
the sheet lists the session's pending schedules, each with a Cancel. The host
delivers a schedule even with no browser open; it needs the session still
running at that time. Terminals take no schedules, only agent sessions do.

## Watching graphs

The home screen switches between **Sessions** and **Graphs**. Graphs lists
every graph running on the machine — name, status, `done/total` with a
progress bar, the current spec and the workdir — refreshed when shown and
every 10 seconds while visible.

Tapping a row opens the graph: the same plate the catalogue draws, with
the running node lit, the passed and failed nodes badged, and the queue
below it as a checklist that ticks as specs finish. The plate is a pan and
zoom canvas at every size. Leaving the view (back,
another tab, a hidden page) stops the live updates; returning resumes
them. If the link drops, the view keeps its last state and says when it
arrived, then resumes on reconnect.

Watching is read-only: the remote never pauses, continues or resets a
graph. Against the fake host (`/fake.html` in development) two fixture
graphs — one running with an ensemble, one completed — exercise the whole
view, the running one advancing every 2 seconds.

## Guests

A host shares sessions with another GitHub account through an invite:
`canopy remote invite <login>` prints a single-use code and the guest
link `<origin>/g/<owner_uid>/<host_id>#invite=<code>`. The guest opens
the link and signs in with GitHub (the page comes back to the link after
the sign-in); the code rides the fragment, so it never reaches the
relay's logs or a Referer. The page keeps it in this tab's
sessionStorage only, strips it from the address bar, and opens the
relay's guest door with its canonical `CNR-XXXX-XXXX-XXXX-XXXX` form,
the string whose SHA-256 the host publishes. A link without a code asks
for it in a form (case, spaces and dashes do not matter). The relay
refuses a wrong, expired, revoked or used code before the socket opens;
the page says so and asks again. Each code opens the door once, so a
guest whose relay socket closes after joining needs a fresh invite.
Against the fake host, `/fake.html?screen=guest` starts connected,
`&invite=ask` starts on the form and `&invite=refuse` also refuses the
first code.
