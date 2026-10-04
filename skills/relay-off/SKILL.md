---
name: relay-off
description: "Turn the relay snapshot toolbar off for this project: hide it on open pages, remove its code and launch config, and stop the relay server. Use when the user types /relay-off or asks to turn off, remove or disable relay or its toolbar."
---

# relay-off

Be fast: one script call and a one-line reply. Don't read files or explain the mechanics.

1. Run from the session's folder:
   ```bash
   node ~/.claude/skills/relay/relay.mjs off
   ```
   It only touches this session's relay, never other projects' relays or relay's own demo:
   - hides the toolbar on open pages straight away, then stops that relay server;
   - removes the toolbar code from the project and the `relay` entry from the session's
     `.claude/launch.json`;
   - leaves the `<project>.relay/` canvas, including `canvas.html`, in place.

2. Reply in one line, for example "Relay is off for checklist-pages; your canvas is still in
   `checklist-pages.relay/`." Use the JSON output:
   - `found: false`: say relay wasn't on here.
   - Otherwise pass on any `notes` that ask for something, such as several relays running or the
     demo needing `npm run demo` stopped.
