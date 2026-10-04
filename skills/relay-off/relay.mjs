#!/usr/bin/env node
// The off skill runs the same script as the relay-on skill. Node resolves this file's
// real path (through a ~/.claude/skills link too), so the sibling import always works.
import "../relay-on/relay.mjs";
