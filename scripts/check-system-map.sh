#!/usr/bin/env bash
# Keep SYSTEM-MAP.md honest.
#
# A hand-written map is worth more than a generated one right up until it's
# wrong, at which point it's worth less than nothing — it gets believed. This
# doesn't check that the map is *good*; it checks the two ways it goes stale on
# its own:
#
#   1. Something was added to the system and never drawn.
#   2. The map names something that no longer exists.
#
# Deliberately NOT wired into the pre-commit hook. A diagram lagging by one
# commit is not a reason to block work; it's a reason to notice before a PR.
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
MAP="$ROOT/SYSTEM-MAP.md"
fails=0

note() { echo "  $*" >&2; }
fail() { echo "❌ $*" >&2; fails=$((fails + 1)); }

if [ ! -f "$MAP" ]; then
  echo "❌ SYSTEM-MAP.md is missing." >&2
  exit 1
fi
map="$(cat "$MAP")"

# --- 1. everything that exists is on the map ---------------------------------
# Source files and skills only. Docs describe the system; they aren't part of
# the picture, and listing them would just be a table of contents.
missing=()
while IFS= read -r f; do
  case "$f" in
    node_modules/*|test/*|*.example) continue ;;
  esac
  # Match the basename too: the map says "bin/*.js" in one place and names the
  # files in another, and either is a fair way to have drawn it.
  grep -qF "$f" <<<"$map" || grep -qF "$(basename "$f")" <<<"$map" || missing+=("$f")
done < <(git -C "$ROOT" ls-files '*.js' '*.sh' | grep -v '^scripts/')

for d in "$ROOT"/agent/.claude/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  grep -qF "$name" <<<"$map" || missing+=("skill: $name")
done

if [ ${#missing[@]} -gt 0 ]; then
  fail "On disk but not on the map:"
  for m in "${missing[@]}"; do note "- $m"; done
  note "  Draw it, or say in the map why it isn't worth drawing."
fi

# --- 2. everything on the map still exists -----------------------------------
# Backticked tokens that look like repo paths. Skips broker routes (leading /),
# flags, glob patterns, and anything under agent/var/ — that tree is runtime
# state and legitimately absent from a fresh clone.
#
# Names that only exist at runtime. The map is right to mention them and a fresh
# clone is right not to have them, so matching on disk would make this check
# depend on whether the bot had ever run.
RUNTIME_NAMES="state.json MEMORY.md messages.jsonl USER.md token.json last-dream"

tracked="$(git -C "$ROOT" ls-files)"
gone=()
while IFS= read -r p; do
  [ -n "$p" ] || continue
  case "$p" in
    /*|-*|*\**|agent/var/*|http*|*.example) continue ;;
  esac
  p="${p%/}"
  case " $RUNTIME_NAMES " in *" $p "*) continue ;; esac
  # Present as written, or as a suffix of something tracked — the map refers to
  # `.claude/skills/` and `SOUL.md` without repeating `agent/` every time, and
  # spelling out full paths in prose reads worse than it informs.
  [ -e "$ROOT/$p" ] && continue
  grep -qE "(^|/)${p//./\\.}(/|$)" <<<"$tracked" && continue
  gone+=("$p")
done < <(grep -oE '`[A-Za-z0-9_./-]+`' "$MAP" | tr -d '`' | grep -E '/|\.(js|sh|md|json)$' | sort -u)

if [ ${#gone[@]} -gt 0 ]; then
  fail "On the map but not on disk:"
  for g in "${gone[@]}"; do note "- $g"; done
fi

# --- 3. the broker route counts are right ------------------------------------
# The numbers in the map worth verifying mechanically: each is the size of the
# agent's entire reach into one service, and exactly the kind of fact that stays
# written down long after it stopped being true. Google and Notion are separate
# reaches through the same loopback server, so each gets its own count.
check_routes() {
  local file="$1" label="$2" actual claimed
  actual="$(grep -cE '^\s*"(GET|POST|PATCH|DELETE) /' "$file" || echo 0)"
  claimed="$(grep -oE "[0-9]+ $label routes" "$MAP" | head -1 | grep -oE '^[0-9]+' || echo "")"
  if [ -z "$claimed" ]; then
    fail "The map should state the $label route count as \"N $label routes\" (actual: $actual)."
  elif [ "$claimed" != "$actual" ]; then
    fail "Map says $claimed $label routes; $file has $actual."
  fi
}
check_routes "$ROOT/google/broker.js" "Google"
check_routes "$ROOT/notion/broker.js" "Notion"
check_routes "$ROOT/intervals/broker.js" "Intervals"

# --- 4. the root stays free of a skills dir ----------------------------------
# Not drift, but the map asserts it, and the assertion is load-bearing: skill
# discovery walks up from agent/, so a root .claude/skills/ would load into
# Alfred and quietly falsify "Alfred never reads the dev layer".
if [ -d "$ROOT/.claude/skills" ]; then
  fail ".claude/skills/ exists at the repo root — Alfred would load it."
  note "  See the three-layers section of SYSTEM-MAP.md."
fi

if [ "$fails" -gt 0 ]; then
  echo >&2
  echo "System map is out of date ($fails problem(s))." >&2
  exit 1
fi
echo "✅ System map matches the tree."
