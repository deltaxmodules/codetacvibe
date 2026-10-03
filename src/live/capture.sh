#!/bin/sh
# Live mode, phase L1: what the Claude Code hooks of each tool use run
# (PreToolUse, PostToolUse, PostToolUseFailure, Notification, PermissionRequest), installed by
# `codetac hooks install`. It only keeps the event's JSON, as it came, in a
# file of its own in the waiting folder given as $1 (outside the project), so
# the agent is not slowed down (docs/live/ensaio-captura.md: ~6 ms, no
# measurable delay). The Stop hook (and the panel) reads the folder, redacts
# each event, adds it to the session's log and removes the raw file
# (src/live/events.mjs). Like every CodeTAC hook it prints nothing and always
# exits with 0: it never gets in the way of the agent.
d=$1
[ -n "$d" ] || exit 0
umask 077
mkdir -p "$d" 2>/dev/null
f="$d/$(date +%s)-$$"
# Written under a temporary name and renamed whole: a half-written event is never read.
cat > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f.json" 2>/dev/null
exit 0
