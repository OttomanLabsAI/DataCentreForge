#!/usr/bin/env bash
# Copy the files the owner supplied for version N into its folder, each under
# the owner's own name.
#
#   scripts/attach.sh N /path/to/54befd40-DCBuildmanholes.json [more files...]
#
# An upload arrives with a hash prefix on its name; the prefix goes and the
# rest stays. A picture the client saved as 1.png or 2.webp keeps that name.
set -euo pipefail
N="${1:?usage: attach.sh N FILE...}"; shift
[ "$#" -ge 1 ] || { echo "usage: attach.sh N FILE..." >&2; exit 2; }
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DIR="$ROOT/prompt text/$N"
[ -d "$DIR" ] || { echo "attach.sh: prompt text/$N does not exist - run archive.sh $N first" >&2; exit 1; }
for f in "$@"; do
  [ -f "$f" ] || { echo "attach.sh: no such file: $f" >&2; exit 1; }
  base="$(basename -- "$f")"
  name="$(printf '%s' "$base" | sed -E 's/^[0-9a-f]{8}-//')"
  [ -n "$name" ] || name="$base"
  cp -- "$f" "$DIR/$name"
  chmod 644 "$DIR/$name"
  echo "prompt text/$N/$name: $(wc -c < "$DIR/$name" | tr -d ' ') bytes"
done
