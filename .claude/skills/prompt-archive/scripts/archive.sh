#!/usr/bin/env bash
# Swap the prompt archive to version N: remove every previous folder under
# "prompt text/", create "prompt text/N/" and write the model attribution.
# The prompt (input.txt), the reply (output.txt) and any attachments are
# written separately, because they are the owner's exact words and files.
#
#   scripts/archive.sh N [maker] [family] [model]
#
set -euo pipefail
N="${1:?usage: archive.sh N [maker] [family] [model]}"
MAKER="${2:-Anthropic}"; FAMILY="${3:-Claude}"; MODEL="${4:-Fable 5 Max}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
mkdir -p "prompt text"
for d in "prompt text"/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  [ "$name" = "$N" ] && continue
  if git ls-files --error-unmatch "$d" >/dev/null 2>&1; then git rm -rq -- "$d"; else rm -rf -- "$d"; fi
  echo "removed prompt text/$name"
done
mkdir -p "prompt text/$N"
printf '%s\n%s\n%s\n' "$MAKER" "$FAMILY" "$MODEL" > "prompt text/$N/ai model.txt"
echo "prompt text/$N ready: write input.txt, output.txt and copy the owner's files, then git add \"prompt text\""
