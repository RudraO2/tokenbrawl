#!/usr/bin/env bash
#
# Story 5.3, AC5, mechanism 4 of 4: nothing about to be committed contains an
# API key.
#
# The CLI already redacts what it prints and refuses to *write* a document
# containing a key (`packages/cli/src/secrets.ts`). This is the check that does
# not trust it. It runs between the tournament step and the commit step, so a
# leak fails the job with nothing pushed -- which is the only ordering that
# matters, because a key pushed to a public repository is a key that has to be
# rotated, not one that can be un-pushed.
#
# Usage:  bash scripts/assert-no-secret-leak.sh GROQ_API_KEY CEREBRAS_API_KEY ...
#
# Arguments are variable NAMES. Values are read from the environment here and
# never appear in an argument list, in output, or in a diagnostic. A leak
# detector that echoes its evidence is itself the leak, so this script prints
# the offending FILE and the variable NAME, and never the matched line.

set -uo pipefail

# Mirrors MIN_API_KEY_LENGTH in packages/cli/src/secrets.ts, for the same
# reason it exists there: a one-character "secret" would match almost every
# file in the repository and turn this gate into an unconditional failure.
MIN_SECRET_LENGTH=8

LEAKED=0
CHECKED=0

if [ "$#" -eq 0 ]; then
  echo "assert-no-secret-leak: no variable names given; nothing was checked." >&2
  echo "This is a configuration error, not a pass." >&2
  exit 2
fi

for name in "$@"; do
  # Indirect expansion: `${!name}` is the value of the variable *named* by
  # $name. Unset is empty rather than an error, which `set -u` would otherwise
  # make fatal.
  value="${!name:-}"

  if [ -z "$value" ]; then
    echo "  --    $name is unset or empty; skipped."
    continue
  fi

  if [ "${#value}" -lt "$MIN_SECRET_LENGTH" ]; then
    echo "  FAIL  $name is shorter than $MIN_SECRET_LENGTH characters." >&2
    echo "        Refusing to scan for it: a short string matches everything." >&2
    LEAKED=1
    continue
  fi

  CHECKED=$((CHECKED + 1))

  # The pattern arrives on stdin (`-f -`), never in argv, so the value is not
  # visible to `ps` on a shared runner. `-F` is fixed-string: a key may contain
  # regex metacharacters, and a pattern built from one quietly stops matching
  # the string it exists to find. `-l` lists file names only, never lines.
  hits=$(printf '%s\n' "$value" | grep -rlIFf - \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist \
    --exclude-dir=build --exclude-dir=coverage --exclude-dir=.turbo \
    . 2>/dev/null)

  if [ -n "$hits" ]; then
    echo "  FAIL  the value of $name appears in the working tree:" >&2
    echo "$hits" | sed 's/^/          /' >&2
    LEAKED=1
  else
    echo "  ok    $name does not appear anywhere in the working tree."
  fi
done

if [ "$LEAKED" -ne 0 ]; then
  echo >&2
  echo "SECRET LEAK CHECK FAILED -- nothing was committed." >&2
  echo "Rotate the affected key before doing anything else: it is in the tree," >&2
  echo "and if this had reached a public repository it would already be public." >&2
  exit 1
fi

if [ "$CHECKED" -eq 0 ]; then
  echo >&2
  echo "assert-no-secret-leak: every named variable was empty, so nothing was" >&2
  echo "actually scanned. Refusing to report a pass on a check that did not run." >&2
  exit 2
fi

echo "secret leak check passed ($CHECKED scanned)"
exit 0
