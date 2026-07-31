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
  # Every extension Node will actually execute, not just TypeScript: the
  # cross-process replay harness introduced plain-JS module-resolution hooks
  # under packages/core, and a wall-clock call or unseeded random in *those*
  # would be just as invariant-breaking while being invisible to a
  # TypeScript-only sweep. `.js`/`.jsx` matter as much as `.mjs`: every package
  # here is `"type": "module"`, so the same hook logic saved as `.js` loads
  # identically — listing only the extensions that happen to exist today would
  # leave the hole one rename wide.
  grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
    --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.turbo \
    "$pattern" "${dirs[@]}" 2>/dev/null
}

# Whether the runner Vitest would actually use still discovers the replay gate.
#
# Grepping vitest.config.ts for `include`/`exclude` was wrong in both
# directions: a single-line `test: { exclude: ['src/replay.test.ts'] },` evaded
# a line-anchored pattern (the gate silently deleted, audit green), while a
# benign `coverage: { exclude: [...] }` failed the entire audit. `vitest list`
# answers the real question — does the runner see these cases — with no pattern
# guessing at all. It only enumerates; it runs no test, and costs ~3s.
#
# When Vitest is not installed (a fresh clone with no `npm ci`) there is nothing
# to ask, so fall back to a text scan that keeps the false negative closed and
# skips `coverage` blocks to keep the false positive closed.
vitest_discovers_replay_gate() {
  local config="$1"
  local listed

  if [ -x node_modules/.bin/vitest ] || [ -f node_modules/vitest/package.json ]; then
    listed=$(npx vitest list --root packages/core 2>/dev/null)
    printf '%s' "$listed" | grep -q 'replay\.test\.ts' || return 1
    printf '%s' "$listed" | grep -q '100 consecutive in-process replays' || return 1
    printf '%s' "$listed" | grep -q '100 separate processes' || return 1
    return 0
  fi

  awk '
    /coverage[ \t]*:/ { in_cov = 1 }
    in_cov {
      depth += gsub(/\{/, "{") - gsub(/\}/, "}")
      if (depth <= 0) { in_cov = 0; depth = 0 }
      next
    }
    /(^|[^A-Za-z0-9_])(include|exclude)[ \t]*:/ { found = 1 }
    END { exit found ? 1 : 0 }
  ' "$config"
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

  # The 100-replay gate itself. The assertions live in the test suite (only a
  # test runner can actually replay a log), but a gate that can be deleted,
  # skipped, or quietly turned down to one iteration without CI noticing is
  # not a gate — so its existence and its iteration counts are checked here.
  replay_test="packages/core/src/replay.test.ts"
  replay_child="packages/core/src/testing/replay-child.ts"
  replay_fixture="packages/core/src/testing/fixtures/determinism.command-log.json"
  # The cross-process half cannot run without the resolution hooks: docs/contracts
  # is not linked into node_modules, so a spawned child dies on the bare
  # @tokenbrawl/contracts specifier before it imports anything.
  replay_hooks="packages/core/src/testing/contracts-hooks.mjs"
  replay_register="packages/core/src/testing/register-contracts.mjs"
  replay_missing=""
  for f in "$replay_test" "$replay_child" "$replay_fixture" "$replay_hooks" "$replay_register"; do
    [ -f "$f" ] || replay_missing="$replay_missing $f"
  done

  if [ -n "$replay_missing" ]; then
    fail "replay determinism gate is missing files:$replay_missing"
  else
    replay_broken=""
    # Not anchored with `$`: a trailing comment on the declaration is a benign
    # edit, and an audit that fails on benign edits gets worked around.
    grep -qE '^const IN_PROCESS_REPLAY_ITERATIONS = 100;' "$replay_test" \
      || replay_broken="$replay_broken in-process-iteration-count-is-not-100"
    grep -qE '^const CROSS_PROCESS_REPLAY_ITERATIONS = 100;' "$replay_test" \
      || replay_broken="$replay_broken cross-process-iteration-count-is-not-100"
    # Declaring the constants proves nothing if the loops ignore them: editing
    # `iteration < IN_PROCESS_REPLAY_ITERATIONS` to `iteration < 1` leaves both
    # declarations (and both test titles, which interpolate them) untouched and
    # drops the gate to a single replay. Require the loops to be bounded BY the
    # constants, which is the only thing that ties the two together.
    grep -qE 'iteration < IN_PROCESS_REPLAY_ITERATIONS;' "$replay_test" \
      || replay_broken="$replay_broken in-process-loop-is-not-bounded-by-the-constant"
    grep -qE 'iteration < CROSS_PROCESS_REPLAY_ITERATIONS;' "$replay_test" \
      || replay_broken="$replay_broken cross-process-loop-is-not-bounded-by-the-constant"
    # The cross-process half is what catches global-state leakage that an
    # in-process loop cannot see; a spawn-free "cross-process" test is a lie.
    # `spawnSync` alone is too weak — it survives deleting the 100-process
    # describe block entirely, because the single-child negative test still
    # uses it. Require the spawn to happen inside the counted loop.
    if ! grep -A 6 'iteration < CROSS_PROCESS_REPLAY_ITERATIONS;' "$replay_test" \
         | grep -q 'replayInChildProcess'; then
      replay_broken="$replay_broken cross-process-loop-does-not-spawn-a-child"
    fi
    if ! grep -q 'spawnSync(' "$replay_test"; then
      replay_broken="$replay_broken no-child-process-spawn"
    fi
    # A loop that runs 100 times and asserts nothing is not a gate either. The
    # checks above pin the loop's *shape*; these pin that its output is judged.
    grep -qE 'expect\(observed\.size\)\.toBe\(1\)' "$replay_test" \
      || replay_broken="$replay_broken in-process-loop-asserts-nothing"
    grep -qE 'expect\(\[\.\.\.observed\]\)\.toStrictEqual' "$replay_test" \
      || replay_broken="$replay_broken observed-hashes-are-never-compared"
    # Every way Vitest can neutralise a case, not just the suffix forms.
    # `.only` is the worst of them: it disables every *other* case in the file.
    # Three shapes, because matching only `.skip(` misses all of the others: a
    # modifier that is not the last segment (`it.skip.each([1])(...)`), the
    # options-object form (`it('x', { skip: true }, fn)`), and the runtime form
    # (`it('x', (ctx) => ctx.skip())`), which Vitest honours identically.
    grep -qE '\b(it|test|describe)(\.[a-z]+)*\.(skip|todo|skipIf|runIf|only|fails)\b' "$replay_test" \
      && replay_broken="$replay_broken contains-a-disabled-or-only-case"
    # `.*` between the call and the options object, not `[^)]*`: every describe
    # title in this file contains parentheses ("(I/O matrix, INV-2)"), so a
    # bracket-excluding class stops at the title and lets
    # `describe('… (INV-2)', { skip: true }, fn)` disable the whole block.
    grep -qE '\b(it|test|describe)\b.*\{[^}]*\b(skip|todo|only|fails)[[:space:]]*:[[:space:]]*true' "$replay_test" \
      && replay_broken="$replay_broken contains-a-case-disabled-via-its-options-object"
    # Any identifier, not the literal `ctx`: the test-context parameter is named
    # by whoever writes the case, so `(t) => t.skip()` is the same disable.
    grep -qE '\b[A-Za-z_$][A-Za-z0-9_$]*\.(skip|todo)[[:space:]]*\(' "$replay_test" \
      && replay_broken="$replay_broken contains-a-runtime-skip"
    # A gate no runner executes is not a gate, and the test file is not where
    # that gets decided. Three separate one-line, otherwise invisible deletions
    # of everything checked above: the workspace's own script, the *root*
    # script that fans out to it (which is what CI actually invokes), and
    # Vitest's config, which owns discovery.
    core_pkg="packages/core/package.json"
    core_vitest="packages/core/vitest.config.ts"
    root_pkg="package.json"
    ci_workflow=".github/workflows/ci.yml"
    # Closing quote included: unanchored, `"vitest run --exclude '**/replay.test.ts'"`
    # and `"vitest run src/command-log.test.ts"` both satisfy the check while
    # running everything except the gate.
    grep -qE '"test"[[:space:]]*:[[:space:]]*"vitest run"' "$core_pkg" \
      || replay_broken="$replay_broken core-package-test-script-does-not-run-vitest"
    # The workspace script is unreachable if the root script stops fanning out.
    # CI runs `npm test` at the root, never `npm test -w packages/core`, so
    # checking only the leaf leaves the actual entry point unguarded.
    grep -qE '"test"[[:space:]]*:[[:space:]]*"npm test --workspaces' "$root_pkg" \
      || replay_broken="$replay_broken root-test-script-does-not-fan-out-to-workspaces"
    if [ -f "$ci_workflow" ] && ! grep -qE '^[[:space:]]*run:[[:space:]]*npm test[[:space:]]*$' "$ci_workflow"; then
      replay_broken="$replay_broken ci-does-not-run-npm-test"
    fi
    if [ ! -f "$core_vitest" ]; then
      replay_broken="$replay_broken vitest-config-is-missing"
    elif ! vitest_discovers_replay_gate "$core_vitest"; then
      replay_broken="$replay_broken vitest-config-filters-test-discovery"
    fi

    if [ -n "$replay_broken" ]; then
      fail "replay determinism gate weakened:$replay_broken"
    else
      pass "100-replay determinism gate present (in-process + 100 spawned processes) with a committed golden fixture"
    fi
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

# --- AD-4: environment adapters run in Node and in a browser alike ----------
#
# The replay player re-runs the very same engine that CI ran, so a Node
# built-in anywhere in an env-* package's shipped graph breaks the web app at
# bundle time -- long after the story that introduced it was reviewed. Until
# Story 2.1 this was documented in a source comment and nothing else.
#
# Scope is `packages/env-*/src` only: a package's own `vitest.config.ts` is
# build tooling that never reaches a browser, and test files are exempt for
# the same reason (`source-discipline.test.ts` imports `node:fs` precisely so
# it can run this check a second time from inside the suite).
echo
echo "AD-4  environment adapters import no Node built-in"
ENV_SRC_DIRS=()
for d in packages/env-*/src; do [ -d "$d" ] && ENV_SRC_DIRS+=("$d"); done
if [ ${#ENV_SRC_DIRS[@]} -eq 0 ]; then
  skip "no environment adapter packages yet"
else
  builtins='assert|buffer|child_process|crypto|events|fs|fs/promises|http|http2|https|inspector|module|net|os|path|perf_hooks|process|readline|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib'
  hits=$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.cts' \
          --include='*.js' --include='*.jsx' --include='*.mjs' --include='*.cjs' \
          --exclude='*.test.ts' --exclude='*.spec.ts' --exclude='*.test.tsx' --exclude='*.spec.tsx' \
          --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.turbo \
          "(from|import|require\()[[:space:]]*\(?[[:space:]]*['\"](node:($builtins)|$builtins)['\"]" \
          "${ENV_SRC_DIRS[@]}" 2>/dev/null)
  if [ -n "$hits" ]; then
    fail "Node built-in imported by a shipped environment-adapter file (AD-4: must run unmodified in a browser):"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no Node built-in imported by a shipped environment-adapter file"
  fi
fi

# --- INV-4: thinking budget metered, never set ------------------------------
echo
echo "INV-4  thinking budget is metered, never set"
if [ -d packages ]; then
  hits=$(grep -rnE --include='*.ts' \
          --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.turbo \
          '"(reasoning|reasoning_effort|thinking|thinkingLevel|thinking_budget)"|\b(reasoning_effort|thinkingLevel|thinking_budget)\s*:' \
          packages 2>/dev/null | grep -vE '(reasoningTokens|reasoningSidecar|\.test\.ts|\.spec\.ts|//)')
  if [ -n "$hits" ]; then
    fail "reasoning-effort parameter present in request construction:"
    echo "$hits" | sed 's/^/          /'
  else
    pass "no reasoning-effort parameter sent"
  fi

  # The positive half: a Token Bank must actually exist and be wired in, not
  # merely absent-of-banned-keys. Story 1.5 landed this; an invariant that
  # only forbids is half a gate.
  token_bank_file="packages/core/src/token-bank.ts"
  match_runner_file="packages/core/src/match-runner.ts"
  if [ ! -f "$token_bank_file" ]; then
    fail "no Token Bank module at $token_bank_file"
  elif ! grep -qE '\bREFLEX_MAX_TOKENS\b *= *8\b' "$token_bank_file"; then
    fail "REFLEX_MAX_TOKENS is not pinned to 8 in $token_bank_file"
  elif [ ! -f "$match_runner_file" ]; then
    # A missing file must fail loud: without this branch, the grep below
    # exits non-zero on ENOENT (stderr swallowed by 2>/dev/null) exactly the
    # same way it does on "no match found", so a deleted/renamed
    # match-runner.ts would silently report pass instead of fail.
    fail "no match-runner at $match_runner_file"
  elif grep -qE '\bUNMETERED_BUDGET\b' "$match_runner_file" 2>/dev/null; then
    fail "$match_runner_file still contains UNMETERED_BUDGET -- Token Bank metering is not wired in"
  else
    pass "Token Bank module present, REFLEX_MAX_TOKENS is 8, and UNMETERED_BUDGET is gone from match-runner.ts"
  fi
else
  skip "no packages/ yet"
fi

# --- INV-7: identical scaffolds --------------------------------------------
echo
echo "INV-7  scaffolds are identical across deployments"
if [ -d packages ]; then
  hits=$(grep -rnE --include='*.ts' \
          --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=coverage --exclude-dir=.turbo \
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
