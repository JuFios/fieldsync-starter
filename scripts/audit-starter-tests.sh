#!/usr/bin/env bash
# Reproduces the audit of the starter tests that were rewritten: they stayed green although the
# behaviour their names claim was broken or could be broken.
#
# It compares two fixed versions, so it reports the same however the code changes later: the starter
# code (main) and 476961a, the merge of the change that rewrote those tests.
#
# F-01, F-02, F-03 and F-05: a hand-written edit of the source (a "sabotage") breaks the behaviour
# the starter test is named after; then it runs
#   - the starter test against the sabotaged starter code (vacuous: it still passes),
#   - the replacement test against the same sabotage (it must fail), and
#   - the replacement test against the intact code (it must pass: its failure comes from the
#     sabotage, not from a broken harness).
# F-04 needs no edit: the starter code itself breaks the behaviour its test names (F-08). F-06 is a
# count: the starter's todo tests never ran.
#
# A result counts only if tests ran. Jest also exits with success when a name filter matches no
# test, and with failure when a suite does not compile: neither says anything about the behaviour.
#
# Each version runs with its own workspace packages. Third-party packages come from the lockfile of
# 476961a, installed into a temporary directory (the starter has no lockfile; the packages its tests
# need are among these). Both versions are temporary git worktrees, removed on exit; this checkout's
# files, installed packages and build output are neither used nor changed.
#
# Needs: git history with both versions (not a shallow clone), Node.js 20, npm with access to the
# registry or a filled cache, and DATABASE_URL for the Postgres tests.
# Usage: DATABASE_URL=postgres://... scripts/audit-starter-tests.sh
#        (STARTER_REF and REPLACEMENT_REF override the two versions)
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

: "${DATABASE_URL:?DATABASE_URL must point at a Postgres maintenance database}"

has_commit() { git rev-parse --verify --quiet "$1^{commit}" >/dev/null; }

starter_ref=${STARTER_REF:-}
if [ -z "$starter_ref" ]; then
  for ref in main origin/main; do
    if has_commit "$ref"; then
      starter_ref=$ref
      break
    fi
  done
fi
if [ -z "$starter_ref" ] || ! has_commit "$starter_ref"; then
  echo "audit: the original code was not found (no main or origin/main); set STARTER_REF" >&2
  exit 1
fi
replacement_ref=${REPLACEMENT_REF:-476961a}
if ! has_commit "$replacement_ref"; then
  echo "audit: commit $replacement_ref was not found (a shallow clone?); set REPLACEMENT_REF" >&2
  exit 1
fi

work=$(mktemp -d)
starter="$work/starter"
replacement="$work/replacement"

cleanup() {
  git -C "$repo" worktree remove --force "$starter" >/dev/null 2>&1 || true
  git -C "$repo" worktree remove --force "$replacement" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

git worktree add --quiet --detach "$starter" "$starter_ref"
git worktree add --quiet --detach "$replacement" "$replacement_ref"

echo "Installing the dependencies of the two versions..." >&2
if ! (
  cd "$replacement" &&
    npm ci --ignore-scripts --no-audit --no-fund &&
    npm run build:core &&
    npm run build:test-kit
) >"$work/install.log" 2>&1; then
  tail -n 30 "$work/install.log" >&2
  exit 1
fi

# Gives a node_modules directory every entry of another one, except the workspace packages.
link_modules() {
  local from=$1 to=$2 entry
  mkdir -p "$to"
  for entry in "$from"/* "$from"/.[!.]*; do
    if [ -e "$entry" ] && [ "${entry##*/}" != "@fieldsync" ]; then ln -s "$entry" "$to/"; fi
  done
}

# The starter gets the same third-party packages and its own sync-core, which its server imports.
link_modules "$replacement/node_modules" "$starter/node_modules"
if [ -d "$replacement/apps/server/node_modules" ]; then
  link_modules "$replacement/apps/server/node_modules" "$starter/apps/server/node_modules"
fi
mkdir -p "$starter/node_modules/@fieldsync"
ln -s "$starter/packages/sync-core" "$starter/node_modules/@fieldsync/sync-core"
(cd "$starter/packages/sync-core" && npx --no-install tsc -p tsconfig.build.json)

# Replaces a fixed string in a file of a worktree; fails if it is not there exactly once.
sabotage() {
  local tree=$1 file=$2 from=$3 to=$4
  node -e '
    const fs = require("fs");
    const [file, from, to] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    if (text.split(from).length !== 2) { console.error(`sabotage: expected exactly one "${from}" in ${file}`); process.exit(2); }
    fs.writeFileSync(file, text.replace(from, to));
  ' "$tree/$file" "$from" "$to"
}

restore() {
  git -C "$1" checkout --quiet -- .
}

# Prints a JavaScript expression over `r`, the report of the last Jest run; NO-RUN without a report.
report() {
  node -e '
    let r;
    try { r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); }
    catch { console.log("NO-RUN"); process.exit(0); }
    console.log(eval(process.argv[2]));
  ' "$work/report.json" "$1"
}

# Runs Jest in a package directory of a worktree and prints what the tests did:
#   PASS    tests ran and none failed
#   FAIL    a test failed
#   NO-RUN  a suite did not run (a compile error, a missing module), or no test ran
run_jest() {
  local dir=$1 result
  shift
  rm -f "$work/report.json"
  (cd "$dir" && npx --no-install jest --ci --silent --forceExit --json --outputFile="$work/report.json" "$@" \
    >"$work/jest.log" 2>&1) || true
  result=$(report 'r.numRuntimeErrorTestSuites ? "NO-RUN" : r.numFailedTests ? "FAIL" : r.numPassedTests ? "PASS" : "NO-RUN"')
  if [ "$result" = "NO-RUN" ]; then
    echo "audit: no verdict from jest $* in ${dir#"$work/"}:" >&2
    tail -n 20 "$work/jest.log" >&2
  fi
  echo "$result"
}

