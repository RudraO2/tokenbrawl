#!/usr/bin/env bash
#
# Tokenbrawl invariant audit.
#
# The machine half of the story gate: this script plus a green test suite.
# A reviewer saying "looks good" is not a gate.
#
# Exits non-zero on any violation. Invariants that are not yet mechanically
# checkable are listed explicitly under UNMECHANISED rather than silently
# skipped — a gate that quietly checks nothing is worse than no gate.
#
# Extend this script as invariants gain enforceable checks. See docs/INVARIANTS.md.

set -uo pipefail

FAIL=0
CORE_GLOBS=("packages/core" "packages/env-fighter" "packages/env-microrts")

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
dim()   { printf '\033[2m%s\033[0m\n' "$1"; }

fail() { red "  FAIL  $1"; FAIL=1; }
pass() { green "  ok    $1"; }
skip() { dim   "  --    $1"; }

# Search only directories that exist yet. Early epics legitimately lack some.
existing_core() {
  local out=()
  for d in "${CORE_GLOBS[@]}"; do [ -d "$d" ] && out+=("$d"); done
  printf '%s\n' "${out[@]}"
}

grep_core() {
  local pattern="$1"
  local dirs
  mapfile -t dirs < <(existing_core)
  [ ${#dirs[@]} -eq 0 ] && return 1
  grep -rnE --include='*.ts' --include='*.tsx' "$pattern" "${dirs[@]}" 2>/dev/null
}

echo
echo "Tokenbrawl invariant audit"
echo "=========================="

# --- INV-1: no wall-clock time may influence outcome -----------------------
echo
echo "INV-1  no wall-clock time influences outcome"
if [ -z "$(existing_core)" ]; then
  skip "no simulation packages yet"
else
  hits=$(grep_core '\b(Date\.now|performance\.now|new Date\(|setTimeout|setInterval)\b')
  if [ -n "$hits" ]; then
    fail "wall-clock or timer API in simulation code:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no wall-clock or timer APIs in simulation code"
  fi
fi

# --- INV-2: deterministic and replayable -----------------------------------
echo
echo "INV-2  matches are deterministic and replayable"
if [ -z "$(existing_core)" ]; then
  skip "no simulation packages yet"
else
  hits=$(grep_core '\bMath\.random\b')
  if [ -n "$hits" ]; then
    fail "Math.random in simulation code (PRNG must be seeded and threaded through state):"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no unseeded randomness"
  fi

  # Float literals and float-producing operators in simulation state.
  hits=$(grep_core '(\bMath\.(random|sin|cos|sqrt|pow|atan2)\b|[0-9]+\.[0-9]+)' \
         | grep -vE '(^\S+:[0-9]+:\s*(//|\*|/\*))|version|Version|\.test\.ts|\.spec\.ts')
  if [ -n "$hits" ]; then
    fail "floating-point literal or float-producing call in simulation code:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no floating-point in simulation code"
  fi
fi

# --- INV-3: rendering decoupled from decision-making ------------------------
echo
echo "INV-3  rendering is decoupled from decision-making"
if [ -z "$(existing_core)" ]; then
  skip "no simulation packages yet"
else
  hits=$(grep_core '\b(document\.|window\.|getContext\(|requestAnimationFrame|HTMLCanvas)')
  if [ -n "$hits" ]; then
    fail "DOM or canvas API in simulation code:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no DOM or rendering APIs in simulation code"
  fi
fi

# --- INV-4: thinking budget metered, never set ------------------------------
echo
echo "INV-4  thinking budget is metered, never set"
if [ -d packages ]; then
  hits=$(grep -rnE --include='*.ts' \
          '"(reasoning|reasoning_effort|thinking|thinkingLevel|thinking_budget)"|\b(reasoning_effort|thinkingLevel|thinking_budget)\s*:' \
          packages 2>/dev/null | grep -vE '(reasoningTokens|reasoningSidecar|\.test\.ts|\.spec\.ts|//)')
  if [ -n "$hits" ]; then
    fail "reasoning-effort parameter present in request construction:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no reasoning-effort parameter sent"
  fi
else
  skip "no packages/ yet"
fi

# --- INV-7: identical scaffolds --------------------------------------------
echo
echo "INV-7  scaffolds are identical across deployments"
if [ -d packages ]; then
  hits=$(grep -rnE --include='*.ts' \
          '(promptOverride|systemPromptFor|scaffoldFor|perModelPrompt|modelSpecificPrompt)' \
          packages 2>/dev/null | grep -vE '\.test\.ts|\.spec\.ts')
  if [ -n "$hits" ]; then
    fail "per-deployment prompt override mechanism found:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no per-deployment prompt override mechanism"
  fi
else
  skip "no packages/ yet"
fi

# --- INV-8: zero recurring cost --------------------------------------------
echo
echo "INV-8  zero recurring cost"
banned='(pg|postgres|mysql2|mongodb|redis|ioredis|@supabase/supabase-js|ws|socket\.io|express|fastify|@aws-sdk)'
if [ -f package.json ]; then
  hits=$(grep -nE "\"$banned\"" package.json packages/*/package.json apps/*/package.json 2>/dev/null)
  if [ -n "$hits" ]; then
    fail "server, database, or realtime dependency present (architecture is precompute + static):"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no server, database, or realtime dependencies"
  fi
else
  skip "no package.json yet"
fi

# --- Contracts must not drift ----------------------------------------------
echo
echo "CONTRACTS  frozen interfaces intact"
for f in docs/contracts/command-log.schema.json docs/contracts/index.ts docs/INVARIANTS.md; do
  if [ -f "$f" ]; then pass "present: $f"; else fail "missing frozen contract: $f"; fi
done
if [ -f docs/contracts/command-log.schema.json ]; then
  if grep -q '"const": "1.0.0"' docs/contracts/command-log.schema.json; then
    pass "schemaVersion pinned to an exact const"
  else
    fail "schemaVersion is not pinned to an exact const — partial reads become possible"
  fi
fi

# --- Not yet mechanisable ---------------------------------------------------
cat <<'EOF'

UNMECHANISED — checked by test suite or human review, not by this script
  INV-2  the 100-replay zero-flake determinism test (belongs in the test suite)
  INV-5  metering probe classification correctness (requires live provider calls)
  INV-6  two endpoints of one model producing two leaderboard rows (needs results data)
  INV-8  free-tier allowlist validation of configured endpoints (needs provider config)
  Parse failures  exactly-one-call-per-decision-point (belongs in the test suite)
EOF

echo
if [ "$FAIL" -ne 0 ]; then
  red "INVARIANT AUDIT FAILED"
  exit 1
fi
green "invariant audit passed"
exit 0
