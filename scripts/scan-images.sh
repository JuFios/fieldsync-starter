#!/usr/bin/env bash
# Scans Docker images for known vulnerabilities with Trivy and prints a report. Report mode: the
# exit code does not depend on the findings (the runtime versions are kept on purpose, see
# "Limitations" in the README), only on whether the scan itself worked.
#
# Trivy runs from its official image, pinned by digest (no third-party CI action: in March 2026
# the trivy-action tags were rewritten to point at credential-stealing code, GHSA-69fq-xp46-6x23).
# Only the findings are listed (`--table-mode detailed`): the summary table would add a row for
# every package of the image, most of them without findings. Each image is handed over as a
# `docker save` archive, mounted read-only, so the scanner gets no access to the Docker daemon.
#
# Usage: scripts/scan-images.sh IMAGE...   (env: TRIVY_SEVERITY, default HIGH,CRITICAL)
set -euo pipefail

# aquasec/trivy:0.76.2 (2026-11-05, immutable release); the same digest on Docker Hub and ghcr.io.
TRIVY_IMAGE='aquasec/trivy@sha256:8f6bb947dbc528902e11f2f5be52f7b519f6a39d5d148f41166f2040499768fb'
SEVERITY="${TRIVY_SEVERITY:-HIGH,CRITICAL}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 IMAGE..." >&2
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/cache"

for image in "$@"; do
  archive="$work/image.tar"
  docker save --output "$archive" "$image"
  echo "== $image ($SEVERITY)"
  # As the calling user, so the cache it writes can be removed afterwards (as root it could not).
  docker run --rm --user "$(id -u):$(id -g)" \
    -v "$archive:/scan/image.tar:ro" \
    -v "$work/cache:/cache" \
    "$TRIVY_IMAGE" image --cache-dir /cache --input /scan/image.tar --scanners vuln --severity "$SEVERITY" \
    --format table --table-mode detailed --exit-code 0 --no-progress
  rm -f "$archive"
done