# The known-defect tests of the last run that passed (each reproduced its defect); $1: id pattern.
known_defects() {
  report "r.testResults.flatMap((s) => s.assertionResults).filter((t) => t.status === 'passed' && /^\\[known defect $1 /.test(t.title)).length"
}

rows=()
# check ID DESCRIPTION STARTER_RESULT -- REPLACEMENT_DIR REPLACEMENT_JEST_ARGS...
# Runs the replacement under the sabotage, then restores both trees and runs it again as a control.
check() {
  local id=$1 description=$2 starter_result=$3
  shift 4
  local dir=$1
  shift
  local sabotaged intact verdict="vacuous starter test"
  sabotaged=$(run_jest "$dir" "$@")
  restore "$starter"
  restore "$replacement"
  intact=$(run_jest "$dir" "$@")
  if [ "$starter_result" != "PASS" ] || [ "$sabotaged" != "FAIL" ] || [ "$intact" != "PASS" ]; then verdict="UNEXPECTED"; fi
  rows+=("| $id | $description | $starter_result | $sabotaged | $intact | $verdict |")
}

echo "Running the checks..." >&2

# F-01: pull returns every site's changes, even on the initial pull.
file=apps/server/src/pull.service.ts
from='($2::uuid[] IS NULL OR site_id = ANY($2))'
sabotage "$starter" "$file" "$from" '($2::uuid[] IS NULL OR true)'
sabotage "$replacement" "$file" "$from" '($2::uuid[] IS NULL OR true)'
check F-01 "pull ignores the site filter" "$(run_jest "$starter/apps/server" test/pull.spec.ts)" -- \
  "$replacement/apps/server" --selectProjects integration --testPathPattern pull-access -t 'initial pull'

# F-02: a finished ticket may go back to in_progress.
file=packages/sync-core/src/mutators.ts
sabotage "$starter" "$file" "done: ['open']," "done: ['open', 'in_progress'],"
sabotage "$replacement" "$file" "done: ['open']," "done: ['open', 'in_progress'],"
check F-02 "invalid status transition is allowed" \
  "$(run_jest "$starter/packages/sync-core" test/mutators.spec.ts -t 'invalid status transition')" -- \
  "$replacement/packages/sync-core" test/mutators.spec.ts -t 'invalid status transition'

# F-03: every local mutation gets id 1.
file=packages/sync-core/src/client.ts
sabotage "$starter" "$file" 'id: this.lastMutationId + this.pending.length + 1,' 'id: 1,'
sabotage "$replacement" "$file" 'id: this.lastMutationId + this.pending.length + 1,' 'id: 1,'
check F-03 "all local mutations get id 1" \
  "$(run_jest "$starter/packages/sync-core" test/client.spec.ts -t 'numbers local mutations sequentially')" -- \
  "$replacement/packages/sync-core" test/client.spec.ts -t 'numbers local mutations sequentially'

# F-05: push answers that every mutation it applies is a duplicate.
file=apps/server/src/push.service.ts
sabotage "$starter" "$file" "results.push({ id: m.id, status: 'applied' });" "results.push({ id: m.id, status: 'duplicate' });"
sabotage "$replacement" "$file" "results.push({ id: m.id, status: 'applied' });" "results.push({ id: m.id, status: 'duplicate' });"
check F-05 "push reports applied mutations as duplicates" \
  "$(run_jest "$starter/apps/server" test/sync.integration.spec.ts)" -- \
  "$replacement/apps/server" --selectProjects integration --testPathPattern sync.characterization -t 'applies a created ticket'

# F-04: no sabotage. The starter lets a technician change another site's ticket by naming their own
# site (F-08), and its access test passes. The Postgres tests of the stored row reproduce that on
# the replacement version, whose access check is still the starter's.
access_starter=$(run_jest "$starter/apps/server" test/access.spec.ts)
access_stored=$(run_jest "$replacement/apps/server" --selectProjects integration --testPathPattern write-access)
access_known=$(known_defects 'F-08')

# F-06: the todo tests never run, so any implementation "passes" them.
todo_starter=$(run_jest "$starter/packages/sync-core" test/client.spec.ts)
todo=$(report 'r.numTodoTests')
todo_replacement=$(run_jest "$replacement/packages/sync-core" test/client.spec.ts -t 'reload|two tabs')
todo_known=$(known_defects 'F-1[01]')

echo
echo "| Finding | Sabotage | Starter test, sabotaged | Replacement, sabotaged | Replacement, intact | Verdict |"
echo "|---|---|---|---|---|---|"
printf '%s\n' "${rows[@]}"
echo
echo "F-04: no sabotage; the starter code lets a technician change another site's ticket (F-08). The starter access.spec: $access_starter; tests of the stored row that reproduce the defect: $access_known."
echo "F-06: the starter client.spec reports $todo todo tests (never executed); the replacement runs $todo_known known-defect tests that assert the behaviour."

failed=0
for row in "${rows[@]}"; do
  case "$row" in *UNEXPECTED*) failed=1 ;; esac
done
if [ "$access_starter $access_stored $access_known" != "PASS PASS 2" ]; then failed=1; fi
if [ "$todo_starter $todo $todo_replacement $todo_known" != "PASS 2 PASS 2" ]; then failed=1; fi
if [ "$failed" -ne 0 ]; then echo "audit: a result differs from the expected one (see above)" >&2; fi
exit "$failed"
