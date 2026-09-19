#!/usr/bin/env bash
# Start version N of the archive: remove every folder under "prompt text/"
# except N, create "prompt text/N/" and write the model attribution.
# The prompt (input.txt), the reply (output.txt) and any attachments are
# written by put.sh and attach.sh, because they are the owner's exact words
# and files and must arrive untouched.
#
#   scripts/archive.sh N|next [maker] [family] [model]
#
# "next" reads the one folder in service and starts the version after it.
set -euo pipefail
ARG="${1:?usage: archive.sh N|next [maker] [family] [model]}"
MAKER="${2:-Anthropic}"; FAMILY="${3:-Claude}"; MODEL="${4:-Fable 5 Max}"
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
mkdir -p "prompt text"
have=()
for d in "prompt text"/*/; do [ -d "$d" ] && have+=("$(basename "$d")"); done
if [ "$ARG" = "next" ]; then
  if [ "${#have[@]}" -ne 1 ] || ! [[ "${have[0]}" =~ ^[0-9]+$ ]]; then
    echo "archive.sh: cannot work out the next version - the folder in service should be exactly one numbered folder, found: ${have[*]:-none}. Give the number." >&2
    exit 1
  fi
  N=$(( have[0] + 1 ))
else
  [[ "$ARG" =~ ^[0-9]+$ ]] || { echo "archive.sh: the version must be a whole number or 'next', not '$ARG'" >&2; exit 1; }
  N="$ARG"
fi
for name in "${have[@]}"; do
  [ "$name" = "$N" ] && continue
  d="prompt text/$name"
  if git ls-files --error-unmatch -- "$d" >/dev/null 2>&1; then git rm -rq -- "$d"; else rm -rf -- "$d"; fi
  echo "removed prompt text/$name"
done
mkdir -p "prompt text/$N"
printf '%s\n%s\n%s\n' "$MAKER" "$FAMILY" "$MODEL" > "prompt text/$N/ai model.txt"
echo "prompt text/$N started ($MAKER / $FAMILY / $MODEL): now put.sh $N input, attach.sh $N <files>, and put.sh $N output once the reply is final"
