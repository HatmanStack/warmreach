#!/usr/bin/env bash
# Pre-tool-use hook for the Bash tool. Reads a JSON event on stdin
# (Claude Code passes the tool input there) and blocks branch-mixing
# git commands that have repeatedly caused history divergence on this
# repo.
#
# Exit 0 -> allow the command.
# Exit 1 -> tell Claude the command is blocked; the message on stderr is
#           shown to Claude and the user.
#
# Tripwires:
#   * `git merge` / `git rebase` (any form except `git rebase --abort`)
#   * `git push --force` / `git push -f` / `git push --force-with-lease`
#   * `git checkout main` / `git switch main` immediately followed by a
#     merge or push within the SAME bash invocation (caught via grep on
#     the joined command line).
#
# A fast escape hatch is provided: prefix the command with
# `WR_ALLOW_GIT_MIX=1 ` and the hook lets it through. Use only after the
# user explicitly approves.

set -euo pipefail

input=$(cat || true)

# Pull the command field out of the JSON without depending on jq being
# installed. The Bash tool input shape is { "command": "...", "description": "..." }.
cmd=$(printf '%s' "$input" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print((data.get("tool_input") or data).get("command", ""))
' 2>/dev/null || true)

if [ -z "$cmd" ]; then
  exit 0
fi

# Explicit user override
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])WR_ALLOW_GIT_MIX=1[[:space:]]'; then
  exit 0
fi

block() {
  echo "BLOCKED by .claude/hooks/guard-git.sh:" >&2
  echo "  $1" >&2
  echo "" >&2
  echo "If the user has explicitly asked for this, re-run the command prefixed" >&2
  echo "with WR_ALLOW_GIT_MIX=1 (e.g. \`WR_ALLOW_GIT_MIX=1 git merge ...\`)." >&2
  exit 1
}

# git merge / rebase — except `git rebase --abort` and `git merge --abort`
if printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])git[[:space:]]+merge([[:space:]]|$)'; then
  if ! printf '%s' "$cmd" | grep -qE 'git[[:space:]]+merge[[:space:]]+--abort'; then
    block "git merge sweeps another branch's history into the current one. Two divergences already happened this way."
  fi
fi
if printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])git[[:space:]]+rebase([[:space:]]|$)'; then
  if ! printf '%s' "$cmd" | grep -qE 'git[[:space:]]+rebase[[:space:]]+--(abort|continue|skip)'; then
    block "git rebase rewrites history; not allowed without explicit approval."
  fi
fi

# git push --force / -f / --force-with-lease
if printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z])git[[:space:]]+push[[:space:]].*(--force(-with-lease)?|[[:space:]]-f([[:space:]]|$))'; then
  block "git push --force / --force-with-lease is destructive on shared branches."
fi

# git checkout main / git switch main combined with merge/push in the same command
if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+(checkout|switch)[[:space:]]+main([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -qE '(merge|push)([[:space:]]|$)'; then
    block "Switching to main and immediately merging/pushing in one command is the exact pattern that caused the last history divergence."
  fi
fi

exit 0
