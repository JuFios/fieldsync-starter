#!/usr/bin/env bash
# Smoke test of the simulation command (npm run sim) without a database: help, version, an invalid
# option and a missing DATABASE_URL must each produce the documented output and exit code. CI runs
# it on Linux, macOS and Windows (Git Bash); the simulation itself needs Postgres and runs on Linux.
set -uo pipefail
cd "$(dirname "$0")/.."

failures=0
out="$(mktemp)"
err="$(mktemp)"
trap 'rm -f "$out" "$err"' EXIT

# expect <exit code> <stream> <pattern> -- <sim arguments...>
expect() {
  local code="$1" stream="$2" pattern="$3"
  shift 4
  env -u DATABASE_URL node apps/server/dist-sim/test/simulation/cli.js "$@" >"$out" 2>"$err"
  local actual=$?
  local text
  text="$(cat "$([ "$stream" = stdout ] && echo "$out" || echo "$err")")"
  if [ "$actual" -ne "$code" ] || ! grep -Eq -- "$pattern" <<<"$text"; then
    echo "FAIL: sim $* -> exit $actual (expected $code), $stream did not match /$pattern/"
    echo "--- stdout"; cat "$out"; echo "--- stderr"; cat "$err"
    failures=$((failures + 1))
  else
    echo "ok: sim $* -> exit $actual"
  fi
}

npm run build:core >/dev/null && npm run build:sim >/dev/null && npx tsc -p apps/server/tsconfig.sim.json || exit 1

version="$(node -p "require('./apps/server/package.json').version")"
expect 0 stdout '^Usage: sim \[options\]' -- --help
expect 0 stdout "^${version//./\\.}\$" -- --version
expect 2 stderr "argument 'x' is invalid" -- --runs x
expect 2 stderr "unknown option '--nope'" -- --nope
expect 2 stderr 'DATABASE_URL is not set' -- --profile baseline --runs 1

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
