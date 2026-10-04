#!/usr/bin/env node
// The off skill runs the same script as the on skill. Node resolves this file's
// real path (through a ~/.claude/skills link too), so the sibling import always works.
import "../on/relay.mjs";
