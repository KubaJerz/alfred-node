#!/usr/bin/env bash
# Refuse to commit anything personal. Run manually with `npm run check`, and
# automatically as a pre-commit hook (see CONTRIBUTING.md for the one-line
# `git config core.hooksPath .githooks` that installs it).
#
# The .gitignore rules are correct today, but "correct today" isn't the property
# we want: Alfred runs with Bash, Write and --dangerously-skip-permissions in
# this very repo, and a `git add -f` or a new state file written outside
# agent/var/ would sail straight past a rule nobody re-reads. This checks the
# staged set on every commit instead of trusting that.
#
# Exit 0 = nothing personal staged. Exit 1 = blocked, with the reason.

set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

fail=0
note() { echo "  $*" >&2; }
block() { echo "❌ $*" >&2; fail=1; }

# --diff-filter=d: a staged *deletion* of a private file is fine (that's the fix,
# not the leak). Only additions and modifications are interesting.
mapfile -t staged < <(git diff --cached --name-only --diff-filter=d)
[ ${#staged[@]} -eq 0 ] && exit 0

# 1. Paths that are personal by location, regardless of what .gitignore says.
#    Checking the path directly means a weakened ignore rule can't silently
#    re-open the hole.
for f in "${staged[@]}"; do
  case "$f" in
    agent/var/*|.env|*/.env)
      block "Personal file staged: $f"
      note "agent/var/ is Alfred's private state and never belongs in git."
      ;;
  esac
done

# 2. Force-added files that .gitignore would otherwise have caught. `git add -f`
#    is the documented way around the rules, so it needs its own check.
#    --no-index is load-bearing: without it, check-ignore ignores paths that are
#    already in the index — which is every file this check is meant to catch.
for f in "${staged[@]}"; do
  if git check-ignore -q --no-index "$f" 2>/dev/null; then
    block "Ignored file force-added: $f"
    note "It matches .gitignore, so staging it took an explicit --force."
  fi
done

# 3. Secret-shaped content in the staged diff, for the case where a credential
#    is pasted into a file that lives in a perfectly legitimate location.
#    Scans added lines only. This script is excluded, since it contains the
#    patterns it searches for.
secrets=$(git diff --cached -U0 --diff-filter=d -- . \
            ':!scripts/check-no-secrets.sh' ':!package-lock.json' \
          | grep '^+' | grep -vE '^\+\+\+' \
          | grep -nEi \
            -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
            -e '"private_key"[[:space:]]*:' \
            -e 'GOCSPX-[A-Za-z0-9_-]{10,}' \
            -e 'AIza[0-9A-Za-z_-]{35}' \
            -e 'ya29\.[0-9A-Za-z_-]{20,}' \
            -e '"refresh_token"[[:space:]]*:[[:space:]]*"1//' \
            -e 'gh[pousr]_[A-Za-z0-9]{30,}' \
            -e 'sk-[A-Za-z0-9]{20,}' \
            -e 'ntn_[A-Za-z0-9]{40,}' \
            -e 'secret_[A-Za-z0-9]{43}' \
            -e '[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}' \
          | head -5)
if [ -n "$secrets" ]; then
  block "Secret-shaped content in the staged diff:"
  echo "$secrets" | sed 's/^/    /' >&2
fi

# 4. A new top-level directory that looks like runtime state. Advisory only —
#    this one guesses, and a wrong guess shouldn't block a legitimate commit.
for f in "${staged[@]}"; do
  case "$f" in
    var/*|logs/*|memories/*|state.json|messages.jsonl)
      echo "⚠️  $f looks like runtime state at the repo root." >&2
      note "State belongs under agent/var/. Check this is really execution code."
      ;;
  esac
done

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "Commit blocked. Unstage with: git restore --staged <file>" >&2
  echo "If this is genuinely a false positive: git commit --no-verify" >&2
  exit 1
fi

echo "✅ ${#staged[@]} staged file(s), nothing personal."
