#!/usr/bin/env bash
# Spin up (or tear down) a git worktree — the dev-side way to run parallel branches.
#
# Why a helper and not just `git worktree add`: a worktree is a *clean* checkout.
# .env, node_modules/ and agent/var/ are all gitignored, so none of them are
# copied into a new tree. A fresh worktree therefore needs `npm install` before
# its tests run, and can't run the live bot at all. This script does the two
# mechanical steps this repo's layout makes non-obvious — place the tree as a
# sibling, install deps — so "start a branch" doesn't also mean "remember five
# things about this repo".
#
# Worktrees live as siblings under ../alfred-node.worktrees/, never nested in the
# repo: a checkout inside the repo shows up as an untracked directory in the
# parent's `git status` and carries its own agent/ tree a directory walk can
# stumble into. Outside the repo, each tree's status stays about that tree.
#
# Usage:
#   scripts/worktree.sh <type/short-description> [base]   create branch + worktree + install
#   scripts/worktree.sh ls                                list worktrees
#   scripts/worktree.sh rm <type/short-description>       remove a worktree (branch is kept)
#
#   base defaults to `main`. Branch type is one of: feat fix chore docs refactor
#   (the same set CONTRIBUTING.md allows).
set -euo pipefail

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
WT_HOME="$(dirname "$REPO")/alfred-node.worktrees"
TYPES='feat|fix|chore|docs|refactor'

die()   { echo "❌ $*" >&2; exit 1; }
slug()  { printf '%s' "$1" | tr '/' '-'; }
usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d;s/^# \{0,1\}//'
}

cmd="${1:-}"
case "$cmd" in
  ""|-h|--help|help)
    usage; exit 0 ;;

  ls)
    git -C "$REPO" worktree list; exit 0 ;;

  rm)
    branch="${2:-}"
    [ -n "$branch" ] || die "rm needs a branch name, e.g. scripts/worktree.sh rm feat/foo"
    path="$WT_HOME/$(slug "$branch")"
    [ -d "$path" ] || die "No worktree at $path"
    git -C "$REPO" worktree remove "$path"
    git -C "$REPO" worktree prune
    echo "✅ Removed worktree $path"
    echo "   The branch '$branch' is kept. Delete it with: git branch -d $branch"
    exit 0 ;;
esac

# --- create ------------------------------------------------------------------
branch="$cmd"
base="${2:-main}"

[[ "$branch" =~ ^($TYPES)/[a-z0-9._-]+$ ]] \
  || die "Branch must be <type>/<short-description>, type one of: ${TYPES//|/ }
   e.g. feat/slash-status  fix/dns-crash  chore/worktree-tooling"

path="$WT_HOME/$(slug "$branch")"
[ -e "$path" ] && die "Path already exists: $path"

mkdir -p "$WT_HOME"

# Reuse the branch if it already exists; otherwise cut it from base.
if git -C "$REPO" show-ref --verify --quiet "refs/heads/$branch"; then
  echo "→ Branch $branch exists; checking it out into a new worktree."
  git -C "$REPO" worktree add "$path" "$branch"
else
  echo "→ Creating branch $branch from $base."
  git -C "$REPO" worktree add -b "$branch" "$path" "$base"
fi

echo "→ Installing dependencies (npm ci)."
if [ -f "$path/package-lock.json" ]; then
  ( cd "$path" && npm ci )
else
  ( cd "$path" && npm install )
fi

cat <<EOF

✅ Worktree ready.
   cd $path
   ...work, commit, open the PR from there...
   scripts/worktree.sh rm $branch   # when it's merged

   Note: this is a dev checkout — no .env, no agent/var/, so \`npm start\` won't
   run the live bot here. \`npm test\` / \`npm run check\` / \`npm run map:check\` do.
EOF
