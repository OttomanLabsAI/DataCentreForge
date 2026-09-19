#!/usr/bin/env bash
# Is the archive fit to ship? Exactly one version folder; input.txt and
# output.txt present and not empty; "ai model.txt" three lines; every file
# in the folder staged and no previous folder left half-removed. Prints what
# it finds and exits 1, with the reason, on the first thing wrong.
#
#   scripts/check.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
fail(){ echo "check.sh: $*" >&2; exit 1; }
[ -d "prompt text" ] || fail "there is no 'prompt text' folder"
have=()
for d in "prompt text"/*/; do [ -d "$d" ] && have+=("$(basename "$d")"); done
[ "${#have[@]}" -eq 1 ] || fail "the archive should hold exactly one version folder, found: ${have[*]:-none}"
N="${have[0]}"; D="prompt text/$N"
[[ "$N" =~ ^[0-9]+$ ]] || fail "the folder in service should be a version number, not '$N'"
for f in input.txt output.txt "ai model.txt"; do
  [ -f "$D/$f" ] || fail "$D/$f is missing"
  [ -s "$D/$f" ] || fail "$D/$f is empty"
done
[ "$(wc -l < "$D/ai model.txt" | tr -d ' ')" -eq 3 ] || fail "$D/ai model.txt should be exactly three lines"
for f in input.txt output.txt; do
  if [ "$(tail -c 1 "$D/$f" | od -An -c | tr -d ' \n')" = '\n' ]; then echo "note: $D/$f ends with a newline the message may not have had"; fi
done
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  unstaged="$(git status --porcelain -- "prompt text" | grep -v '^[MADR] ' || true)"
  [ -z "$unstaged" ] || fail "not everything under 'prompt text' is staged - run: git add -A \"prompt text\"
$unstaged"
fi
echo "prompt text/$N is in service:"
for f in "$D"/*; do printf '  %-24s %8s bytes\n' "$(basename -- "$f")" "$(wc -c < "$f" | tr -d ' ')"; done
echo "model: $(awk 'NR>1{printf " / "} {printf "%s", $0} END{print ""}' "$D/ai model.txt")"
