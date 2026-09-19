#!/usr/bin/env bash
# Write the prompt or the reply of version N from standard input, byte for byte.
#
#   scripts/put.sh N input <<'TEXT'
#   the owner's words
#   TEXT
#   scripts/put.sh N output < reply.txt
#
# A here-document ends with a newline the message never had, so exactly one
# trailing newline is dropped; everything else arrives untouched. An empty
# text is refused - an empty record is worse than none.
set -euo pipefail
N="${1:?usage: put.sh N input|output   (the text on standard input)}"
KIND="${2:?usage: put.sh N input|output   (the text on standard input)}"
case "$KIND" in input|output) ;; *) echo "put.sh: the second argument is 'input' or 'output', not '$KIND'" >&2; exit 2;; esac
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
DIR="$ROOT/prompt text/$N"
[ -d "$DIR" ] || { echo "put.sh: prompt text/$N does not exist - run archive.sh $N first" >&2; exit 1; }
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
cat > "$TMP"
python3 - "$TMP" "$DIR/$KIND.txt" "$N" "$KIND" <<'PY'
import sys
data = open(sys.argv[1], 'rb').read()
if data.endswith(b'\n'): data = data[:-1]
if not data.strip():
    sys.exit(f"put.sh: nothing to write - the {sys.argv[4]} text is empty")
open(sys.argv[2], 'wb').write(data)
lines = data.count(b'\n') + 1
print(f"prompt text/{sys.argv[3]}/{sys.argv[4]}.txt: {len(data)} bytes, {lines} lines")
PY
