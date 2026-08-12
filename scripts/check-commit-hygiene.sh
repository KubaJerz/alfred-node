#!/usr/bin/env bash
# Commit hygiene. Two things this catches, both of which already happened:
#
#   1. A commit landing on `main`. CONTRIBUTING has said "never commit directly
#      to main" since day one, and it was still only a sentence. The day it got
#      broken, the recovery (re-apply on the right branch) is what produced (2).
#   2. A duplicate subject. `docs: forwarded invites on the backlog...` exists
#      twice in this history, same message, same minute, different hashes —
#      a commit re-applied after landing on the wrong branch.
#
# Deliberately NOT enforced: how many commits a change is worth splitting into.
# That's judgement, and a hook that guessed at it would be wrong more often than
# the human. It's a rule in CONTRIBUTING instead. The one exception is the
# docs-churn *warning* below, which suggests and never blocks.
#
# Usage: check-commit-hygiene.sh [<path-to-commit-message-file>]
#   With no argument, runs only the checks that don't need the message.
set -euo pipefail

MSG_FILE="${1:-}"
PROTECTED_BRANCHES="main master"

fail() {
  echo "❌ $1" >&2
  shift
  for line in "$@"; do echo "   $line" >&2; done
  echo >&2
  echo "   Bypass only if you know why: git commit --no-verify" >&2
  exit 1
}

# --- 1. Not on a protected branch -------------------------------------------
# Detached HEAD reports no branch name; leave that alone, it's usually a rebase.
branch="$(git symbolic-ref --quiet --short HEAD || true)"
for protected in $PROTECTED_BRANCHES; do
  if [ "$branch" = "$protected" ]; then
    fail "Commit on '$branch' blocked." \
      "Every change goes on a branch and lands through a PR." \
      "" \
      "   git checkout -b type/short-description   # feat fix chore docs refactor" \
      "" \
      "   Already staged? The branch takes the staged changes with it."
  fi
done

# Nothing below needs more than the branch name.
[ -n "$MSG_FILE" ] && [ -f "$MSG_FILE" ] || exit 0

# A merge resolution reuses a generated message and isn't a hand-written commit.
git rev-parse --quiet --verify MERGE_HEAD >/dev/null 2>&1 && exit 0

subject="$(sed -e '/^#/d' -e '/^$/d' "$MSG_FILE" | head -1)"
[ -n "$subject" ] || exit 0

# --- 2. Subject not already used --------------------------------------------
# Scanning --all rather than HEAD's ancestry is the point: the duplicate this
# exists to prevent was made on one branch and re-made on another, so at commit
# time the first copy was not an ancestor of the second.
#
# HEAD itself is excluded so `git commit --amend` doesn't collide with the very
# commit it's replacing — amending is what we want people reaching for.
head_hash="$(git rev-parse --quiet --verify HEAD || true)"
if [ -n "$head_hash" ]; then
  duplicate="$(
    git log --all --since="30 days ago" --pretty=$'%H\t%s' 2>/dev/null |
      grep -v "^${head_hash}"$'\t' |
      awk -F'\t' -v s="$subject" '$2 == s { print $1; exit }'
  )"
  if [ -n "$duplicate" ]; then
    fail "That subject is already in the history." \
      "$(git log -1 --pretty='%h %ad %s' --date=format:'%Y-%m-%d %H:%M' "$duplicate")" \
      "" \
      "   Same change re-applied? Drop this one — the commit already exists." \
      "   Genuinely a follow-up? Say what's different in the subject."
  fi
fi

# --- 3. Docs churn — warn, never block --------------------------------------
# One commit per realization is how eight docs commits happened in a day.
staged="$(git diff --cached --name-only --diff-filter=ACMR || true)"
if [ -n "$staged" ] && ! echo "$staged" | grep -qv '\.md$'; then
  base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  if [ -n "$base" ]; then
    docs_commits=0
    for commit in $(git rev-list "$base"..HEAD 2>/dev/null); do
      files="$(git show --pretty=format: --name-only "$commit" | grep -v '^$' || true)"
      [ -n "$files" ] || continue
      echo "$files" | grep -qv '\.md$' || docs_commits=$((docs_commits + 1))
    done
    if [ "$docs_commits" -ge 1 ]; then
      echo "⚠️  This branch already has $docs_commits docs-only commit(s)." >&2
      echo "   Prefer 'git commit --amend' — notes are one commit, not one per thought." >&2
      echo "   Continuing anyway." >&2
    fi
  fi
fi

exit 0
