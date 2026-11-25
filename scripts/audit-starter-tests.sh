#!/usr/bin/env bash
# Shows that the starter tests rewritten in this branch did not test what their names claim.
#
# For each finding it breaks the behaviour the starter test is named after (a "sabotage" edit to
# the source), then runs
#   - the starter test, from the `main` branch, against the sabotaged starter code,
#   - the replacement test, from the current commit, against the same sabotage, and
#   - the replacement test against the intact code (a control: its failure must come from the
#     sabotage, not from a broken harness).
# A vacuous starter test still passes; its replacement fails, and passes on intact code. Nothing is changed in this checkout:
# both runs use temporary git worktrees that are removed on exit.
#
# Needs: installed dependencies (npm ci), built packages (npm run build:core && npm run
# build:test-kit) and DATABASE_URL for the findings whose replacements are Postgres tests.
# Usage: DATABASE_URL=postgres://... scripts/audit-starter-tests.sh
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"

: "${DATABASE_URL:?DATABASE_URL must point at a Postgres maintenance database}"
work=$(mktemp -d)
starter="$work/starter"
current="$work/current"

cleanup() {
  git -C "$repo" worktree remove --force "$starter" >/dev/null 2>&1 || true
  git -C "$repo" worktree remove --force "$current" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

checkout() {
  git -C "$repo" worktree add --quiet --detach "$1" "$2"
  ln -s "$repo/node_modules" "$1/node_modules"
  if [ -d "$repo/apps/server/node_modules" ]; then ln -s "$repo/apps/server/node_modules" "$1/apps/server/node_modules"; fi
}
checkout "$starter" main
checkout "$current" HEAD

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

# Runs Jest in a package directory of a worktree; prints PASS or FAIL.
run_jest() {
  local dir=$1
  shift
  if (cd "$dir" && npx jest --ci --silent --forceExit "$@" >/dev/null 2>&1); then echo PASS; else echo FAIL; fi
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
  restore "$current"
  intact=$(run_jest "$dir" "$@")
  if [ "$starter_result" != "PASS" ] || [ "$sabotaged" != "FAIL" ] || [ "$intact" != "PASS" ]; then verdict="UNEXPECTED"; fi
  rows+=("| $id | $description | $starter_result | $sabotaged | $intact | $verdict |")
}

echo "Running sabotaged checks (this takes a minute)..." >&2

# F-01: pull returns every site's changes, even on the initial pull.
file=apps/server/src/pull.service.ts
from='($2::uuid[] IS NULL OR site_id = ANY($2))'
sabotage "$starter" "$file" "$from" '($2::uuid[] IS NULL OR true)'
sabotage "$current" "$file" "$from" '($2::uuid[] IS NULL OR true)'
check F-01 "pull ignores the site filter" "$(run_jest "$starter/apps/server" test/pull.spec.ts)" -- \
  "$current/apps/server" --selectProjects integration --testPathPattern pull-access -t 'initial pull'

# F-02: a finished ticket may go back to in_progress.
file=packages/sync-core/src/mutators.ts
sabotage "$starter" "$file" "done: ['open']," "done: ['open', 'in_progress'],"
sabotage "$current" "$file" "done: ['open']," "done: ['open', 'in_progress'],"
check F-02 "invalid status transition is allowed" \
  "$(run_jest "$starter/packages/sync-core" test/mutators.spec.ts -t 'invalid status transition')" -- \
  "$current/packages/sync-core" test/mutators.spec.ts -t 'invalid status transition'

# F-03: every local mutation gets id 1.
file=packages/sync-core/src/client.ts
sabotage "$starter" "$file" 'id: this.lastMutationId + this.pending.length + 1,' 'id: 1,'
sabotage "$current" "$file" 'id: this.lastMutationId + this.pending.length + 1,' 'id: 1,'
check F-03 "all local mutations get id 1" \
  "$(run_jest "$starter/packages/sync-core" test/client.spec.ts -t 'numbers local mutations sequentially')" -- \
  "$current/packages/sync-core" test/client.spec.ts -t 'numbers local mutations sequentially'

# F-04: admins lose access to every site they are not explicitly assigned to.
file=apps/server/src/access.ts
sabotage "$starter" "$file" "if (user.role === 'admin') {" 'if (false) {'
sabotage "$current" "$file" "if (user.role === 'admin') {" 'if (false) {'
check F-04 "admins get no implicit access" "$(run_jest "$starter/apps/server" test/access.spec.ts)" -- \
  "$current/apps/server" --selectProjects unit --testPathPattern 'test/access.spec.ts'

# F-05: push acknowledges every mutation as a duplicate and applies nothing.
file=apps/server/src/push.service.ts
sabotage "$starter" "$file" "results.push({ id: m.id, status: 'applied' });" "results.push({ id: m.id, status: 'duplicate' });"
sabotage "$current" "$file" "results.push({ id: m.id, status: 'applied' });" "results.push({ id: m.id, status: 'duplicate' });"
check F-05 "push reports applied mutations as duplicates" \
  "$(run_jest "$starter/apps/server" test/sync.integration.spec.ts)" -- \
  "$current/apps/server" --selectProjects integration --testPathPattern sync.characterization -t 'applies a created ticket'

# F-06: the todo tests never run, so any implementation "passes" them.
todo=$(cd "$starter/packages/sync-core" && npx jest --ci test/client.spec.ts 2>&1 | grep -oE '[0-9]+ todo' | tail -1 || true)
known=$(cd "$current/packages/sync-core" && npx jest --ci test/client.spec.ts -t 'reload|two tabs' 2>&1 | grep -c 'known defect F-1[01]' || true)

echo
echo "| Finding | Sabotage | Starter test, sabotaged | Replacement, sabotaged | Replacement, intact | Verdict |"
echo "|---|---|---|---|---|---|"
printf '%s\n' "${rows[@]}"
echo
echo "F-06: the starter client.spec reports ${todo:-no todo} tests (never executed); the replacement runs ${known} known-defect tests that assert the behaviour."

for row in "${rows[@]}"; do
  case "$row" in *UNEXPECTED*) exit 1 ;; esac
done
